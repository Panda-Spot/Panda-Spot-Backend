import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/admin.js";
import { bucketByDay } from "../lib/dailyBuckets.js";
import { deleteEventCascade } from "../lib/eventLifecycle.js";
import { FREE_EVENT_LIMIT, FREE_EVENT_STORAGE_BYTES } from "../lib/planLimits.js";

const router = Router();
router.use(requireAuth, requireAdmin);

const PAGE_SIZE_DEFAULT = 25;

function parsePage(req) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || PAGE_SIZE_DEFAULT));
  return { page, pageSize, skip: (page - 1) * pageSize };
}

router.get("/overview", async (req, res, next) => {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [totalUsers, totalEvents, totalPhotos, storageAgg, totalSearches, recentEventRows, recentUsers, recentEvents] =
      await Promise.all([
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
        prisma.user.findMany({ where: { createdAt: { gte: thirtyDaysAgo } }, select: { createdAt: true } }),
        prisma.event.findMany({ where: { createdAt: { gte: thirtyDaysAgo } }, select: { createdAt: true } }),
      ]);

    res.json({
      total_users: totalUsers,
      total_events: totalEvents,
      total_photos: totalPhotos,
      total_storage_bytes: storageAgg._sum.fileSize || 0,
      total_searches: totalSearches,
      daily_signups: bucketByDay(recentUsers.map((u) => u.createdAt)),
      daily_events: bucketByDay(recentEvents.map((e) => e.createdAt)),
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

function serializeUserRow(user) {
  const storageUsed = user.events.reduce(
    (sum, e) => sum + e.photos.reduce((s, p) => s + p.fileSize, 0),
    0
  );
  const photoCount = user.events.reduce((sum, e) => sum + e.photos.length, 0);
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    email_verified: !!user.emailVerifiedAt,
    is_suspended: !!user.suspendedAt,
    created_at: user.createdAt,
    event_count: user.events.length,
    photo_count: photoCount,
    storage_used_bytes: storageUsed,
    custom_event_limit: user.customEventLimit,
    custom_storage_limit_bytes: user.customStorageLimitBytes != null ? Number(user.customStorageLimitBytes) : null,
  };
}

// Every client (photographer) account, searchable by name/email,
// paginated, with usage stats rolled up per user. This is the "browse all
// clients" view — GET /admin/users/:id below is the per-client detail.
router.get("/users", async (req, res, next) => {
  try {
    const { page, pageSize, skip } = parsePage(req);
    const search = (req.query.search || "").trim();
    const where = search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" } },
            { email: { contains: search, mode: "insensitive" } },
          ],
        }
      : {};

    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
        include: { events: { include: { photos: { select: { fileSize: true } } } } },
      }),
    ]);

    res.json({
      total,
      page,
      page_size: pageSize,
      users: users.map(serializeUserRow),
    });
  } catch (err) {
    next(err);
  }
});

// One client's full profile + every event they own + collaborator
// memberships elsewhere — the detail view behind "View" on the clients table.
router.get("/users/:id", async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: {
        events: { include: { _count: { select: { photos: true } } }, orderBy: { createdAt: "desc" } },
        collaboratesOn: { include: { event: { include: { owner: true } } } },
      },
    });
    if (!user) {
      return res.status(404).json({ error: "Client not found" });
    }

    const events = await Promise.all(
      user.events.map(async (e) => {
        const storageAgg = await prisma.photo.aggregate({ where: { eventId: e.id }, _sum: { fileSize: true } });
        return {
          id: e.id,
          name: e.name,
          guest_slug: e.guestSlug,
          photo_count: e._count.photos,
          storage_used_bytes: storageAgg._sum.fileSize || 0,
          created_at: e.createdAt,
          expires_at: e.expiresAt,
        };
      })
    );

    res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      email_verified: !!user.emailVerifiedAt,
      is_suspended: !!user.suspendedAt,
      created_at: user.createdAt,
      custom_event_limit: user.customEventLimit,
      custom_storage_limit_bytes: user.customStorageLimitBytes != null ? Number(user.customStorageLimitBytes) : null,
      default_event_limit: FREE_EVENT_LIMIT,
      default_storage_limit_bytes: FREE_EVENT_STORAGE_BYTES,
      events,
      collaborates_on: user.collaboratesOn.map((c) => ({
        event_id: c.event.id,
        event_name: c.event.name,
        owner_email: c.event.owner.email,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/users/:id/suspend", async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) return res.status(404).json({ error: "Client not found" });
    await prisma.user.update({ where: { id: user.id }, data: { suspendedAt: new Date() } });
    res.json({ ok: true, is_suspended: true });
  } catch (err) {
    next(err);
  }
});

