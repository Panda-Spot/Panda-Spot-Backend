import path from "node:path";
import { randomUUID } from "node:crypto";
import { prisma } from "./prisma.js";
import { detectFaces } from "./faceEngine.js";
import { insertFace } from "./faces.js";
import { generateThumbnail } from "./thumbnails.js";
import { ALLOWED_EXTENSIONS, saveEventPhoto } from "./storage.js";
import { contentMatchesExtension } from "./fileValidation.js";
import { FREE_EVENT_STORAGE_BYTES, eventStorageUsedBytes } from "./planLimits.js";
import { publishLiveEvent } from "./liveEvents.js";
import { checkAndNotifyForNewPhotos } from "./guestAlerts.js";
import { uploadToDriveFolder } from "./driveBackup.js";

const MIME_BY_EXT = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

/**
 * Runs one already-on-disk file (from Beam's FTP staging area — see
 * lib/ftpBeam.js) through the exact same pipeline as a direct browser
 * upload: extension + content-sniff validation, storage-cap check,
 * detectFaces, generateThumbnail, then a Photo row (with storagePath set,
 * same as a normal upload — Beam captures aren't Drive-backed, so there's
 * no reason to discard the original). Publishes a `photo_added` live event
 * on success so an open event page can update its gallery immediately, or a
 * `photo_skipped` one otherwise — never throws, since this runs unattended
 * with no request/response to report back to.
 */
export async function ingestCapturedFile(event, originalFilename, buffer) {
  const ext = path.extname(originalFilename).toLowerCase();

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
  const storedFilename = `${photoId}${ext}`;
  const storagePath = await saveEventPhoto(event.id, storedFilename, buffer);
  const thumbnailPath = await generateThumbnail(buffer, event.id, photoId);
  const faces = detection.faces || [];

  const photo = await prisma.photo.create({
    data: {
      id: photoId,
      eventId: event.id,
      filename: originalFilename,
      storagePath,
      thumbnailPath,
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

  // Advanced/beta: mirror this capture back into the connected Drive folder
  // so Drive stays the complete archive — see lib/driveBackup.js. Never
  // allowed to affect the capture itself; a failure here (expired grant,
  // Drive quota, network) is logged and nothing more.
  if (event.driveBackupEnabled && event.driveFolderId) {
    backUpToDriveIfEnabled(event, originalFilename, ext, buffer).catch((err) =>
      console.error(`Drive backup failed for Beam photo ${photo.id}:`, err)
    );
  }

  return { photo };
}

async function backUpToDriveIfEnabled(event, filename, ext, buffer) {
  const owner = await prisma.user.findUnique({ where: { id: event.ownerId } });
  if (!owner?.driveBackupRefreshToken) return;
  await uploadToDriveFolder({
    refreshToken: owner.driveBackupRefreshToken,
    folderId: event.driveFolderId,
    filename,
    mimeType: MIME_BY_EXT[ext] || "application/octet-stream",
    buffer,
  });
}

function skip(eventId, filename, reason) {
  console.warn(`Beam capture skipped for event ${eventId}: ${filename} (${reason})`);
  publishLiveEvent(eventId, { type: "photo_skipped", filename, reason });
  return { skipped: reason };
}
