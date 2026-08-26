import { prisma } from "./prisma.js";
import { deleteFileIfExists, removeEventDir } from "./storage.js";
import { zipDownloadPath } from "./zip.js";
import { deleteFileFromDrive } from "./driveBackup.js";

/**
 * Permanently deletes one event: every photo/face/search/feedback/zip/
 * collaborator/invite row (in FK dependency order, children before the
 * Event row itself), the event's whole photo/thumbnail directory on disk,
 * any pre-built zip files from the email-download flow, and best-effort
 * reclaims any of its photos still occupying the platform's own Drive
 * backup quota first (see lib/driveBackupRetention.js) so they don't linger
 * there forever with nothing left to point at them.
 *
 * Shared by the owner-facing `DELETE /events/:id` route and the admin
 * "delete this client's account" route (routes/admin.js), which calls this
 * once per event the client owns before deleting the User row itself.
 */
export async function deleteEventCascade(event) {
  const zipDownloads = await prisma.zipDownload.findMany({ where: { eventId: event.id } });

  const platformDrivePhotos = await prisma.photo.findMany({
    where: { eventId: event.id, platformDriveBackup: true, driveFileId: { not: null } },
  });
  for (const photo of platformDrivePhotos) {
    await deleteFileFromDrive(photo.driveFileId).catch((err) =>
      console.error(`Failed to delete Drive backup file for photo ${photo.id} during event deletion:`, err.message)
    );
  }

  await prisma.matchFeedback.deleteMany({ where: { search: { eventId: event.id } } });
  await prisma.guestSearch.deleteMany({ where: { eventId: event.id } });
  await prisma.face.deleteMany({ where: { eventId: event.id } });
  await prisma.photo.deleteMany({ where: { eventId: event.id } });
  await prisma.zipDownload.deleteMany({ where: { eventId: event.id } });
  await prisma.guestAlertSubscription.deleteMany({ where: { eventId: event.id } });
  await prisma.eventCollaborator.deleteMany({ where: { eventId: event.id } });
  await prisma.eventInvite.deleteMany({ where: { eventId: event.id } });
  await prisma.event.delete({ where: { id: event.id } });

  await removeEventDir(event.id);
  for (const z of zipDownloads) {
    await deleteFileIfExists(z.filePath || zipDownloadPath(z.id));
  }
}
