import { prisma } from "./prisma.js";

/**
 * Create an in-app notification for a user.
 * Fire-and-forget: errors are logged but never thrown so they can't break
 * the caller's flow.
 */
export async function notify(userId, { type, title, message, eventId }) {
  try {
    await prisma.notification.create({
      data: {
        userId,
        type,
        title,
        message: message || null,
        eventId: eventId || null,
      },
    });
  } catch (err) {
    console.error(`Notification create failed (${type}):`, err.message);
  }
}

/**
 * Count unread notifications for a user.
 */
export async function unreadCount(userId) {
  try {
    return await prisma.notification.count({
      where: { userId, readAt: null },
    });
  } catch {
    return 0;
  }
}
