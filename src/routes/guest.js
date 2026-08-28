import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { upload } from "../middleware/upload.js";
import { detectFaces, pickLargestFace } from "../lib/faceEngine.js";
import { insertFace, searchSimilarPhotos } from "../lib/faces.js";
import { averageAndNormalize, insertGuestSearch, similarityForPhoto } from "../lib/guestSearches.js";
import { getEffectiveThreshold, adjustThresholdOnFeedback } from "../lib/threshold.js";
import { zipFilenameForEvent, streamPhotosZip, buildPhotosZipToDisk, zipDownloadPath } from "../lib/zip.js";
import { sendZipReadyEmail } from "../lib/mailer.js";
import { ALLOWED_EXTENSIONS, saveEventPhoto } from "../lib/storage.js";
import { generateThumbnail } from "../lib/thumbnails.js";
import { contentMatchesExtension } from "../lib/fileValidation.js";
import {
  guestSearchLimiter,
  guestDownloadLimiter,
  guestFeedbackLimiter,
  guestAlertLimiter,
  guestWhatsAppLinkLimiter,
  guestUploadLimiter,
  guestLikeLimiter,
  guestCommentLimiter,
} from "../lib/rateLimiters.js";
import { isExpired } from "../lib/expiry.js";
import { subscribeGuestAlert, unsubscribeGuestAlert, isValidEmail } from "../lib/guestAlerts.js";
import { sendWhatsAppMessage, isValidE164 } from "../lib/whatsapp.js";
import { eventStorageUsedBytes, effectiveStorageLimitBytes, effectivePhotoRetentionDays } from "../lib/planLimits.js";
import { publishLiveEvent, subscribeLiveEvents } from "../lib/liveEvents.js";

const router = Router();

const PUBLIC_SERVER_URL = process.env.PUBLIC_SERVER_URL || "http://localhost:4000";

/** Returns { likeCounts: Map<photoId, count>, likedByMe: Set<photoId> } for
 * a set of photo ids — likedByMe is empty if guestClientId is falsy. */
async function getLikeInfo(photoIds, guestClientId) {
  if (photoIds.length === 0) return { likeCounts: new Map(), likedByMe: new Set() };

  const grouped = await prisma.photoLike.groupBy({
    by: ["photoId"],
    where: { photoId: { in: photoIds } },
    _count: true,
  });
  const likeCounts = new Map(grouped.map((g) => [g.photoId, g._count]));

  let likedByMe = new Set();
  if (guestClientId) {
    const mine = await prisma.photoLike.findMany({
      where: { photoId: { in: photoIds }, guestClientId },
      select: { photoId: true },
    });
    likedByMe = new Set(mine.map((m) => m.photoId));
  }

  return { likeCounts, likedByMe };
}

function photoResponseShape(event, photo) {
  return {
    photo_id: photo.id,
    filename: photo.filename,
    createdAt: photo.createdAt,
    url: `/files/events/${event.id}/photos/${photo.id}`,
    thumbnail_url: `/files/events/${event.id}/photos/${photo.id}/thumb`,
  };
}

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
      expired: isExpired(event),
      guest_upload_enabled: event.guestUploadEnabled,
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
    if (isExpired(event)) {
      return res.status(410).json({ error: "This event's guest access has closed." });
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
        // Pending guest uploads are never searchable — they only become
        // visible/matchable once the owner approves them.
        where: { id: { in: rows.map((r) => r.photoId) }, approvalStatus: "approved" },
      });
      const photoById = new Map(photos.map((p) => [p.id, p]));

      const { likeCounts, likedByMe } = await getLikeInfo(
        photos.map((p) => p.id),
        guestClientId
      );

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
            like_count: likeCounts.get(photo.id) || 0,
            liked_by_me: likedByMe.has(photo.id),
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

