export const FREE_EVENT_LIMIT = 15;
// Decimal GB (1000^3), not GiB (1024^3) — the frontend displays this divided
// by 1e9, so this must be a clean decimal value or it rounds to "11GB".
export const FREE_EVENT_STORAGE_BYTES = 10 * 1000 * 1000 * 1000; // 10GB per event
// Platform-wide default: how long a photo's full-res original stays on the
// server before lib/photoRetention.js deletes just the file (thumbnail +
// face-search data are never touched) — see that file and schema.prisma's
// Photo.originalExpiresAt comment.
export const DEFAULT_PHOTO_RETENTION_DAYS = 7;

/** This client's effective event-count cap — their admin override if one's
 * set (see routes/admin.js), otherwise the flat free-tier default. */
export function effectiveEventLimit(user) {
  return user?.customEventLimit ?? FREE_EVENT_LIMIT;
}

/** This client's effective per-event storage cap, as a plain Number (byte
 * arithmetic elsewhere assumes a Number, not a BigInt) — their admin
 * override if one's set, otherwise the flat free-tier default. */
export function effectiveStorageLimitBytes(user) {
  return user?.customStorageLimitBytes != null ? Number(user.customStorageLimitBytes) : FREE_EVENT_STORAGE_BYTES;
}

/** This client's effective photo-original retention window in days — their
 * admin override if one's set, otherwise the flat platform default. */
export function effectivePhotoRetentionDays(user) {
  return user?.customPhotoRetentionDays ?? DEFAULT_PHOTO_RETENTION_DAYS;
}

export async function countOwnedEvents(prisma, ownerId) {
  return prisma.event.count({ where: { ownerId } });
}

export async function eventStorageUsedBytes(prisma, eventId) {
  const result = await prisma.photo.aggregate({
    where: { eventId },
    _sum: { fileSize: true },
  });
  return result._sum.fileSize || 0;
}
