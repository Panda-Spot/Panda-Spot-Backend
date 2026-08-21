import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/admin.js";

const router = Router();
router.use(requireAuth, requireAdmin);

router.get("/overview", async (req, res, next) => {
  try {
    const [totalUsers, totalEvents, totalPhotos, storageAgg, totalSearches, recentEventRows] = await Promise.all([
      prisma.user.count(),
      prisma.event.count(),
      prisma.photo.count(),
      prisma.photo.aggregate({ _sum: { fileSize: true } }),
      prisma.guestSearch.count(),
      prisma.event.findMany({
        orderBy: { createdAt: "desc" },
        take: 20,
        include: { owner: true, _count: { select: { photos: true } } },
      }),
    ]);

    res.json({
      total_users: totalUsers,
      total_events: totalEvents,
      total_photos: totalPhotos,
      total_storage_bytes: storageAgg._sum.fileSize || 0,
      total_searches: totalSearches,
      recent_events: recentEventRows.map((e) => ({
        id: e.id,
        name: e.name,
        owner_email: e.owner.email,
        photo_count: e._count.photos,
        created_at: e.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
