import path from "node:path";
import { randomUUID } from "node:crypto";
import { prisma } from "./prisma.js";
import { detectFacesForPhoto, replacePhotoFaces } from "./faces.js";
import { generateThumbnail } from "./thumbnails.js";
import { IMAGE_EXTENSIONS } from "./storage.js";
import { getStorageProvider } from "./storageProvider.js";
import { contentMatchesExtension } from "./fileValidation.js";
import { eventStorageUsedBytes, effectiveStorageLimitBytes, effectivePhotoRetentionDays } from "./planLimits.js";
import { publishLiveEvent } from "./liveEvents.js";
import { checkAndNotifyForNewPhotos } from "./guestAlerts.js";
import { uploadToDriveFolder, MIME_BY_EXT } from "./driveBackup.js";
import { assertQuotaAvailable, consumeAiPhotoCredits, consumeQuota } from "./subscriptionAccess.js";

/**
 * Runs one already-on-disk file (from Shoots' FTP staging area — see
 * lib/ftpShoots.js) through the same pipeline as a direct browser upload:
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
    .update({ where: { id: event.id }, data: { lastShootsCaptureAt: new Date() } })
    .catch((err) => console.error(`Failed to stamp lastShootsCaptureAt for event ${event.id}:`, err));

  // PandaShoots captures are camera stills — video never arrives here.
  if (!IMAGE_EXTENSIONS.has(ext)) {
    return skip(event.id, originalFilename, "unsupported file type");
  }
  if (!contentMatchesExtension(buffer, ext)) {
    return skip(event.id, originalFilename, "file content doesn't match its extension");
  }

  const usedBytes = await eventStorageUsedBytes(prisma, event.id);
  const owner = await prisma.user.findUnique({ where: { id: event.ownerId } });
  try {
    await assertQuotaAvailable(event.ownerId);
  } catch (err) {
    return skip(event.id, originalFilename, err.message || "photo quota unavailable");
  }
  if (usedBytes + buffer.length > effectiveStorageLimitBytes(owner)) {
    return skip(event.id, originalFilename, "event storage limit reached");
  }

  let faces = [];
  try {
    if (event.faceSearchEnabled) {
      faces = await detectFacesForPhoto(buffer, originalFilename);
    }
  } catch (err) {
    return skip(event.id, originalFilename, err.isFaceEngineError ? err.message : "could not process image");
  }

  const photoId = randomUUID();
  const thumbnailPath = await generateThumbnail(buffer, event.id, photoId);

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
    // Drive backup off, or its upload failed — kept in a dedicated shoots/
    // subfolder rather than mixed in with directly-uploaded photos.
    storagePath = await getStorageProvider().writeShootsOriginal(event.id, `${photoId}${ext}`, buffer);
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
      driveBackupStartedAt: platformDriveBackup ? new Date() : null,
      faceCount: faces.length,
      fileSize: buffer.length,
      source: "shoots",
      faceSearchVisible: event.faceSearchEnabled,
      // Only the platform's global default-retention clock — Drive-backed
      // captures are governed by driveBackupStartedAt/platformDriveBackup
      // above instead (a separate, stricter lifecycle).
      originalExpiresAt: storagePath
        ? new Date(Date.now() + effectivePhotoRetentionDays(owner) * 24 * 60 * 60 * 1000)
        : null,
    },
  });

  if (event.faceSearchEnabled) {
    await replacePhotoFaces({ photoId: photo.id, eventId: event.id, faces });
    await consumeAiPhotoCredits(event.ownerId);
  }

  await consumeQuota(event.ownerId);

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
    console.error(`Guest alert check failed for Shoots photo ${photo.id}:`, err)
  );

  return { photo };
}

function skip(eventId, filename, reason) {
  console.warn(`Shoots capture skipped for event ${eventId}: ${filename} (${reason})`);
  publishLiveEvent(eventId, { type: "photo_skipped", filename, reason });
  return { skipped: reason };
}