// Guest-contributed photos — opt-in per event (Event.guestUploadEnabled),
// reachable via a distinct upload link/QR from the studio, separate from the
// search link. Runs the same face-detect/thumbnail/storage-cap pipeline as
// an owner upload, but every photo lands as approvalStatus: "pending" and
// is invisible to search/live-gallery until the owner approves it — this
// is a public, unauthenticated write endpoint, so nothing it creates is
// trusted until a human on the studio side has looked at it. Runs
// synchronously (no job/SSE plumbing) since guest batches are small — file
// count is capped below to bound request duration.
router.post("/:slug/upload", guestUploadLimiter, upload.array("files", 10), async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { guestSlug: req.params.slug } });
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    if (isExpired(event)) {
      return res.status(410).json({ error: "This event's guest access has closed." });
    }
    if (!event.guestUploadEnabled) {
      return res.status(403).json({ error: "Guest uploads aren't turned on for this event." });
    }

    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({ error: "No files uploaded (expected multipart field 'files')" });
    }

    const guestClientId = req.body?.guest_client_id || null;
    const owner = await prisma.user.findUnique({ where: { id: event.ownerId } });
    let usedBytes = await eventStorageUsedBytes(prisma, event.id);
    const storageLimitBytes = effectiveStorageLimitBytes(owner);

    const skipped = [];
    let uploaded = 0;

    for (const file of files) {
      const ext = path.extname(file.originalname).toLowerCase();

      if (!ALLOWED_EXTENSIONS.has(ext)) {
        skipped.push(`${file.originalname} (unsupported file type)`);
        continue;
      }
      if (!contentMatchesExtension(file.buffer, ext)) {
        skipped.push(`${file.originalname} (file content doesn't match its extension)`);
        continue;
      }
      if (usedBytes + file.buffer.length > storageLimitBytes) {
        skipped.push(`${file.originalname} (event storage limit reached)`);
        continue;
      }

      let detection;
      try {
        detection = await detectFaces(file.buffer, file.originalname);
      } catch (err) {
        skipped.push(`${file.originalname} (${err.isFaceEngineError ? err.message : "could not process image"})`);
        continue;
      }

      const photoId = randomUUID();
      const storedFilename = `${photoId}${ext}`;
      const storagePath = await saveEventPhoto(event.id, storedFilename, file.buffer);
      const thumbnailPath = await generateThumbnail(file.buffer, event.id, photoId);
      const faces = detection.faces || [];

      const photo = await prisma.photo.create({
        data: {
          id: photoId,
          eventId: event.id,
          filename: file.originalname,
          storagePath,
          thumbnailPath,
          faceCount: faces.length,
          fileSize: file.buffer.length,
          source: "guest",
          approvalStatus: "pending",
          uploadedByGuestClientId: guestClientId,
          originalExpiresAt: new Date(Date.now() + effectivePhotoRetentionDays(owner) * 24 * 60 * 60 * 1000),
        },
      });

      for (const face of faces) {
        await insertFace({
          photoId: photo.id,
          eventId: event.id,
          bbox: face.bbox,
          embedding: face.embedding,
          detScore: face.det_score,
        });
      }

      usedBytes += file.buffer.length;
      uploaded += 1;
      // Deliberately no publishLiveEvent/checkAndNotifyForNewPhotos here —
      // this photo doesn't exist yet as far as search or the live gallery
      // are concerned until an owner approves it (see events.js's approve
      // route).
    }

    res.json({ ok: true, uploaded, skipped });
  } catch (err) {
    next(err);
  }
});

// Public, read-only gallery of this event's approved photos — powers the
// live slideshow/carousel view (thumbnails only, same as everywhere else
// guest-facing). Most recent first, capped so a very long-running event
// doesn't hand back an unbounded response.
router.get("/:slug/gallery", async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { guestSlug: req.params.slug } });
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    if (isExpired(event)) {
      return res.status(410).json({ error: "This event's guest access has closed." });
    }

    const photos = await prisma.photo.findMany({
      where: { eventId: event.id, approvalStatus: "approved" },
      orderBy: { createdAt: "desc" },
      take: 300,
    });

    res.json({ photos: photos.map((p) => photoResponseShape(event, p)) });
  } catch (err) {
    next(err);
  }
});

// Public SSE feed of "a new photo just landed" for this event — same
// underlying bus as the owner-side stream (events.js's /:id/live/stream),
// just scoped by guestSlug instead of requiring auth, so the slideshow
// view can update itself without polling. A guest upload only reaches this
// once approved (see events.js's approve route), never at upload time.
router.get("/:slug/live/stream", async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { guestSlug: req.params.slug } });
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const onEvent = (payload) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);
    const unsubscribe = subscribeLiveEvents(event.id, onEvent);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  } catch (err) {
    next(err);
  }
});

// Toggles a guest's like on a photo — one row per (photo, guest), so
// calling this twice with the same guest_client_id likes then unlikes.
// Public like counts are an explicit product decision (not a private
// per-guest favorites list) — see the Photo model's comment.
router.post("/:slug/photos/:photoId/like", guestLikeLimiter, async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { guestSlug: req.params.slug } });
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    if (isExpired(event)) {
      return res.status(410).json({ error: "This event's guest access has closed." });
    }

    const { guest_client_id: guestClientId } = req.body || {};
    if (!guestClientId) {
      return res.status(400).json({ error: "guest_client_id is required" });
    }

    const photo = await prisma.photo.findFirst({
      where: { id: req.params.photoId, eventId: event.id, approvalStatus: "approved" },
    });
    if (!photo) {
      return res.status(404).json({ error: "Photo not found" });
    }

    const existing = await prisma.photoLike.findUnique({
      where: { photoId_guestClientId: { photoId: photo.id, guestClientId } },
    });

    let liked;
    if (existing) {
      await prisma.photoLike.delete({ where: { id: existing.id } });
      liked = false;
    } else {
      await prisma.photoLike.create({
        data: { id: randomUUID(), photoId: photo.id, eventId: event.id, guestClientId },
      });
      liked = true;
    }

    const likeCount = await prisma.photoLike.count({ where: { photoId: photo.id } });
    res.json({ liked, like_count: likeCount });
  } catch (err) {
    next(err);
  }
});

