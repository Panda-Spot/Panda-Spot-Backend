export const FREE_EVENT_LIMIT = 15;
// Decimal GB (1000^3), not GiB (1024^3) — the frontend displays this divided
// by 1e9, so this must be a clean decimal value or it rounds to "11GB".
export const FREE_EVENT_STORAGE_BYTES = 10 * 1000 * 1000 * 1000; // 10GB per event

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
