import { randomUUID } from "node:crypto";
import { prisma } from "./prisma.js";
import { detectFaces } from "./faceEngine.js";
import { insertFace } from "./faces.js";
import { generateThumbnail } from "./thumbnails.js";
import { deleteFileIfExists } from "./storage.js";
import { downloadFile, guessExtension, listImageFiles } from "./googleDrive.js";
import { contentMatchesExtension } from "./fileValidation.js";
import { eventStorageUsedBytes, effectiveStorageLimitBytes } from "./planLimits.js";
import { emitJobEvent } from "./jobQueue.js";
import { checkAndNotifyForNewPhotos } from "./guestAlerts.js";
import { publishLiveEvent } from "./liveEvents.js";
import { assertQuotaAvailable, consumeQuota } from "./subscriptionAccess.js";

// Once per day — see runDueAutoSyncs below.
const AUTO_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Downloads, face-detects, thumbnails, and records one Drive file as a Photo
 * — never writes the original to local disk (see schema.prisma's Photo
 * notes). Returns `{ skipped: reason }` or `{ fileSize, facesFound }`.
 */
async function importOneDriveFile(event, file, usedBytesRef, storageLimitBytes, quotaRef) {
  const fileSize = parseInt(file.size, 10) || 0;
  const ext = guessExtension(file.mimeType, file.name);

  if (!ext) return { skipped: `${file.name} (unsupported file type)` };
  if (quotaRef?.subscription && quotaRef.used >= quotaRef.subscription.photoQuotaTotal) {
    return { skipped: `${file.name} (photo quota reached)` };
  }
  if (usedBytesRef.value + fileSize > storageLimitBytes) {
    return { skipped: `${file.name} (event storage limit reached)` };
  }

  let buffer;
  try {
    buffer = await downloadFile(file.id);
  } catch (err) {
    return { skipped: `${file.name} (${err.message})` };
  }

  if (!contentMatchesExtension(buffer, ext)) {
    return { skipped: `${file.name} (file content doesn't match its extension)` };
  }

  let detection;
  try {
    detection = await detectFaces(buffer, file.name);
  } catch (err) {
    return { skipped: `${file.name} (${err.isFaceEngineError ? err.message : "could not process image"})` };
  }

  const photoId = randomUUID();
  const thumbnailPath = await generateThumbnail(buffer, event.id, photoId);
  const faces = detection.faces || [];

  const photo = await prisma.photo.create({
    data: {
      id: photoId,
      eventId: event.id,
      filename: file.name,
      storagePath: null,
      driveFileId: file.id,
      thumbnailPath,
      faceCount: faces.length,
      fileSize,
      source: "drive_import",
      // No local original to expire — full-res is always fetched from
      // Drive live on demand, see lib/googleDrive.js.
      originalExpiresAt: null,
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

  usedBytesRef.value += fileSize;
  if (quotaRef?.subscription) quotaRef.used += 1;
  await consumeQuota(event.ownerId);
  const photoShape = {
    photo_id: photo.id,
    filename: photo.filename,
    face_count: photo.faceCount,
    createdAt: photo.createdAt,
    url: `/files/events/${event.id}/photos/${photo.id}`,
    thumbnail_url: `/files/events/${event.id}/photos/${photo.id}/thumb`,
    source: photo.source,
  };
  // So the public slideshow (guest.js's /:slug/live/stream) reflects every
  // source landing during a live event, not just Shoots.
  publishLiveEvent(event.id, { type: "photo_added", ...photoShape });

  return { fileSize, facesFound: faces.length, photoId: photo.id, photo: photoShape };
}

/** Removes a Photo whose Drive source file is gone: its Face rows, its
 * thumbnail on disk, then the row itself. */
async function removePhoto(photo) {
  await prisma.face.deleteMany({ where: { photoId: photo.id } });
  await prisma.photo.delete({ where: { id: photo.id } });
  await deleteFileIfExists(photo.thumbnailPath);
}

function emitProgress(jobId, { total, completed, currentFile, startedAt, facesFoundSoFar, skipped, photo }) {
  const elapsedSeconds = (Date.now() - startedAt) / 1000;
  const photosPerSecond = elapsedSeconds > 0 ? completed / elapsedSeconds : 0;
  const etaSeconds = photosPerSecond > 0 ? Math.round((total - completed) / photosPerSecond) : null;
  emitJobEvent(jobId, {
    type: "progress",
    job_id: jobId,
    total,
    completed,
    current_file: currentFile,
    photos_per_second: Math.round(photosPerSecond * 100) / 100,
    eta_seconds: etaSeconds,
    faces_found_so_far: facesFoundSoFar,
    skipped_so_far: skipped,
    photo: photo || null,
  });
}

/**
 * Full initial import — every image currently in the folder. Used once, by
 * the "connect" step. Mirrors processUploadJob's SSE event shape so the
 * existing frontend progress UI works unchanged.
 */
export async function processDriveImportJob(jobId, event, files) {
  const total = files.length;
  const skipped = [];
  let completed = 0;
  let facesFoundSoFar = 0;
  const startedAt = Date.now();
  const usedBytesRef = { value: await eventStorageUsedBytes(prisma, event.id) };
  const owner = await prisma.user.findUnique({ where: { id: event.ownerId } });
  const storageLimitBytes = effectiveStorageLimitBytes(owner);
  const subscription = await assertQuotaAvailable(event.ownerId);
  const quotaRef = subscription ? { subscription, used: subscription.photoQuotaUsed } : null;
  const newPhotoIds = [];

  try {
    for (const file of files) {
      const result = await importOneDriveFile(event, file, usedBytesRef, storageLimitBytes, quotaRef);
      if (result.skipped) skipped.push(result.skipped);
      else {
        facesFoundSoFar += result.facesFound;
        newPhotoIds.push(result.photoId);
      }

      completed += 1;
      emitProgress(jobId, { total, completed, currentFile: file.name, startedAt, facesFoundSoFar, skipped, photo: result.photo });
    }

    await prisma.event.update({ where: { id: event.id }, data: { lastDriveSyncAt: new Date() } });

    checkAndNotifyForNewPhotos(event, newPhotoIds).catch((err) =>
      console.error(`Guest alert check failed for Drive import job ${jobId}:`, err)
    );

    emitJobEvent(jobId, {
      type: "done",
      job_id: jobId,
      photos_processed: total - skipped.length,
      faces_found: facesFoundSoFar,
      skipped,
    });
  } catch (err) {
    console.error(`Drive import job ${jobId} failed:`, err);
    emitJobEvent(jobId, {
      type: "error",
      job_id: jobId,
      message: err.message || "Unknown error while processing Google Drive import",
    });
  }
}

/**
 * Diffs the folder's current file list against what's already imported:
 * downloads+processes files that are new, and removes Photos whose Drive
 * file was deleted/trashed since the last sync. Used by both the manual
 * "Sync now" button (with a jobId a client is watching over SSE) and the
 * daily automatic scheduler (a jobId still gets created so the same code
 * path runs, even though nothing is listening for its progress events).
 */
export async function processDriveSyncJob(jobId, event, currentFiles) {
  const startedAt = Date.now();
  const skipped = [];
  let facesFoundSoFar = 0;

  try {
    const currentIds = new Set(currentFiles.map((f) => f.id));
    const existingDrivePhotos = await prisma.photo.findMany({
      where: { eventId: event.id, driveFileId: { not: null } },
    });
    const existingIds = new Set(existingDrivePhotos.map((p) => p.driveFileId));

    const newFiles = currentFiles.filter((f) => !existingIds.has(f.id));
    const removedPhotos = existingDrivePhotos.filter((p) => !currentIds.has(p.driveFileId));

    const total = newFiles.length + removedPhotos.length;
    let completed = 0;
    const usedBytesRef = { value: await eventStorageUsedBytes(prisma, event.id) };
    const owner = await prisma.user.findUnique({ where: { id: event.ownerId } });
    const storageLimitBytes = effectiveStorageLimitBytes(owner);
    const subscription = await assertQuotaAvailable(event.ownerId);
    const quotaRef = subscription ? { subscription, used: subscription.photoQuotaUsed } : null;
    const newPhotoIds = [];

    for (const file of newFiles) {
      const result = await importOneDriveFile(event, file, usedBytesRef, storageLimitBytes, quotaRef);
      if (result.skipped) skipped.push(result.skipped);
      else {
        facesFoundSoFar += result.facesFound;
        newPhotoIds.push(result.photoId);
      }
      completed += 1;
      emitProgress(jobId, { total, completed, currentFile: file.name, startedAt, facesFoundSoFar, skipped, photo: result.photo });
    }

    for (const photo of removedPhotos) {
      await removePhoto(photo);
      completed += 1;
      emitProgress(jobId, { total, completed, currentFile: photo.filename, startedAt, facesFoundSoFar, skipped });
    }

    await prisma.event.update({ where: { id: event.id }, data: { lastDriveSyncAt: new Date() } });

    checkAndNotifyForNewPhotos(event, newPhotoIds).catch((err) =>
      console.error(`Guest alert check failed for Drive sync job ${jobId}:`, err)
    );

    emitJobEvent(jobId, {
      type: "done",
      job_id: jobId,
      photos_processed: newFiles.length - skipped.length,
      faces_found: facesFoundSoFar,
      removed_count: removedPhotos.length,
      skipped,
    });
  } catch (err) {
    console.error(`Drive sync job ${jobId} failed:`, err);
    await prisma.event
      .update({ where: { id: event.id }, data: { lastDriveSyncAt: new Date() } })
      .catch(() => {});
    emitJobEvent(jobId, {
      type: "error",
      job_id: jobId,
      message: err.message || "Unknown error while syncing Google Drive folder",
    });
  }
}

/**
 * Called on a recurring timer (see index.js) — finds every event with
 * auto-sync on whose last sync was 24h+ ago (or never synced since being
 * connected), and syncs each one. No SSE listener is involved; a failure on
 * one event is logged and doesn't stop the rest. lastDriveSyncAt is stamped
 * even on failure (inside processDriveSyncJob's own catch) so a broken
 * folder doesn't get retried on every tick — it naturally retries tomorrow.
 */
export async function runDueAutoSyncs() {
  const cutoff = new Date(Date.now() - AUTO_SYNC_INTERVAL_MS);
  const dueEvents = await prisma.event.findMany({
    where: {
      driveSyncEnabled: true,
      driveFolderId: { not: null },
      OR: [{ lastDriveSyncAt: null }, { lastDriveSyncAt: { lt: cutoff } }],
    },
  });

  for (const event of dueEvents) {
    try {
      const files = await listImageFiles(event.driveFolderId);
      await processDriveSyncJob(randomUUID(), event, files);
    } catch (err) {
      console.error(`Auto drive-sync failed for event ${event.id}:`, err.message);
      await prisma.event
        .update({ where: { id: event.id }, data: { lastDriveSyncAt: new Date() } })
        .catch(() => {});
    }
  }
}

/** Starts the recurring check (hourly — cheap no-op for events not yet due;
 * actual per-event syncs are still gated to once/24h by runDueAutoSyncs). */
export function startAutoSyncScheduler() {
  const CHECK_INTERVAL_MS = 60 * 60 * 1000;
  setInterval(() => {
    runDueAutoSyncs().catch((err) => console.error("Drive auto-sync sweep failed:", err));
  }, CHECK_INTERVAL_MS);
}
