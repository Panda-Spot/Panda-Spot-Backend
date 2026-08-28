import { prisma } from "./prisma.js";
import { deleteFileIfExists } from "./storage.js";

/**
 * The platform-wide default retention policy: a photo's full-res original
 * gets deleted from the server once its Photo.originalExpiresAt passes,
 * leaving the thumbnail, Face rows, and Photo row completely untouched —
 * search keeps working forever, only the full-res download goes away.
 * Deliberately separate from lib/driveBackupRetention.js, which governs
 * photos explicitly opted into Drive backup (platformDriveBackup: true)
 * under a stricter, different lifecycle (full deletion, not just the
 * original) — this sweep explicitly never touches those rows.
 */
export async function runPhotoRetentionSweep() {
  const duePhotos = await prisma.photo.findMany({
    where: {
      storagePath: { not: null },
      platformDriveBackup: false,
      originalExpiresAt: { lt: new Date() },
    },
  });

  for (const photo of duePhotos) {
    try {
      await deleteFileIfExists(photo.storagePath);
      await prisma.photo.update({ where: { id: photo.id }, data: { storagePath: null } });
    } catch (err) {
      console.error(`Photo retention sweep failed for photo ${photo.id}:`, err.message);
    }
  }
}

export function startPhotoRetentionScheduler() {
  const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly — cheap no-op when nothing is due
  setInterval(() => {
    runPhotoRetentionSweep().catch((err) => console.error("Photo retention sweep failed:", err));
  }, CHECK_INTERVAL_MS);
}
