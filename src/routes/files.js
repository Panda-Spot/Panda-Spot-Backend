import { Router } from "express";
import path from "node:path";
import { prisma } from "../lib/prisma.js";
import { existsSync, recoverEventCoverPath } from "../lib/storage.js";
import { downloadFile, findDriveFileByName } from "../lib/googleDrive.js";
import { verifyMediaToken } from "../lib/mediaTokens.js";
import { loadPhotoOriginalBuffer, rawDimensions, saveFaceThumbnail } from "../lib/faces.js";
import { originalDimensions } from "../lib/thumbnails.js";

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

// Thumbnails and originals are content-addressed by photo id and never
// modified under the same URL (edits create new files, deletes 404), so
// browsers may cache them for a year — repeat grid scrolls, revisits, and
// lightbox navigation then serve straight from the browser cache.
const IMMUTABLE_FILE_OPTIONS = { maxAge: "1y", immutable: true };
// Covers and sponsor logos ARE replaced under the same URL — cache briefly,
// revalidate after.
const MUTABLE_FILE_OPTIONS = { maxAge: 60000 };

async function sendPhotoFile(res, photo, variant) {
  if (variant === "thumb" && photo.thumbnailPath && existsSync(photo.thumbnailPath)) {
    return res.sendFile(photo.thumbnailPath, IMMUTABLE_FILE_OPTIONS);
  }
  if (photo.storagePath && existsSync(photo.storagePath)) {
    return res.sendFile(photo.storagePath, IMMUTABLE_FILE_OPTIONS);
  }
  if (photo.driveFileId) {
    const buffer = await downloadFile(photo.driveFileId);
    res.setHeader("Content-Type", guessContentType(photo.filename));
    // Drive originals can change remotely — cache briefly only.
    res.setHeader("Cache-Control", "public, max-age=3600");
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
      return res.sendFile(photo.storagePath, IMMUTABLE_FILE_OPTIONS);
    }
    const serveDriveBuffer = (buffer) => {
      res.setHeader("Content-Type", guessContentType(photo.filename));
      res.setHeader("Cache-Control", "public, max-age=3600");
      return res.send(buffer);
    };
    if (photo.driveFileId) {
      try {
        return serveDriveBuffer(await downloadFile(photo.driveFileId));
      } catch {
        // Stored file id went stale (replaced/restricted in Drive) — fall
        // through to the by-name lookup below before giving up.
      }
    }
    // No local original (Drive imports) and the stored file id failed or was
    // never set: find this exact filename in the event's connected folder
    // right now, download it alone, and serve it — repairing the stored id
    // for next time.
    try {
      const event = await prisma.event.findUnique({ where: { id: req.params.eventId } });
      const folderId = event?.exportDriveFolderId || event?.driveFolderId;
      if (folderId) {
        const match = await findDriveFileByName(folderId, photo.filename);
        if (match) {
          const buffer = await downloadFile(match.id);
          if (match.id !== photo.driveFileId) {
            await prisma.photo.update({ where: { id: photo.id }, data: { driveFileId: match.id } }).catch(() => {});
          }
          return serveDriveBuffer(buffer);
        }
      }
    } catch {
      // Folder unreachable — fall through to the 404 below.
    }
    return res.status(404).json({
      error: "This photo's original is no longer accessible — the Google Drive folder may have been made private or the file may have been removed.",
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
      return res.sendFile(photo.thumbnailPath, IMMUTABLE_FILE_OPTIONS);
    }
    if (!existsSync(photo.storagePath)) {
      return res.status(404).json({ error: "Photo file missing on disk" });
    }
    res.sendFile(photo.storagePath, IMMUTABLE_FILE_OPTIONS);
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
      // Stale absolute path (e.g. STORAGE_DIR/cwd changed since the upload,
      // or the disk was swapped) — fall back to whatever cover.<ext> file
      // actually lives in the event's directory today before giving up.
      const recovered = recoverEventCoverPath(req.params.eventId);
      if (!recovered) {
        return res.status(404).json({ error: "Cover file missing on disk" });
      }
      event.coverPhotoPath = recovered;
    }
    // Covers get replaced fairly often (every "Set cover" upload) and the
    // URL is the same after a replace, so a permissive max-age would
    // leave stale pixels in the browser for up to a minute. no-store
    // guarantees the next page render fetches the new bytes — pass it
    // through sendFile's per-call `headers` so it's not clobbered by
    // express's default caching of the response.
    res.sendFile(event.coverPhotoPath, { ...MUTABLE_FILE_OPTIONS, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    next(err);
  }
});

