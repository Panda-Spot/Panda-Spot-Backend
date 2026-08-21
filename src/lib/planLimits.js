export const FREE_EVENT_LIMIT = 15;
export const FREE_EVENT_STORAGE_BYTES = 10 * 1024 * 1024 * 1024; // 10GB per event

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