router.post("/users/:id/unsuspend", async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) return res.status(404).json({ error: "Client not found" });
    await prisma.user.update({ where: { id: user.id }, data: { suspendedAt: null } });
    res.json({ ok: true, is_suspended: false });
  } catch (err) {
    next(err);
  }
});

// Sets (or clears, if a value is null) this client's per-account override of
// the global free-tier defaults — see lib/planLimits.js's
// effectiveEventLimit/effectiveStorageLimitBytes, which every event-creation
// and storage-cap check now resolves against instead of the flat constants.
router.post("/users/:id/limits", async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) return res.status(404).json({ error: "Client not found" });

    const { event_limit: eventLimit, storage_limit_bytes: storageLimitBytes } = req.body || {};
    if (eventLimit != null && (!Number.isInteger(eventLimit) || eventLimit < 1)) {
      return res.status(400).json({ error: "event_limit must be a positive integer, or null to reset to default" });
    }
    if (storageLimitBytes != null && (!Number.isFinite(storageLimitBytes) || storageLimitBytes < 1)) {
      return res.status(400).json({ error: "storage_limit_bytes must be a positive number, or null to reset to default" });
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        customEventLimit: eventLimit ?? null,
        customStorageLimitBytes: storageLimitBytes != null ? BigInt(Math.round(storageLimitBytes)) : null,
      },
    });

    res.json({
      ok: true,
      custom_event_limit: updated.customEventLimit,
      custom_storage_limit_bytes: updated.customStorageLimitBytes != null ? Number(updated.customStorageLimitBytes) : null,
    });
  } catch (err) {
    next(err);
  }
});

// Permanently deletes a client account: every event they own (via the same
// cascade the owner-facing DELETE /events/:id route uses), their
// collaborator memberships/sent invites/tokens elsewhere, then the User row
// itself. Irreversible — requires the admin to type the client's own email
// back as confirmation, not just a generic confirm dialog.
router.delete("/users/:id", async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.id }, include: { events: true } });
    if (!user) return res.status(404).json({ error: "Client not found" });

    const { confirm_email: confirmEmail } = req.body || {};
    if ((confirmEmail || "").trim().toLowerCase() !== user.email.toLowerCase()) {
      return res.status(400).json({ error: "confirm_email must match this client's exact email address" });
    }

    for (const event of user.events) {
      await deleteEventCascade(event);
    }

    await prisma.eventCollaborator.deleteMany({ where: { userId: user.id } });
    await prisma.eventInvite.deleteMany({ where: { email: { equals: user.email, mode: "insensitive" } } });
    await prisma.emailVerificationToken.deleteMany({ where: { userId: user.id } });
    await prisma.passwordResetToken.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Full paginated/searchable event list (by event name or owner email) —
// supersedes the overview's flat 20-row recent_events for actual browsing.
router.get("/events", async (req, res, next) => {
  try {
    const { page, pageSize, skip } = parsePage(req);
    const search = (req.query.search || "").trim();
    const where = search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" } },
            { owner: { email: { contains: search, mode: "insensitive" } } },
          ],
        }
      : {};

    const [total, events] = await Promise.all([
      prisma.event.count({ where }),
      prisma.event.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
        include: { owner: true, _count: { select: { photos: true } } },
      }),
    ]);

    res.json({
      total,
      page,
      page_size: pageSize,
      events: events.map((e) => ({
        id: e.id,
        name: e.name,
        owner_email: e.owner.email,
        owner_id: e.ownerId,
        photo_count: e._count.photos,
        created_at: e.createdAt,
        expires_at: e.expiresAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
