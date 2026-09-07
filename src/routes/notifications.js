import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

// List notifications for the current user, newest first.
// Query: ?unread=true (only unread), ?limit=N (default 50)
router.get("/", async (req, res, next) => {
  try {
    const { unread, limit: limitStr } = req.query || {};
    const take = Math.min(Math.max(Number(limitStr) || 50, 1), 200);
    const where = { userId: req.user.id };
    if (unread === "true") where.readAt = null;

    const rows = await prisma.notification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take,
      include: { event: { select: { id: true, name: true } } },
    });

    const unreadN = await prisma.notification.count({
      where: { userId: req.user.id, readAt: null },
    });

    res.json({ unread_count: unreadN, notifications: rows });
  } catch (err) {
    next(err);
  }
});

// Unread count only (lightweight poll).
router.get("/unread-count", async (req, res, next) => {
  try {
    const count = await prisma.notification.count({
      where: { userId: req.user.id, readAt: null },
    });
    res.json({ unread_count: count });
  } catch (err) {
    next(err);
  }
});

// Mark one notification as read.
router.post("/:id/read", async (req, res, next) => {
  try {
    await prisma.notification.updateMany({
      where: { id: req.params.id, userId: req.user.id, readAt: null },
      data: { readAt: new Date() },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Mark all notifications as read.
router.post("/read-all", async (req, res, next) => {
  try {
    await prisma.notification.updateMany({
      where: { userId: req.user.id, readAt: null },
      data: { readAt: new Date() },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
