import path from "node:path";
import { randomUUID } from "node:crypto";
import { prisma } from "./prisma.js";
import { detectFaces } from "./faceEngine.js";
import { insertFace } from "./faces.js";
import { generateThumbnail } from "./thumbnails.js";
import { ALLOWED_EXTENSIONS, saveEventBeamPhoto } from "./storage.js";
import { contentMatchesExtension } from "./fileValidation.js";
import { FREE_EVENT_STORAGE_BYTES, eventStorageUsedBytes } from "./planLimits.js";
import { publishLiveEvent } from "./liveEvents.js";
import { checkAndNotifyForNewPhotos } from "./guestAlerts.js";
import { uploadToDriveFolder } from "./driveBackup.js";

const MIME_BY_EXT = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

/**
 * Runs one already-on-disk file (from Beam's FTP staging area — see
 * lib/ftpBeam.js) through the same pipeline as a direct browser upload:
 * extension + content-sniff validation, storage-cap check, detectFaces,
 * generateThumbnail, then a Photo row. When the event has Drive backup on
 * (advanced/beta — see lib/driveBackupAuth.js), the full-res original is
 * uploaded to the connected Drive folder instead of being kept on the VPS
 * (storagePath stays null, driveFileId is set, platformDriveBackup: true —
 * same shape as a Drive import, but see lib/driveBackupRetention.js for why
 * these rows get reclaimed/purged on a 2/7-day clock instead of kept
 * forever). A Drive upload failure falls back to keeping the original
 * locally rather than losing the capture. Publishes a `photo_added` live
 * event on success, `photo_skipped` otherwise — never throws, since this
 * runs unattended with no request/response to report back to.
 */
export async function ingestCapturedFile(event, originalFilename, buffer) {
  const ext = path.extname(originalFilename).toLowerCase();

  prisma.event
    .update({ where: { id: event.id }, data: { lastBeamCaptureAt: new Date() } })
    .catch((err) => console.error(`Failed to stamp lastBeamCaptureAt for event ${event.id}:`, err));

  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return skip(event.id, originalFilename, "unsupported file type");
  }
  if (!contentMatchesExtension(buffer, ext)) {
    return skip(event.id, originalFilename, "file content doesn't match its extension");
  }

  const usedBytes = await eventStorageUsedBytes(prisma, event.id);
  if (usedBytes + buffer.length > FREE_EVENT_STORAGE_BYTES) {
    return skip(event.id, originalFilename, "event storage limit reached — 10GB free plan cap");
  }

  let detection;
  try {
    detection = await detectFaces(buffer, originalFilename);
  } catch (err) {
    return skip(event.id, originalFilename, err.isFaceEngineError ? err.message : "could not process image");
  }

  const photoId = randomUUID();
  const thumbnailPath = await generateThumbnail(buffer, event.id, photoId);
  const faces = detection.faces || [];

  let storagePath = null;
  let driveFileId = null;
  let platformDriveBackup = false;

  if (event.driveBackupEnabled && event.driveFolderId) {
    try {
      const driveFile = await uploadToDriveFolder({
        folderId: event.driveFolderId,
        filename: originalFilename,
        mimeType: MIME_BY_EXT[ext] || "application/octet-stream",
        buffer,
      });
      driveFileId = driveFile.id;
      platformDriveBackup = true;
    } catch (err) {
      console.error(`Drive backup upload failed for event ${event.id}, falling back to local storage:`, err.message);
    }
  }
  if (!driveFileId) {
    // Drive backup off, or its upload failed — kept in a dedicated beam/
    // subfolder rather than mixed in with directly-uploaded photos.
    storagePath = await saveEventBeamPhoto(event.id, `${photoId}${ext}`, buffer);
  }

  const photo = await prisma.photo.create({
    data: {
      id: photoId,
      eventId: event.id,
      filename: originalFilename,
      storagePath,
      thumbnailPath,
      driveFileId,
      platformDriveBackup,
      faceCount: faces.length,
      fileSize: buffer.length,
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

  publishLiveEvent(event.id, {
    type: "photo_added",
    photo_id: photo.id,
    filename: photo.filename,
    face_count: photo.faceCount,
    createdAt: photo.createdAt,
    url: `/files/events/${event.id}/photos/${photo.id}`,
    thumbnail_url: `/files/events/${event.id}/photos/${photo.id}/thumb`,
  });

  checkAndNotifyForNewPhotos(event, [photo.id]).catch((err) =>
    console.error(`Guest alert check failed for Beam photo ${photo.id}:`, err)
  );

  return { photo };
}

function skip(eventId, filename, reason) {
  console.warn(`Beam capture skipped for event ${eventId}: ${filename} (${reason})`);
  publishLiveEvent(eventId, { type: "photo_skipped", filename, reason });
  return { skipped: reason };
}
