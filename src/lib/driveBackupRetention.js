import path from "node:path";
import { prisma } from "./prisma.js";
import { downloadFile } from "./googleDrive.js";
import { deleteFileFromDrive } from "./driveBackup.js";
import { deleteFileIfExists } from "./storage.js";
import { getStorageProvider } from "./storageProvider.js";
import { sendDriveBackupReclaimNoticeEmail } from "./mailer.js";

// The platform's own Drive account (see lib/driveBackupAuth.js) is a
// temporary relay, not a permanent archive — its storage quota is shared
// across every event using Drive backup, so photos captured that way
// (Photo.platformDriveBackup) are aggressively reclaimed and then purged on
// a fixed clock, giving the studio owner a real but bounded window to save
// their own copy (via Drive's own "Make a copy" — see the notice email).
const RECLAIM_AFTER_MS = 2 * 24 * 60 * 60 * 1000; // day 2: pull back to the VPS, delete from Drive
const PURGE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // day 7: gone everywhere, for good
const NOTICE_AFTER_INACTIVITY_MS = 6 * 60 * 60 * 1000; // no Shoots captures for 6h -> "this shoot looks finished"

/**
 * Reclaims the platform account's Drive quota for one photo. If it doesn't
 * already have a local copy (a PandaShoots capture that went straight to
 * Drive), downloads it back first (a public read via the API key — works
 * because the folder is link-shared, no OAuth needed) before deleting the
 * Drive copy. If it already has a local copy (backed up via
 * POST .../backup-existing, or already reclaimed once before), there's
 * nothing to pull back — just delete the redundant Drive copy. `force`
 * skips the day-2 age check — used by the manual "reclaim now" route,
 * since an explicit owner confirmation is a stronger signal than a timer.
 */
async function reclaimPhotos(photos, { force = false } = {}) {
  let reclaimed = 0;
  const cutoff = Date.now() - RECLAIM_AFTER_MS;
  for (const photo of photos) {
    if (!photo.driveFileId) continue;
    const startedAt = photo.driveBackupStartedAt || photo.createdAt;
    if (!force && startedAt.getTime() > cutoff) continue;
    try {
      let storagePath = photo.storagePath;
      if (!storagePath) {
        const buffer = await downloadFile(photo.driveFileId);
        const ext = path.extname(photo.filename) || ".jpg";
        storagePath = await getStorageProvider().writeShootsOriginal(photo.eventId, `${photo.id}${ext}`, buffer);
      }
      // Only clear driveFileId once the Drive copy is actually confirmed
      // gone — clearing it regardless of outcome would let a failed delete
      // silently leak Drive quota forever with no record left to retry
      // against on the next sweep. `reclaimed` only counts full successes,
      // since a failed delete hasn't actually freed any Drive quota yet.
      try {
        await deleteFileFromDrive(photo.driveFileId);
        await prisma.photo.update({ where: { id: photo.id }, data: { storagePath, driveFileId: null } });
        reclaimed += 1;
      } catch (err) {
        console.error(`Drive delete failed for photo ${photo.id} (will retry next sweep):`, err.message);
        if (photo.storagePath == null) {
          // The download-and-save above still succeeded even though the
          // Drive-side delete didn't — persist the new local copy now so a
          // retry next sweep doesn't re-download it from scratch.
          await prisma.photo.update({ where: { id: photo.id }, data: { storagePath } });
        }
      }
    } catch (err) {
      console.error(`Reclaim failed for photo ${photo.id}:`, err.message);
    }
  }
  return reclaimed;
}

/** Manual "I've made my copies — free up space" — reclaims every eligible
 * photo in one event right now, regardless of its 2-day timer. */
export async function reclaimEventDriveBackups(eventId) {
  const photos = await prisma.photo.findMany({
    where: { eventId, platformDriveBackup: true, driveFileId: { not: null } },
  });
  const reclaimed = await reclaimPhotos(photos, { force: true });
  return { reclaimed_count: reclaimed };
}

/** Fully deletes a platform-drive-backup photo whose 7-day window has
 * elapsed: whichever of the Drive/VPS copy still exists, its Face rows,
 * and the Photo row itself — after this, it's gone from PandaSpot too
 * (search included), not just full-res access. */
async function purgePhoto(photo) {
  if (photo.driveFileId) await deleteFileFromDrive(photo.driveFileId).catch(() => {});
  await getStorageProvider().deleteOriginal(photo.storagePath);
  await deleteFileIfExists(photo.thumbnailPath);
  await prisma.face.deleteMany({ where: { photoId: photo.id } });
  await prisma.photo.delete({ where: { id: photo.id } });
}

/**
 * Runs periodically (see startDriveBackupRetentionScheduler): reclaims any
 * due (2+ day old) photos still sitting on Drive, purges any 7+ day old
 * ones outright, and sends each event's one-time "make your copy" notice
 * once its Shoots captures look finished (no new ones for a while).
 */
export async function runDriveBackupRetentionSweep() {
  const dueForReclaim = await prisma.photo.findMany({
    where: {
      platformDriveBackup: true,
      driveFileId: { not: null },
      driveBackupStartedAt: { lt: new Date(Date.now() - RECLAIM_AFTER_MS) },
    },
  });
  await reclaimPhotos(dueForReclaim, { force: true });

  const dueForPurge = await prisma.photo.findMany({
    where: { platformDriveBackup: true, driveBackupStartedAt: { lt: new Date(Date.now() - PURGE_AFTER_MS) } },
  });
  for (const photo of dueForPurge) {
    try {
      await purgePhoto(photo);
    } catch (err) {
      console.error(`Purge failed for photo ${photo.id}:`, err.message);
    }
  }

  const eventsNeedingNotice = await prisma.event.findMany({
    where: {
      driveBackupEnabled: true,
      driveBackupNoticeSentAt: null,
      lastShootsCaptureAt: { lt: new Date(Date.now() - NOTICE_AFTER_INACTIVITY_MS) },
    },
    include: { owner: true },
  });
  for (const event of eventsNeedingNotice) {
    try {
      await sendDriveBackupReclaimNoticeEmail(event.owner.email, event.name, event.driveFolderUrl);
      await prisma.event.update({ where: { id: event.id }, data: { driveBackupNoticeSentAt: new Date() } });
    } catch (err) {
      console.error(`Failed to send drive backup notice for event ${event.id}:`, err.message);
    }
  }
}

export function startDriveBackupRetentionScheduler() {
  const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly — cheap no-op when nothing is due
  setInterval(() => {
    runDriveBackupRetentionSweep().catch((err) => console.error("Drive backup retention sweep failed:", err));
  }, CHECK_INTERVAL_MS);
}
