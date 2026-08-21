import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { upload } from "../middleware/upload.js";
import { detectFaces, pickLargestFace } from "../lib/faceEngine.js";
import { searchSimilarPhotos } from "../lib/faces.js";
import { averageAndNormalize, insertGuestSearch, similarityForPhoto } from "../lib/guestSearches.js";
import { getEffectiveThreshold, adjustThresholdOnFeedback } from "../lib/threshold.js";
import { zipFilenameForEvent, streamPhotosZip, buildPhotosZipToDisk, zipDownloadPath } from "../lib/zip.js";
import { sendZipReadyEmail } from "../lib/mailer.js";
import { ALLOWED_EXTENSIONS } from "../lib/storage.js";
import { contentMatchesExtension } from "../lib/fileValidation.js";
import { guestSearchLimiter, guestDownloadLimiter, guestFeedbackLimiter } from "../lib/rateLimiters.js";

const router = Router();

const PUBLIC_SERVER_URL = process.env.PUBLIC_SERVER_URL || "http://localhost:4000";

router.get("/:slug", async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({
      where: { guestSlug: req.params.slug },
      include: { owner: true },
    });
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    res.json({
      id: event.id,
      name: event.name,
      studio_name: event.owner?.studioName ?? null,
      logo_url: event.owner?.logoPath ? `/files/branding/${event.owner.id}/logo` : null,
      brand_color: event.owner?.brandColor ?? null,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/:slug/search", guestSearchLimiter, upload.array("selfies", 3), async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { guestSlug: req.params.slug } });
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({ error: "No selfies uploaded (expected multipart field 'selfies')" });
    }

    let facesDetected = 0;
    const embeddings = [];

    for (const file of files) {
      const ext = path.extname(file.originalname).toLowerCase();
      // Skip just this one selfie if it's not a real image (extension +
      // content-sniffed magic bytes) — 1-3 are submitted, one bad file
      // shouldn't torpedo the others.
      if (!ALLOWED_EXTENSIONS.has(ext) || !contentMatchesExtension(file.buffer, ext)) {
        continue;
      }

      let detection;
      try {
        detection = await detectFaces(file.buffer, file.originalname);
      } catch (err) {
        return next(err);
      }

      const faces = detection.faces || [];
      facesDetected += faces.length;

      if (faces.length > 0) {
        const queryFace = pickLargestFace(faces);
        embeddings.push(queryFace.embedding);
      }
    }

    if (embeddings.length === 0) {
      return res.status(422).json({ error: "No face detected in the uploaded photo. Try a clearer, front-facing photo." });
    }

    const queryEmbedding = averageAndNormalize(embeddings);
    const threshold = getEffectiveThreshold(event);

    const rows = await searchSimilarPhotos({
      eventId: event.id,
      embedding: queryEmbedding,
      threshold,
    });

    const guestClientId = req.body?.guest_client_id || null;

    let matches = [];
    if (rows.length > 0) {
      const photos = await prisma.photo.findMany({
        where: { id: { in: rows.map((r) => r.photoId) } },
      });
      const photoById = new Map(photos.map((p) => [p.id, p]));

      matches = rows
        .map((r) => {
          const photo = photoById.get(r.photoId);
          if (!photo) return null;
          return {
            photo_id: photo.id,
            filename: photo.filename,
            similarity: Math.round(Number(r.similarity) * 10000) / 10000,
            url: `/files/events/${event.id}/photos/${photo.id}`,
            thumbnail_url: `/files/events/${event.id}/photos/${photo.id}/thumb`,
          };
        })
        .filter(Boolean)
        .sort((a, b) => b.similarity - a.similarity);
    }

    const searchId = await insertGuestSearch({
      eventId: event.id,
      embedding: queryEmbedding,
      facesDetected,
      matchCount: matches.length,
      guestClientId,
    });

    res.json({
      search_id: searchId,
      faces_detected_in_selfie: facesDetected,
      matches,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/:slug/feedback", guestFeedbackLimiter, async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { guestSlug: req.params.slug } });
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    const { search_id, photo_id } = req.body || {};
    if (!search_id || !photo_id) {
      return res.status(400).json({ error: "search_id and photo_id are required" });
    }

    const search = await prisma.guestSearch.findUnique({ where: { id: search_id } });
    if (!search || search.eventId !== event.id) {
      return res.status(404).json({ error: "Search not found" });
    }

    const newThreshold = await adjustThresholdOnFeedback(prisma, event);

    let similarity = await similarityForPhoto({ searchId: search.id, photoId: photo_id });
    if (similarity === null) similarity = 0;

    await prisma.matchFeedback.create({
      data: {
        id: randomUUID(),
        searchId: search.id,
        photoId: photo_id,
        similarity,
      },
    });

    res.json({ ok: true, new_threshold: newThreshold });
  } catch (err) {
    next(err);
  }
});

router.post("/:slug/download", guestDownloadLimiter, async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { guestSlug: req.params.slug } });
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    const photoIds = req.body?.photo_ids;
    if (!Array.isArray(photoIds) || photoIds.length === 0) {
      return res.status(400).json({ error: "photo_ids (non-empty array) is required" });
    }

    // Only zip photos that actually belong to this event — a guest can only
    // ever have gotten a photo_id from this event's own search results, but
    // we don't trust the client-supplied list further than that.
    const photos = await prisma.photo.findMany({
      where: { id: { in: photoIds }, eventId: event.id },
    });
    if (photos.length === 0) {
      return res.status(404).json({ error: "None of the requested photos belong to this event" });
    }

    const zipFilename = zipFilenameForEvent(event);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipFilename}"`);

    await streamPhotosZip(photos, res);
  } catch (err) {
    next(err);
  }
});

