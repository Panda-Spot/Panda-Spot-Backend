import { Router } from "express";
import path from "node:path";
import { prisma } from "../lib/prisma.js";
import { existsSync } from "../lib/storage.js";
import { downloadFile } from "../lib/googleDrive.js";
import { verifyMediaToken } from "../lib/mediaTokens.js";

const router = Router();

const EXT_CONTENT_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
};

function guessContentType(filename) {
  const ext = path.extname(filename || "").toLowerCase();
  return EXT_CONTENT_TYPES[ext] || "image/jpeg";
}

async function sendPhotoFile(res, photo, variant) {
  if (variant === "thumb" && photo.thumbnailPath && existsSync(photo.thumbnailPath)) {
    return res.sendFile(photo.thumbnailPath);
  }
  if (photo.storagePath && existsSync(photo.storagePath)) {
    return res.sendFile(photo.storagePath);
  }
  if (photo.driveFileId) {
    const buffer = await downloadFile(photo.driveFileId);
    res.setHeader("Content-Type", guessContentType(photo.filename));
    return res.send(buffer);
  }
  return res.status(404).json({
    error: "This photo's original has expired and is no longer available.",
  });
}

// Short-lived, signed local-disk media URL. This is the VPS/local equivalent
// of Studio-Verse's presigned S3 URLs for protected Photo Selection galleries:
// no bucket, no file copy, just an expiring token plus a fresh DB access check.
router.get("/protected/media/:token", async (req, res, next) => {
  try {
    let payload;
    try {
      payload = verifyMediaToken(req.params.token);
    } catch {
      return res.status(401).json({ error: "Media link expired or invalid" });
    }

    if (payload.purpose !== "photo_selection" || !["original", "thumb"].includes(payload.variant)) {
      return res.status(401).json({ error: "Media link expired or invalid" });
    }

    const photo = await prisma.photo.findUnique({ where: { id: payload.photoId } });
    if (
      !photo ||
      photo.eventId !== payload.eventId ||
      photo.approvalStatus !== "approved" ||
      photo.archivedAt ||
      !photo.photoSelectionVisible
    ) {
      return res.status(404).json({ error: "Photo not found" });
    }

    res.setHeader("Cache-Control", "private, no-store");
    return sendPhotoFile(res, photo, payload.variant);
  } catch (err) {
    if (err.message?.includes("Google Drive")) {
      return res.status(404).json({ error: "This photo's original is no longer accessible." });
    }
    next(err);
  }
});

// Unauthenticated by design: photo/event IDs are UUIDs (not enumerable), and
// this mirrors the original spike's trust model — whoever has a photo URL
// (from an upload response or a search match) can view that one file.
router.get("/events/:eventId/photos/:photoId", async (req, res, next) => {
  try {
    const photo = await prisma.photo.findUnique({ where: { id: req.params.photoId } });
    if (!photo || photo.eventId !== req.params.eventId) {
      return res.status(404).json({ error: "Photo not found" });
    }
    if (photo.storagePath && existsSync(photo.storagePath)) {
      return res.sendFile(photo.storagePath);
    }
    if (photo.driveFileId) {
      try {
        const buffer = await downloadFile(photo.driveFileId);
        res.setHeader("Content-Type", guessContentType(photo.filename));
        return res.send(buffer);
      } catch (err) {
        return res.status(404).json({
          error:
            "This photo's original is no longer accessible — the Google Drive folder may have been made private or the file may have been removed.",
        });
      }
    }
    return res.status(404).json({
      error: "This photo's original has expired and is no longer available for download — search still works.",
    });
  } catch (err) {
    next(err);
  }
});

// Serves the resized preview generated at upload time — falls back to the
// full-size original if thumbnailing failed or hasn't run for this photo
// (e.g. a photo uploaded before this feature existed), so callers can
// always just use this URL without checking first.
router.get("/events/:eventId/photos/:photoId/thumb", async (req, res, next) => {
  try {
    const photo = await prisma.photo.findUnique({ where: { id: req.params.photoId } });
    if (!photo || photo.eventId !== req.params.eventId) {
      return res.status(404).json({ error: "Photo not found" });
    }
    if (photo.thumbnailPath && existsSync(photo.thumbnailPath)) {
      return res.sendFile(photo.thumbnailPath);
    }
    if (!existsSync(photo.storagePath)) {
      return res.status(404).json({ error: "Photo file missing on disk" });
    }
    res.sendFile(photo.storagePath);
  } catch (err) {
    next(err);
  }
});

// MERGE (Studio-Verse cover, Phase 18E): serves an event's cover photo for
// dashboard grids and gallery headers. UUID trust model, like every other
// route in this file — the event id is not enumerable.
router.get("/events/:eventId/cover", async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { id: req.params.eventId } });
    if (!event || !event.coverPhotoPath) {
      return res.status(404).json({ error: "No cover set" });
    }
    if (!existsSync(event.coverPhotoPath)) {
      return res.status(404).json({ error: "Cover file missing on disk" });
    }
    res.sendFile(event.coverPhotoPath);
  } catch (err) {
    next(err);
  }
});
// Public by design: guests viewing an event's page need to see the
// photographer's studio branding without logging in.
router.get("/branding/:userId/logo", async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!user || !user.logoPath) {
      return res.status(404).json({ error: "No logo set" });
    }
    if (!existsSync(user.logoPath)) {
      return res.status(404).json({ error: "Logo file missing on disk" });
    }
    res.sendFile(user.logoPath);
  } catch (err) {
    next(err);
  }
});

// Same trust model as the logo: the watermark overlay image is referenced
// by gallery pages (which already expose the studio logo publicly).
router.get("/branding/:userId/watermark", async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!user || !user.watermarkImagePath) {
      return res.status(404).json({ error: "No watermark image set" });
    }
    if (!existsSync(user.watermarkImagePath)) {
      return res.status(404).json({ error: "Watermark file missing on disk" });
    }
    res.sendFile(user.watermarkImagePath);
  } catch (err) {
    next(err);
  }
});

export default router;