// Public comment thread on a photo — visible to every guest browsing the
// event (an explicit product decision), moderated by the owner deleting
// individual comments (see events.js).
router.get("/:slug/photos/:photoId/comments", async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { guestSlug: req.params.slug } });
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    const photo = await prisma.photo.findFirst({
      where: { id: req.params.photoId, eventId: event.id, approvalStatus: "approved" },
    });
    if (!photo) {
      return res.status(404).json({ error: "Photo not found" });
    }

    const comments = await prisma.photoComment.findMany({
      where: { photoId: photo.id },
      orderBy: { createdAt: "asc" },
    });

    res.json({
      comments: comments.map((c) => ({
        id: c.id,
        guest_name: c.guestName || "Guest",
        text: c.text,
        created_at: c.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/:slug/photos/:photoId/comments", guestCommentLimiter, async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { guestSlug: req.params.slug } });
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    if (isExpired(event)) {
      return res.status(410).json({ error: "This event's guest access has closed." });
    }

    const { guest_client_id: guestClientId, guest_name: guestName, text } = req.body || {};
    if (!guestClientId) {
      return res.status(400).json({ error: "guest_client_id is required" });
    }
    if (!text || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "A comment can't be empty" });
    }
    if (text.length > 500) {
      return res.status(400).json({ error: "Comments are limited to 500 characters" });
    }

    const photo = await prisma.photo.findFirst({
      where: { id: req.params.photoId, eventId: event.id, approvalStatus: "approved" },
    });
    if (!photo) {
      return res.status(404).json({ error: "Photo not found" });
    }

    const comment = await prisma.photoComment.create({
      data: {
        id: randomUUID(),
        photoId: photo.id,
        eventId: event.id,
        guestClientId,
        guestName: guestName && typeof guestName === "string" ? guestName.slice(0, 60) : null,
        text: text.trim(),
      },
    });

    res.status(201).json({
      id: comment.id,
      guest_name: comment.guestName || "Guest",
      text: comment.text,
      created_at: comment.createdAt,
    });
  } catch (err) {
    next(err);
  }
});

// Opts a guest in to being notified (email or WhatsApp) if more photos of
// them show up later in this event — the natural follow-up to a search once
// photos can keep arriving live via Shoots. `guest_client_id` is the same
// anonymous id already used for search/feedback (src/guestId.js on the
// frontend) — like the rest of this API's guest identity model, it's an
// unguessable id acting as its own bearer token, not paired with any login.
router.post("/:slug/alerts/subscribe", guestAlertLimiter, async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { guestSlug: req.params.slug } });
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    if (isExpired(event)) {
      return res.status(410).json({ error: "This event's guest access has closed." });
    }

    const { guest_client_id: guestClientId, channel, contact } = req.body || {};
    if (!guestClientId) {
      return res.status(400).json({ error: "guest_client_id is required" });
    }
    if (channel !== "email" && channel !== "whatsapp") {
      return res.status(400).json({ error: "channel must be 'email' or 'whatsapp'" });
    }
    if (channel === "email" && !isValidEmail(contact)) {
      return res.status(400).json({ error: "A valid email address is required" });
    }
    if (channel === "whatsapp" && !isValidE164(contact)) {
      return res.status(400).json({ error: "A valid phone number in international format (e.g. +919876543210) is required" });
    }

    await subscribeGuestAlert({ eventId: event.id, guestClientId, channel, contact });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/:slug/alerts/unsubscribe", guestAlertLimiter, async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { guestSlug: req.params.slug } });
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    const { guest_client_id: guestClientId } = req.body || {};
    if (!guestClientId) {
      return res.status(400).json({ error: "guest_client_id is required" });
    }

    await unsubscribeGuestAlert({ eventId: event.id, guestClientId });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// One-off "text me this gallery link on WhatsApp" — distinct from the alert
// subscription above (this just sends the link once, right now; no ongoing
// notifications). Uses the same lib/whatsapp.js wrapper.
router.post("/:slug/whatsapp/send-link", guestWhatsAppLinkLimiter, async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { guestSlug: req.params.slug } });
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    if (isExpired(event)) {
      return res.status(410).json({ error: "This event's guest access has closed." });
    }

    const { phone } = req.body || {};
    if (!isValidE164(phone)) {
      return res.status(400).json({ error: "A valid phone number in international format (e.g. +919876543210) is required" });
    }

    const galleryUrl = `${process.env.PUBLIC_WEB_URL || "http://localhost:5173"}/e/${event.guestSlug}`;
    await sendWhatsAppMessage(phone, `Here's your PandaSpot gallery for "${event.name}": ${galleryUrl}`);
    res.json({ ok: true });
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
    if (isExpired(event)) {
      return res.status(410).json({ error: "This event's guest access has closed." });
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
    if (isExpired(event)) {
      return res.status(410).json({ error: "This event's guest access has closed." });
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
    if (isExpired(event)) {
      return res.status(410).json({ error: "This event's guest access has closed." });
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
    if (isExpired(event)) {
      return res.status(410).json({ error: "This event's guest access has closed." });
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