router.post("/:slug/download/email", guestDownloadLimiter, async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { guestSlug: req.params.slug } });
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    const { photo_ids: photoIds, email } = req.body || {};
    if (!Array.isArray(photoIds) || photoIds.length === 0) {
      return res.status(400).json({ error: "photo_ids (non-empty array) is required" });
    }
    // Loose format check — mainly to reject garbage/injection attempts at
    // the boundary before it ever reaches nodemailer, not full RFC validation.
    if (!email || typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "A valid email address is required" });
    }

    const zipDownload = await prisma.zipDownload.create({
      data: {
        id: randomUUID(),
        eventId: event.id,
        photoIds,
        email,
        status: "pending",
      },
    });

    res.json({ ok: true });

    // Fire and forget — build the zip asynchronously and email the link
    // once ready, same "don't block the request" pattern as the upload
    // job queue (lib/jobQueue.js).
    (async () => {
      try {
        const photos = await prisma.photo.findMany({
          where: { id: { in: photoIds }, eventId: event.id },
        });
        if (photos.length === 0) {
          throw new Error("None of the requested photos belong to this event");
        }

        const filePath = await buildPhotosZipToDisk(photos, zipDownload.id);

        await prisma.zipDownload.update({
          where: { id: zipDownload.id },
          data: { status: "ready", filePath, readyAt: new Date() },
        });

        const downloadUrl = `${PUBLIC_SERVER_URL}/e/${event.guestSlug}/downloads/${zipDownload.id}`;
        await sendZipReadyEmail(email, downloadUrl);
      } catch (err) {
        console.error(`Failed to build/email zip for ZipDownload ${zipDownload.id}:`, err);
        await prisma.zipDownload
          .update({
            where: { id: zipDownload.id },
            data: { status: "failed", errorMessage: err.message || "Unknown error" },
          })
          .catch((updateErr) => console.error("Failed to record ZipDownload failure:", updateErr));
      }
    })();
  } catch (err) {
    next(err);
  }
});

router.get("/:slug/downloads/:downloadId", async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { guestSlug: req.params.slug } });
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    const zipDownload = await prisma.zipDownload.findUnique({ where: { id: req.params.downloadId } });
    if (!zipDownload || zipDownload.eventId !== event.id) {
      return res.status(404).json({ error: "Download not found" });
    }

    if (zipDownload.status !== "ready") {
      return res.status(409).json({ error: "Your download isn't ready yet — check back in a moment." });
    }

    const filePath = zipDownload.filePath || zipDownloadPath(zipDownload.id);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Zip file missing on disk" });
    }

    const zipFilename = zipFilenameForEvent(event);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipFilename}"`);
    res.sendFile(filePath);
  } catch (err) {
    next(err);
  }
});

export default router;