// Serves one pre-extracted face closeup (192px JPEG, written at index
// time — see lib/faces.js). UUID trust model like the photo routes: the
// face id is not enumerable. Face thumbs never change under their URL, so
// they cache immutably. Missing files self-heal: if the row predates
// thumbnails (or its file was lost), the original is loaded and the crop
// re-extracted on demand, then served.
router.get("/events/:eventId/faces/:faceId", async (req, res, next) => {
  try {
    const face = await prisma.face.findFirst({
      where: { id: req.params.faceId, eventId: req.params.eventId },
      include: { photo: true },
    });
    if (!face) {
      return res.status(404).json({ error: "Face not found" });
    }
    if (face.thumbnailPath && existsSync(face.thumbnailPath)) {
      return res.sendFile(face.thumbnailPath, IMMUTABLE_FILE_OPTIONS);
    }
    // Lazy backfill for legacy rows: re-extract from the original now.
    // Legacy rows (bboxSpace NULL) were detected on raw bytes where the
    // detector ignores EXIF, so they extract from the UNROTATED canvas
    // with raw dims; 'displayed' rows use the rotated canvas. Either way
    // the crop matches the exact face this row belongs to.
    try {
      const buffer = await loadPhotoOriginalBuffer(face.photo);
      const legacy = !face.bboxSpace || face.bboxSpace === "raw";
      const { width, height } = legacy ? await rawDimensions(buffer) : await originalDimensions(buffer);
      if (!width || !height) {
        return res.status(404).set("Cache-Control", "no-store").json({ error: "Face thumbnail unavailable" });
      }
      const saved = await saveFaceThumbnail({
        eventId: face.eventId,
        photoId: face.photoId,
        faceId: face.id,
        buffer,
        bbox: face.bbox,
        origWidth: width,
        origHeight: height,
        rawSpace: legacy,
      });
      if (saved) {
        await prisma.face.update({ where: { id: face.id }, data: { thumbnailPath: saved } });
        return res.sendFile(saved, IMMUTABLE_FILE_OPTIONS);
      }
    } catch (err) {
      console.error(`Face thumbnail backfill failed for face ${face.id}:`, err?.message || err);
    }
    return res.status(404).set("Cache-Control", "no-store").json({ error: "Face thumbnail unavailable" });
  } catch (err) {
    next(err);
  }
});
// Phase 8 (live TV wall): serves the event's sponsor logo overlay. UUID
// trust model, like the cover route above it.
router.get("/events/:eventId/sponsor-logo", async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { id: req.params.eventId } });
    if (!event || !event.sponsorLogoPath) {
      return res.status(404).json({ error: "No sponsor logo set" });
    }
    if (!existsSync(event.sponsorLogoPath)) {
      return res.status(404).json({ error: "Sponsor logo file missing on disk" });
    }
    res.sendFile(event.sponsorLogoPath, { ...MUTABLE_FILE_OPTIONS, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    next(err);
  }
});
// MERGE (Album proofing, Phase 23): serves one album spread image, its
// thumbnail, or a version's print PDF. Same UUID trust model as the photo
// routes above — the filename is a randomUUID, not enumerable, and URLs are
// only ever handed out by the studio/client album APIs (which enforce the
// DRAFT-invisibility rule). Album files are local-disk only, so there is no
// Drive fallback here.
router.get("/events/:eventId/albums/:albumId/files/:filename", async (req, res, next) => {
  try {
    const { eventId, albumId, filename } = req.params;
    if (filename.includes("/") || filename.includes("\\") || filename.startsWith(".")) {
      return res.status(404).json({ error: "File not found" });
    }
    const album = await prisma.album.findFirst({
      where: { id: albumId, eventId },
      include: { versions: { include: { pages: true } } },
    });
    if (!album) return res.status(404).json({ error: "File not found" });
    let diskPath = null;
    for (const version of album.versions) {
      if (version.printPdfPath && path.basename(version.printPdfPath) === filename) {
        diskPath = version.printPdfPath;
        break;
      }
      for (const page of version.pages) {
        if (path.basename(page.storagePath) === filename) {
          diskPath = page.storagePath;
          break;
        }
        if (page.thumbnailPath && path.basename(page.thumbnailPath) === filename) {
          diskPath = page.thumbnailPath;
          break;
        }
      }
      if (diskPath) break;
    }
    if (!diskPath || !existsSync(diskPath)) {
      return res.status(404).json({ error: "File not found" });
    }
    res.sendFile(diskPath);
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
