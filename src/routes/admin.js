import { Router } from "express";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/admin.js";
import { requireRole } from "../middleware/role.js";
import { bucketByDay } from "../lib/dailyBuckets.js";
import { deleteEventCascade } from "../lib/eventLifecycle.js";
import { ACCESS_MODES, setAccessKey } from "../lib/galleryAccess.js";
import { eraseGuestData, resolveGuestData } from "../lib/facePrivacy.js";
import { deleteFileIfExists, removeEventDir } from "../lib/storage.js";
import { zipDownloadPath } from "../lib/zip.js";
import { deleteFileFromDrive } from "../lib/driveBackup.js";
import { FREE_EVENT_LIMIT, FREE_EVENT_STORAGE_BYTES, DEFAULT_PHOTO_RETENTION_DAYS } from "../lib/planLimits.js";
import { sendEmailVerificationEmail, sendStudioCredentialsEmail } from "../lib/mailer.js";
import { getDriveAccountQuota } from "../lib/driveBackup.js";
import { computePlanExpiry, getPlatformSettings, getActiveSubscription } from "../lib/subscriptionAccess.js";

const PUBLIC_WEB_URL = process.env.PUBLIC_WEB_URL || "http://localhost:5173";

const router = Router();
router.use(requireAuth, requireAdmin);

const PAGE_SIZE_DEFAULT = 25;
const BCRYPT_ROUNDS = 10;
const GENERATED_PASSWORD_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
// Loose format check — mirrors events.js's /clients/invite regex.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parsePage(req) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || PAGE_SIZE_DEFAULT));
  return { page, pageSize, skip: (page - 1) * pageSize };
}

function generateTempPassword() {
  let out = "";
  for (let i = 0; i < 12; i += 1) {
    out += GENERATED_PASSWORD_CHARS[Math.floor(Math.random() * GENERATED_PASSWORD_CHARS.length)];
  }
  return out;
}

function normalizeWatermarkIntensity(value) {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw Object.assign(new Error("watermark_intensity must be between 0 and 1"), { status: 400 });
  }
  return n;
}

function normalizeOptionalFutureDate(value, fieldName) {
  if (value == null || value === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw Object.assign(new Error(`${fieldName} must be a valid date`), { status: 400 });
  }
  if (date <= new Date()) {
    throw Object.assign(new Error(`${fieldName} must be in the future`), { status: 400 });
  }
  return date;
}

function normalizeOptionalDate(value, fieldName) {
  if (value == null || value === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw Object.assign(new Error(`${fieldName} must be a valid date`), { status: 400 });
  }
  return date;
}

function serializeSubscription(sub) {
  if (!sub) return null;
  return {
    id: sub.id,
    plan_id: sub.subscriptionPlanId,
    plan_name: sub.subscriptionPlan?.planName ?? null,
    status: sub.status,
    change_type: sub.changeType,
    locked_price: sub.lockedPrice != null ? Number(sub.lockedPrice) : null,
    is_price_locked: sub.isPriceLocked,
    is_free_grant: sub.isFreeGrant,
    photo_quota_total: sub.photoQuotaTotal,
    photo_quota_used: sub.photoQuotaUsed,
    starts_at: sub.startsAt,
    expires_at: sub.expiresAt,
    grace_ends_at: sub.graceEndsAt,
    is_active: sub.isActive,
    created_at: sub.createdAt,
  };
}

async function requireStudioUser(userId, res) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    res.status(404).json({ error: "Studio not found" });
    return null;
  }
  if (user.role !== "ADMIN") {
    res.status(400).json({ error: "Tenant lifecycle actions are only available for ADMIN studio accounts" });
    return null;
  }
  return user;
}

async function wipeStudioStorage(userId) {
  const events = await prisma.event.findMany({ where: { ownerId: userId }, select: { id: true } });
  const eventIds = events.map((e) => e.id);
  if (eventIds.length === 0) return { deletedCount: 0, eventCount: 0 };

  const [photos, zipDownloads] = await Promise.all([
    prisma.photo.findMany({ where: { eventId: { in: eventIds } } }),
    prisma.zipDownload.findMany({ where: { eventId: { in: eventIds } } }),
  ]);

  for (const photo of photos) {
    await deleteFileIfExists(photo.storagePath);
    await deleteFileIfExists(photo.thumbnailPath);
    if (photo.platformDriveBackup && photo.driveFileId) {
      await deleteFileFromDrive(photo.driveFileId).catch((err) =>
        console.error(`Failed to delete Drive backup file for photo ${photo.id} during storage wipe:`, err.message)
      );
    }
  }
  for (const z of zipDownloads) {
    await deleteFileIfExists(z.filePath || zipDownloadPath(z.id));
  }

  await prisma.$transaction([
    prisma.matchFeedback.deleteMany({ where: { search: { eventId: { in: eventIds } } } }),
    prisma.guestSearch.deleteMany({ where: { eventId: { in: eventIds } } }),
    prisma.face.deleteMany({ where: { eventId: { in: eventIds } } }),
    prisma.photoComment.deleteMany({ where: { eventId: { in: eventIds } } }),
    prisma.photoLike.deleteMany({ where: { eventId: { in: eventIds } } }),
    prisma.clientFavourite.deleteMany({ where: { photo: { eventId: { in: eventIds } } } }),
    prisma.studioFavourite.deleteMany({ where: { photo: { eventId: { in: eventIds } } } }),
    prisma.photo.deleteMany({ where: { eventId: { in: eventIds } } }),
    prisma.zipDownload.deleteMany({ where: { eventId: { in: eventIds } } }),
  ]);

  for (const eventId of eventIds) {
    await removeEventDir(eventId);
  }
  return { deletedCount: photos.length, eventCount: eventIds.length };
}

async function resetStudioWorkspace(user) {
  const events = await prisma.event.findMany({ where: { ownerId: user.id } });
  for (const event of events) {
    await deleteEventCascade(event);
  }

  const supportTickets = await prisma.supportTicket.findMany({
    where: { OR: [{ tenantId: user.id }, { requesterId: user.id }] },
    select: { id: true },
  });
  const supportTicketIds = supportTickets.map((t) => t.id);

  await prisma.$transaction([
    prisma.supportTicketReply.deleteMany({
      where: { OR: [{ authorId: user.id }, { ticketId: { in: supportTicketIds } }] },
    }),
    prisma.supportTicket.deleteMany({ where: { id: { in: supportTicketIds } } }),
    prisma.payment.deleteMany({ where: { OR: [{ tenantId: user.id }, { bill: { tenantId: user.id } }] } }),
    prisma.billItem.deleteMany({ where: { bill: { tenantId: user.id } } }),
    prisma.bill.deleteMany({ where: { tenantId: user.id } }),
    prisma.quotationItem.deleteMany({ where: { quotation: { tenantId: user.id } } }),
    prisma.quotation.deleteMany({ where: { tenantId: user.id } }),
    prisma.studioService.deleteMany({ where: { tenantId: user.id } }),
    prisma.tenantBillingSettings.upsert({
      where: { tenantId: user.id },
      update: {
        nextQuotationNumber: 1,
        nextBillNumber: 1,
        nextReceiptNumber: 1,
        gstinNumber: null,
        gstState: null,
      },
      create: { tenantId: user.id },
    }),
  ]);

  return { eventCount: events.length, supportTicketCount: supportTickets.length };
}

async function findAssignableSubscriptionPlan(planId, res) {
  if (!planId) {
    res.status(400).json({ error: "plan_id is required" });
    return null;
  }
  const plan = await prisma.subscriptionPlan.findUnique({ where: { id: planId } });
  if (!plan || !plan.isActive) {
    res.status(404).json({ error: "Plan not found" });
    return null;
  }
  if (plan.planType !== "SUBSCRIPTION") {
    res.status(400).json({ error: "Only subscription plans can be assigned or granted" });
    return null;
  }
  return plan;
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
    if (err.status) return res.status(err.status).json({ error: err.message });
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
    role: user.role,
    is_suspended: !!user.suspendedAt,
    created_at: user.createdAt,
    event_count: user.events.length,
    photo_count: photoCount,
    storage_used_bytes: storageUsed,
    custom_event_limit: user.customEventLimit,
    custom_storage_limit_bytes: user.customStorageLimitBytes != null ? Number(user.customStorageLimitBytes) : null,
    custom_photo_retention_days: user.customPhotoRetentionDays,
    subscription: serializeSubscription(user.subscriptions?.[0] ?? null),
  };
}

// Every client (photographer) account, searchable by name/email,
// paginated, with usage stats rolled up per user. This is the "browse all
// clients" view — GET /admin/users/:id below is the per-client detail.
router.get("/users", async (req, res, next) => {
  try {
    const { page, pageSize, skip } = parsePage(req);
    const search = (req.query.search || "").trim();
    const role = ["SUPER_ADMIN", "ADMIN", "USER", "INVITED"].includes(req.query.role) ? req.query.role : undefined;
    const status = req.query.status ?? "all";
    if (!["active", "suspended", "all"].includes(status)) {
      return res.status(400).json({ error: 'status must be "active", "suspended", or "all"' });
    }
    const where = {
      ...(role ? { role } : {}),
      ...(status === "active" ? { suspendedAt: null } : status === "suspended" ? { suspendedAt: { not: null } } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: "insensitive" } },
              { email: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
        include: {
          events: { include: { photos: { select: { fileSize: true } } } },
          subscriptions: {
            where: { isActive: true },
            include: { subscriptionPlan: true },
            orderBy: { startsAt: "desc" },
            take: 1,
          },
        },
      }),
    ]);

    res.json({
      total,
      page,
      page_size: pageSize,
      users: users.map(serializeUserRow),
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.post("/users", async (req, res, next) => {
  try {
    const { name, email, password, plan_id: planId, free_access_until: freeAccessUntil } = req.body || {};
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name is required" });
    }
    if (!email || typeof email !== "string" || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: "A valid email is required" });
    }
    if (password != null && (typeof password !== "string" || password.length < 8)) {
      return res.status(400).json({ error: "password must be at least 8 characters" });
    }

    const normalizedEmail = email.toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing) return res.status(409).json({ error: "An account with that email already exists" });

    let plan = null;
    let freeUntil = null;
    if (planId || freeAccessUntil) {
      plan = await findAssignableSubscriptionPlan(planId, res);
      if (!plan) return;
      freeUntil = normalizeOptionalFutureDate(freeAccessUntil, "free_access_until");
      if (!freeUntil) return res.status(400).json({ error: "free_access_until is required when granting a free plan" });
    }

    const generatedPassword = !password;
    const plainPassword = password || generateTempPassword();
    const passwordHash = await bcrypt.hash(plainPassword, BCRYPT_ROUNDS);
    const now = new Date();
    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          name: name.trim(),
          email: normalizedEmail,
          passwordHash,
          role: "ADMIN",
          emailVerifiedAt: now,
        },
      });
      await tx.tenantBillingSettings.create({ data: { tenantId: created.id } });
      if (plan && freeUntil) {
        await tx.tenantSubscription.create({
          data: {
            tenantId: created.id,
            subscriptionPlanId: plan.id,
            status: "ACTIVE",
            changeType: "FREE_GRANT",
            lockedPrice: 0,
            isPriceLocked: false,
            isFreeGrant: true,
            photoQuotaTotal: plan.photoQuota ?? 0,
            startsAt: now,
            expiresAt: freeUntil,
          },
        });
      }
      return created;
    });

    let credentialsEmailSent = false;
    if (generatedPassword) {
      try {
        await sendStudioCredentialsEmail(user.email, user.name, user.email, plainPassword, `${PUBLIC_WEB_URL}/login`);
        credentialsEmailSent = true;
      } catch (err) {
        console.error(`Failed to email generated studio credentials for ${user.id}:`, err.message);
      }
    }

    res.status(201).json({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      generated_password: generatedPassword ? plainPassword : null,
      credentials_email_sent: credentialsEmailSent,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
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
          archived_at: e.archivedAt,
        };
      })
    );

    // MERGE (Studio-Verse Billing & Subscriptions, Phase 14): surfaces the
    // tenant's subscription in the same admin client-detail view Studio-
    // Verse had — informational only, see lib/subscriptionAccess.js's own
    // safety note on why this isn't enforced against uploads yet.
    const [subscription, subscriptionHistory, wallet, aiIndexedPhotoCount] = await Promise.all([
      getActiveSubscription(user.id),
      prisma.tenantSubscription.findMany({
        where: { tenantId: user.id },
        include: { subscriptionPlan: true },
        orderBy: { startsAt: "desc" },
      }),
      prisma.tenantWallet.findUnique({ where: { tenantId: user.id } }),
      prisma.photo.count({
        where: {
          event: { ownerId: user.id },
          faceIndexedAt: { not: null },
        },
      }),
    ]);

    res.json({
      subscription: serializeSubscription(subscription),
      subscription_history: subscriptionHistory.map(serializeSubscription),
      wallet_balance: wallet?.balanceCredits ?? 0,
      ai_indexed_photo_count: aiIndexedPhotoCount,
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      email_verified: !!user.emailVerifiedAt,
      is_suspended: !!user.suspendedAt,
      created_at: user.createdAt,
      studio_name: user.studioName,
      brand_color: user.brandColor,
      watermark_intensity: user.watermarkIntensity ?? 0.75,
      custom_event_limit: user.customEventLimit,
      custom_storage_limit_bytes: user.customStorageLimitBytes != null ? Number(user.customStorageLimitBytes) : null,
      custom_photo_retention_days: user.customPhotoRetentionDays,
      default_event_limit: FREE_EVENT_LIMIT,
      default_storage_limit_bytes: FREE_EVENT_STORAGE_BYTES,
      default_photo_retention_days: DEFAULT_PHOTO_RETENTION_DAYS,
      events,
      collaborates_on: user.collaboratesOn.map((c) => ({
        event_id: c.event.id,
        event_name: c.event.name,
        owner_email: c.event.owner.email,
      })),
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.get("/users/:id/photos", async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: {
        events: { select: { id: true } },
        collaboratesOn: { select: { eventId: true } },
        eventAccess: { select: { eventId: true } },
      },
    });
    if (!user) return res.status(404).json({ error: "User not found" });

    const ownedEventIds = user.events.map((e) => e.id);
    const collabEventIds = user.collaboratesOn.map((c) => c.eventId);
    const clientEventIds = user.eventAccess.map((m) => m.eventId);
    const allEventIds = [...new Set([...ownedEventIds, ...collabEventIds, ...clientEventIds])];

    const photos = await prisma.photo.findMany({
      where: { eventId: { in: allEventIds } },
      orderBy: { createdAt: "desc" },
      take: 300,
      include: {
        event: { select: { id: true, name: true } },
        _count: {
          select: {
            clientFavourites: true,
            studioFavourites: true,
            likes: true,
            comments: true,
          },
        },
      },
    });

    res.json(
      photos.map((p) => ({
        photo_id: p.id,
        event_id: p.eventId,
        event_name: p.event?.name,
        filename: p.filename,
        face_count: p.faceCount,
        created_at: p.createdAt,
        url: `/files/events/${p.eventId}/photos/${p.id}`,
        thumbnail_url: `/files/events/${p.eventId}/photos/${p.id}/thumb`,
        source: p.source || "upload",
        approval_status: p.approvalStatus,
        archived_at: p.archivedAt,
        moderation_flagged: p.moderationFlagged,
        face_search_visible: p.faceSearchVisible,
        photo_selection_visible: p.photoSelectionVisible,
        highlighted: p.highlighted,
        uploaded_by_guest_client_id: p.uploadedByGuestClientId,
        client_favourites_count: p._count.clientFavourites,
        studio_favourites_count: p._count.studioFavourites,
        likes_count: p._count.likes,
        comments_count: p._count.comments,
      }))
    );
  } catch (err) {
    next(err);
  }
});

router.patch("/users/:id/branding", async (req, res, next) => {
  try {
    const user = await requireStudioUser(req.params.id, res);
    if (!user) return;

    const normalizedWatermarkIntensity = normalizeWatermarkIntensity(req.body?.watermark_intensity);
    if (normalizedWatermarkIntensity === undefined) {
      return res.status(400).json({ error: "watermark_intensity is required" });
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { watermarkIntensity: normalizedWatermarkIntensity },
    });

    res.json({
      id: updated.id,
      studio_name: updated.studioName,
      brand_color: updated.brandColor,
      watermark_intensity: updated.watermarkIntensity ?? 0.75,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.post("/users/:id/free-access", async (req, res, next) => {
  try {
    const user = await requireStudioUser(req.params.id, res);
    if (!user) return;
    const { plan_id: planId, expires_at: expiresAt } = req.body || {};
    const plan = await findAssignableSubscriptionPlan(planId, res);
    if (!plan) return;
    const until = normalizeOptionalFutureDate(expiresAt, "expires_at");

    const now = new Date();
    const subscription = await prisma.$transaction(async (tx) => {
      await tx.tenantSubscription.updateMany({
        where: { tenantId: user.id, isActive: true },
        data: { isActive: false, status: "CANCELLED" },
      });
      return tx.tenantSubscription.create({
        data: {
          tenantId: user.id,
          subscriptionPlanId: plan.id,
          status: "ACTIVE",
          changeType: "FREE_GRANT",
          lockedPrice: 0,
          isPriceLocked: false,
          isFreeGrant: true,
          photoQuotaTotal: plan.photoQuota ?? 0,
          photoQuotaUsed: 0,
          startsAt: now,
          expiresAt: until,
        },
        include: { subscriptionPlan: true },
      });
    });

    res.json({ ok: true, subscription: serializeSubscription(subscription) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.delete("/users/:id/free-access", async (req, res, next) => {
  try {
    const user = await requireStudioUser(req.params.id, res);
    if (!user) return;
    const result = await prisma.tenantSubscription.updateMany({
      where: { tenantId: user.id, isActive: true, isFreeGrant: true },
      data: { isActive: false, status: "CANCELLED" },
    });
    if (result.count === 0) return res.status(404).json({ error: "No active free access grant found" });
    res.json({ ok: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.post("/users/:id/plan", async (req, res, next) => {
  try {
    const user = await requireStudioUser(req.params.id, res);
    if (!user) return;
    const { plan_id: planId } = req.body || {};
    const plan = await findAssignableSubscriptionPlan(planId, res);
    if (!plan) return;

    const current = await prisma.tenantSubscription.findFirst({
      where: { tenantId: user.id, isActive: true },
      orderBy: { startsAt: "desc" },
    });
    const now = new Date();
    const subscription = await prisma.$transaction(async (tx) => {
      await tx.tenantSubscription.updateMany({
        where: { tenantId: user.id, isActive: true },
        data: { isActive: false, status: "CANCELLED" },
      });
      return tx.tenantSubscription.create({
        data: {
          tenantId: user.id,
          subscriptionPlanId: plan.id,
          status: "ACTIVE",
          changeType: "ADMIN_SET",
          lockedPrice: null,
          isPriceLocked: false,
          isFreeGrant: false,
          photoQuotaTotal: plan.photoQuota ?? 0,
          photoQuotaUsed: current?.photoQuotaUsed ?? 0,
          startsAt: now,
          expiresAt: computePlanExpiry(plan, now),
        },
        include: { subscriptionPlan: true },
      });
    });

    res.json({ ok: true, subscription: serializeSubscription(subscription) });
  } catch (err) {
    next(err);
  }
});

router.delete("/users/:id/storage", async (req, res, next) => {
  try {
    const user = await requireStudioUser(req.params.id, res);
    if (!user) return;
    const { confirm_email: confirmEmail } = req.body || {};
    if ((confirmEmail || "").trim().toLowerCase() !== user.email.toLowerCase()) {
      return res.status(400).json({ error: "confirm_email must match this studio's exact email address" });
    }

    const result = await wipeStudioStorage(user.id);
    res.json({ ok: true, deleted_photo_count: result.deletedCount, event_count: result.eventCount });
  } catch (err) {
    next(err);
  }
});

router.delete("/users/:id/reset", async (req, res, next) => {
  try {
    const user = await requireStudioUser(req.params.id, res);
    if (!user) return;
    const { confirm_email: confirmEmail } = req.body || {};
    if ((confirmEmail || "").trim().toLowerCase() !== user.email.toLowerCase()) {
      return res.status(400).json({ error: "confirm_email must match this studio's exact email address" });
    }

    const result = await resetStudioWorkspace(user);
    res.json({
      ok: true,
      deleted_event_count: result.eventCount,
      deleted_support_ticket_count: result.supportTicketCount,
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

    const {
      event_limit: eventLimit,
      storage_limit_bytes: storageLimitBytes,
      photo_retention_days: photoRetentionDays,
    } = req.body || {};
    if (eventLimit != null && (!Number.isInteger(eventLimit) || eventLimit < 1)) {
      return res.status(400).json({ error: "event_limit must be a positive integer, or null to reset to default" });
    }
    if (storageLimitBytes != null && (!Number.isFinite(storageLimitBytes) || storageLimitBytes < 1)) {
      return res.status(400).json({ error: "storage_limit_bytes must be a positive number, or null to reset to default" });
    }
    if (photoRetentionDays != null && (!Number.isInteger(photoRetentionDays) || photoRetentionDays < 1)) {
      return res.status(400).json({ error: "photo_retention_days must be a positive integer, or null to reset to default" });
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        customEventLimit: eventLimit ?? null,
        customStorageLimitBytes: storageLimitBytes != null ? BigInt(Math.round(storageLimitBytes)) : null,
        customPhotoRetentionDays: photoRetentionDays ?? null,
      },
    });

    res.json({
      ok: true,
      custom_event_limit: updated.customEventLimit,
      custom_photo_retention_days: updated.customPhotoRetentionDays,
      custom_storage_limit_bytes: updated.customStorageLimitBytes != null ? Number(updated.customStorageLimitBytes) : null,
    });
  } catch (err) {
    next(err);
  }
});

// Support action: sends a fresh verification email on the client's behalf
// (they may have missed/lost the original) — mirrors routes/auth.js's own
// /auth/email-verification/request, just triggerable by an admin.
router.post("/users/:id/resend-verification", async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) return res.status(404).json({ error: "Client not found" });
    if (user.emailVerifiedAt) {
      return res.json({ ok: true, already_verified: true });
    }

    const token = randomBytes(24).toString("base64url");
    await prisma.emailVerificationToken.create({
      data: { userId: user.id, token, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
    });
    await sendEmailVerificationEmail(user.email, `${PUBLIC_WEB_URL}/verify-email/${token}`);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Support action: marks the account verified directly, no email round trip
// — for a client who insists they can't receive the verification email.
router.post("/users/:id/verify", async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) return res.status(404).json({ error: "Client not found" });
    await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// MERGE (Studio-Verse): Super-Admin account-recovery console — unlock a
// lockout-frozen account and force-reset any account's password by email.
// Deliberately gated on role === SUPER_ADMIN, matching Studio-Verse where
// only Super Admin sees the Accounts tab.
router.post("/users/unlock-account", requireRole("SUPER_ADMIN"), async (req, res, next) => {
  try {
    const { email } = req.body || {};
    if (!email || typeof email !== "string") {
      return res.status(400).json({ error: "email is required" });
    }
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user) return res.status(404).json({ error: "No account found for that email" });
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });
    res.json({ ok: true, message: `Account "${user.email}" has been unlocked successfully.` });
  } catch (err) {
    next(err);
  }
});

router.post("/users/reset-password", requireRole("SUPER_ADMIN"), async (req, res, next) => {
  try {
    const { email, new_password: newPassword } = req.body || {};
    if (!email || typeof email !== "string" || !newPassword || typeof newPassword !== "string") {
      return res.status(400).json({ error: "email and new_password are required" });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: "New password must be at least 8 characters" });
    }
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user) return res.status(404).json({ error: "No account found for that email" });
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await bcrypt.hash(newPassword, BCRYPT_ROUNDS),
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });
    res.json({ ok: true, message: `Password for "${user.email}" has been reset successfully.` });
  } catch (err) {
    next(err);
  }
});

// Permanently deletes a user/studio account: every event they own (via the
// same cascade the owner-facing DELETE /events/:id route uses), then every
// user-linked billing/subscription/support row, then the User row itself.
// Irreversible — requires the admin to type the account email back.
router.delete("/users/:id", async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.id }, include: { events: true } });
    if (!user) return res.status(404).json({ error: "Account not found" });

    const { confirm_email: confirmEmail } = req.body || {};
    if ((confirmEmail || "").trim().toLowerCase() !== user.email.toLowerCase()) {
      return res.status(400).json({ error: "confirm_email must match this account's exact email address" });
    }

    for (const event of user.events) {
      await deleteEventCascade(event);
    }

    const supportTickets = await prisma.supportTicket.findMany({
      where: { OR: [{ tenantId: user.id }, { requesterId: user.id }] },
      select: { id: true },
    });
    const supportTicketIds = supportTickets.map((t) => t.id);

    await prisma.$transaction([
      prisma.supportTicketReply.deleteMany({
        where: { OR: [{ authorId: user.id }, { ticketId: { in: supportTicketIds } }] },
      }),
      prisma.supportTicket.deleteMany({ where: { id: { in: supportTicketIds } } }),
      prisma.payment.deleteMany({
        where: { OR: [{ tenantId: user.id }, { bill: { tenantId: user.id } }, { bill: { clientId: user.id } }] },
      }),
      prisma.billItem.deleteMany({
        where: { bill: { OR: [{ tenantId: user.id }, { clientId: user.id }] } },
      }),
      prisma.bill.deleteMany({ where: { OR: [{ tenantId: user.id }, { clientId: user.id }] } }),
      prisma.quotationItem.deleteMany({
        where: { quotation: { OR: [{ tenantId: user.id }, { clientId: user.id }] } },
      }),
      prisma.quotation.deleteMany({ where: { OR: [{ tenantId: user.id }, { clientId: user.id }] } }),
      prisma.studioService.deleteMany({ where: { tenantId: user.id } }),
      prisma.tenantBillingSettings.deleteMany({ where: { tenantId: user.id } }),
      prisma.walletTransaction.deleteMany({ where: { tenantId: user.id } }),
      prisma.tenantWallet.deleteMany({ where: { tenantId: user.id } }),
      prisma.tenantSubscription.deleteMany({ where: { tenantId: user.id } }),
      prisma.clientFavourite.deleteMany({ where: { userId: user.id } }),
      prisma.studioFavourite.deleteMany({ where: { userId: user.id } }),
      prisma.eventUserMapping.deleteMany({ where: { userId: user.id } }),
      prisma.eventCollaborator.deleteMany({ where: { userId: user.id } }),
      prisma.eventInvite.deleteMany({ where: { email: { equals: user.email, mode: "insensitive" } } }),
      prisma.clientInvite.deleteMany({ where: { email: { equals: user.email, mode: "insensitive" } } }),
      prisma.emailVerificationToken.deleteMany({ where: { userId: user.id } }),
      prisma.passwordResetToken.deleteMany({ where: { userId: user.id } }),
      prisma.user.delete({ where: { id: user.id } }),
    ]);

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
    // MERGE (Studio-Verse archive visibility, Phase 18G): platform-wide the
    // default is `all` (an admin sees everything); the studio Dashboard
    // defaults to active-only instead. Same three-way filter vocabulary.
    const status = req.query.status ?? "all";
    if (!["active", "archived", "all"].includes(status)) {
      return res.status(400).json({ error: 'status must be "active", "archived", or "all"' });
    }
    const archivedFilter =
      status === "active" ? { archivedAt: null } : status === "archived" ? { archivedAt: { not: null } } : {};
    const where = { ...archivedFilter };
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { owner: { email: { contains: search, mode: "insensitive" } } },
      ];
    }

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
        archived_at: e.archivedAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Full detail for any event, regardless of ownership — deliberately bypasses
// loadAccessibleEvent's owner-or-collaborator check, since an admin needs to
// be able to look at (and act on) any event on the platform.
router.get("/events/:id", async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({
      where: { id: req.params.id },
      include: {
        owner: true,
        collaborators: { include: { user: true } },
        _count: { select: { photos: true, albums: true } },
      },
    });
    if (!event) return res.status(404).json({ error: "Event not found" });

    const storageAgg = await prisma.photo.aggregate({ where: { eventId: event.id }, _sum: { fileSize: true } });
    const sourceCounts = await prisma.photo.groupBy({
      by: ["source"],
      where: { eventId: event.id },
      _count: true,
    });
    const photoSourceCounts = { upload: 0, shoots: 0, drive_import: 0 };
    for (const row of sourceCounts) {
      photoSourceCounts[row.source] = row._count;
    }

    res.json({
      id: event.id,
      name: event.name,
      guest_slug: event.guestSlug,
      owner: { id: event.owner.id, name: event.owner.name, email: event.owner.email },
      photo_count: event._count.photos,
      album_count: event._count.albums,
      photo_source_counts: photoSourceCounts,
      storage_used_bytes: storageAgg._sum.fileSize || 0,
      created_at: event.createdAt,
      expires_at: event.expiresAt,
      started: !!event.startedAt,
      require_face_search_consent: event.requireFaceSearchConsent,
      privacy_notice_text: event.privacyNoticeText,
      selfie_retention_mode: event.selfieRetentionMode,
      guest_data_retention_days: event.guestDataRetentionDays,
      allow_guest_data_delete_request: event.allowGuestDataDeleteRequest,
      access_mode: event.accessMode,
      access_key_set: !!event.accessKeyHash,
      expires_at: event.expiresAt,
      expiry_preset: event.expiryPreset,
      tv_mode: event.tvMode,
      tv_transition_ms: event.tvTransitionMs,
      tv_show_qr: event.tvShowQr,
      sponsor_name: event.sponsorName,      drive_folder_url: event.driveFolderUrl,
      drive_sync_enabled: event.driveSyncEnabled,
      shoots_connected: !!event.ftpUsername,
      drive_backup_enabled: event.driveBackupEnabled,
      collaborators: event.collaborators.map((c) => ({ id: c.user.id, name: c.user.name, email: c.user.email })),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/events/:id/photos", async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { id: req.params.id } });
    if (!event) return res.status(404).json({ error: "Event not found" });

    const photos = await prisma.photo.findMany({
      where: { eventId: event.id },
      orderBy: { createdAt: "desc" },
      include: {
        _count: {
          select: {
            clientFavourites: true,
            studioFavourites: true,
            likes: true,
            comments: true,
          },
        },
      },
    });

    res.json(
      photos.map((p) => ({
        photo_id: p.id,
        event_id: p.eventId,
        filename: p.filename,
        face_count: p.faceCount,
        file_size: p.fileSize,
        created_at: p.createdAt,
        url: `/files/events/${event.id}/photos/${p.id}`,
        thumbnail_url: `/files/events/${event.id}/photos/${p.id}/thumb`,
        source: p.source || "upload",
        approval_status: p.approvalStatus,
        archived_at: p.archivedAt,
        moderation_flagged: p.moderationFlagged,
        face_search_visible: p.faceSearchVisible,
        photo_selection_visible: p.photoSelectionVisible,
        highlighted: p.highlighted,
        uploaded_by_guest_client_id: p.uploadedByGuestClientId,
        client_favourites_count: p._count.clientFavourites,
        studio_favourites_count: p._count.studioFavourites,
        likes_count: p._count.likes,
        comments_count: p._count.comments,
      }))
    );
  } catch (err) {
    next(err);
  }
});

// MERGE (Album proofing, Phase 23): platform support sees every album on
// an event — version count, latest version, open pins — for abuse/billing
// triage. Read-only; status changes go through the SUPER_ADMIN override.
router.get("/events/:id/albums", async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { id: req.params.id } });
    if (!event) return res.status(404).json({ error: "Event not found" });
    const albums = await prisma.album.findMany({
      where: { eventId: event.id },
      include: {
        versions: { select: { id: true, versionNumber: true, printPdfPath: true, _count: { select: { pages: true } } } },
      },
      orderBy: { updatedAt: "desc" },
    });
    res.json(
      await Promise.all(
        albums.map(async (a) => ({
          album_id: a.id,
          name: a.name,
          status: a.status,
          locked_at: a.lockedAt,
          updated_at: a.updatedAt,
          version_count: a.versions.length,
          latest_version: a.versions.length ? Math.max(...a.versions.map((v) => v.versionNumber)) : null,
          page_count_latest: (() => {
            if (!a.versions.length) return 0;
            const latest = a.versions.reduce((x, y) => (x.versionNumber >= y.versionNumber ? x : y));
            return latest._count.pages;
          })(),
          open_pins: await prisma.albumComment.count({
            where: { version: { albumId: a.id }, parentId: null, pinNumber: { not: null }, resolvedAt: null },
          }),
        }))
      )
    );
  } catch (err) {
    next(err);
  }
});

// SUPER_ADMIN escape hatch: force any album status (e.g. unlock an
// APPROVED album for a studio that can't be reached). Leaving APPROVED
// clears lockedAt; entering APPROVED stamps it.
router.post("/events/:id/albums/:albumId/status", requireRole("SUPER_ADMIN"), async (req, res, next) => {
  try {
    const { status } = req.body || {};
    if (!["DRAFT", "SENT", "CHANGES_REQUESTED", "APPROVED"].includes(status)) {
      return res.status(400).json({ error: "status must be DRAFT, SENT, CHANGES_REQUESTED or APPROVED" });
    }
    const album = await prisma.album.findFirst({
      where: { id: req.params.albumId, eventId: req.params.id },
    });
    if (!album) return res.status(404).json({ error: "Album not found" });
    const updated = await prisma.album.update({
      where: { id: album.id },
      data: { status, lockedAt: status === "APPROVED" ? album.lockedAt || new Date() : null },
    });
    res.json({ album_id: updated.id, status: updated.status, locked_at: updated.lockedAt });
  } catch (err) {
    next(err);
  }
});

// Phase 2 (guest data rights): review queue for export/delete requests.
// ?status=pending (default) | completed | rejected | all. Read-only;
// resolving happens below.
router.get("/events/:id/data-requests", async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { id: req.params.id } });
    if (!event) return res.status(404).json({ error: "Event not found" });
    const status = req.query.status ?? "pending";
    if (!["pending", "completed", "rejected", "all"].includes(status)) {
      return res.status(400).json({ error: 'status must be "pending", "completed", "rejected" or "all"' });
    }
    const requests = await prisma.guestDataRequest.findMany({
      where: { eventId: event.id, ...(status === "all" ? {} : { status }) },
      orderBy: { createdAt: "desc" },
    });
    res.json(
      requests.map((r) => ({
        request_id: r.id,
        guest_client_id: r.guestClientId,
        contact: r.contact,
        type: r.type,
        status: r.status,
        created_at: r.createdAt,
        resolved_at: r.resolvedAt,
      }))
    );
  } catch (err) {
    next(err);
  }
});

// Resolve one request. complete+delete erases the guest's footprint and
// returns the counts; complete+export returns the guest's data payload so
// the admin can send it; reject closes without action. Pending only.
router.post("/events/:id/data-requests/:requestId", async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { id: req.params.id } });
    if (!event) return res.status(404).json({ error: "Event not found" });
    const { action } = req.body || {};
    if (action !== "complete" && action !== "reject") {
      return res.status(400).json({ error: 'action must be "complete" or "reject"' });
    }
    const request = await prisma.guestDataRequest.findFirst({
      where: { id: req.params.requestId, eventId: event.id },
    });
    if (!request) return res.status(404).json({ error: "Request not found" });
    if (request.status !== "pending") {
      return res.status(409).json({ error: `Request is already ${request.status}` });
    }
    let result = null;
    if (action === "complete") {
      if (request.type === "delete") {
        result = await eraseGuestData(event.id, request.guestClientId);
      } else {
        result = await resolveGuestData(event.id, request.guestClientId);
      }
    }
    const updated = await prisma.guestDataRequest.update({
      where: { id: request.id },
      data: { status: action === "complete" ? "completed" : "rejected", resolvedAt: new Date() },
    });
    res.json({ request_id: updated.id, status: updated.status, resolved_at: updated.resolvedAt, result });
  } catch (err) {
    next(err);
  }
});

router.delete("/events/:id", async (req, res, next) => {  try {
    const event = await prisma.event.findUnique({ where: { id: req.params.id } });
    if (!event) return res.status(404).json({ error: "Event not found" });
    await deleteEventCascade(event);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.post("/events/:id/expiry", async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { id: req.params.id } });
    if (!event) return res.status(404).json({ error: "Event not found" });

    const expiresAt = new Date(req.body?.expires_at);
    if (Number.isNaN(expiresAt.getTime())) {
      return res.status(400).json({ error: "expires_at must be a valid date" });
    }

    await prisma.event.update({ where: { id: event.id }, data: { expiresAt } });
    res.json({ ok: true, expires_at: expiresAt });
  } catch (err) {
    next(err);
  }
});

// Phase 3 (gallery access upgrade): platform-level access override —
// mode, key (plaintext in, bcrypt hash stored), expiry date + preset.
// Same validation as the studio PATCH; private_key still needs a key.
router.post("/events/:id/access", async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { id: req.params.id } });
    if (!event) return res.status(404).json({ error: "Event not found" });
    const { access_mode: accessMode, access_key: accessKey, expires_at: expiresAt, expiry_preset: expiryPreset } = req.body || {};
    const data = {};
    if (accessMode !== undefined) {
      if (!ACCESS_MODES.includes(accessMode)) {
        return res.status(400).json({ error: `access_mode must be one of ${ACCESS_MODES.join(", ")}` });
      }
      data.accessMode = accessMode;
    }
    if (expiryPreset !== undefined) {
      if (!["7_days", "30_days", "90_days", "custom"].includes(expiryPreset)) {
        return res.status(400).json({ error: 'expiry_preset must be "7_days", "30_days", "90_days" or "custom"' });
      }
      data.expiryPreset = expiryPreset;
    }
    if (expiresAt !== undefined) {
      const d = new Date(expiresAt);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({ error: "expires_at must be a valid date" });
      }
      data.expiresAt = d;
    }
    let keyHash = event.accessKeyHash;
    if (accessKey !== undefined) {
      if (accessKey === null || accessKey === "") {
        data.accessKeyHash = null;
        keyHash = null;
      } else {
        try {
          await setAccessKey(event.id, accessKey);
          keyHash = true;
        } catch (err) {
          return res.status(err.status || 400).json({ error: err.message });
        }
      }
    }
    const finalMode = data.accessMode ?? event.accessMode ?? "public";
    if (finalMode === "private_key" && !keyHash) {
      return res.status(400).json({ error: "Set an access key before switching to private-key mode." });
    }
    const updated = await prisma.event.update({ where: { id: event.id }, data });
    res.json({
      ok: true,
      access_mode: updated.accessMode,
      access_key_set: !!updated.accessKeyHash,
      expires_at: updated.expiresAt,
      expiry_preset: updated.expiryPreset,
    });
  } catch (err) {
    next(err);
  }
});

// Kill switch, independent of suspending the whole client account — same
// effect as the owner's own "Turn off camera upload" in routes/events.js.
router.post("/events/:id/disable-shoots", async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { id: req.params.id } });
    if (!event) return res.status(404).json({ error: "Event not found" });
    await prisma.event.update({ where: { id: event.id }, data: { ftpUsername: null, ftpPassword: null } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/events/:id/disable-drive-backup", async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { id: req.params.id } });
    if (!event) return res.status(404).json({ error: "Event not found" });
    await prisma.event.update({ where: { id: event.id }, data: { driveBackupEnabled: false } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// One consolidated payload for the full platform metrics page — guest
// engagement, feature adoption, a top-clients leaderboard, and the
// platform's own Drive-backup account quota health.
router.get("/metrics", async (req, res, next) => {
  try {
    const [totalSearches, searchesWithMatches, totalFeedback, matchCountAgg, totalGuestClientIds] = await Promise.all([
      prisma.guestSearch.count(),
      prisma.guestSearch.count({ where: { matchCount: { gt: 0 } } }),
      prisma.matchFeedback.count(),
      prisma.guestSearch.aggregate({ _sum: { matchCount: true } }),
      prisma.guestSearch.findMany({ where: { guestClientId: { not: null } }, distinct: ["guestClientId"], select: { guestClientId: true } }),
    ]);
    const totalMatchesShown = matchCountAgg._sum.matchCount || 0;

    const [driveImportCount, driveSyncOnCount, shootsConnectedCount, driveBackupOnCount, activeAlertSubs] = await Promise.all([
      prisma.event.count({ where: { driveFolderId: { not: null } } }),
      prisma.event.count({ where: { driveSyncEnabled: true } }),
      prisma.event.count({ where: { ftpUsername: { not: null } } }),
      prisma.event.count({ where: { driveBackupEnabled: true } }),
      prisma.guestAlertSubscription.count({ where: { active: true } }),
    ]);

    const sort = ["storage", "events", "photos"].includes(req.query.sort) ? req.query.sort : "storage";
    const allUsers = await prisma.user.findMany({
      include: { events: { include: { photos: { select: { fileSize: true } } } } },
    });
    const rankedUsers = allUsers
      .map(serializeUserRow)
      .sort((a, b) => {
        if (sort === "events") return b.event_count - a.event_count;
        if (sort === "photos") return b.photo_count - a.photo_count;
        return b.storage_used_bytes - a.storage_used_bytes;
      })
      .slice(0, 10);

    const driveQuota = await getDriveAccountQuota();

    // MERGE (Studio-Verse storage analytics, Phase 18G): top events by
    // bytes for the platform "Storage by Event" chart. Aggregated from the
    // same fileSize source the per-user rollups use — no new tracking.
    const storageByEventRows = await prisma.photo.groupBy({
      by: ["eventId"],
      _sum: { fileSize: true },
      _count: { eventId: true },
      orderBy: { _sum: { fileSize: "desc" } },
      take: 8,
    });
    const storageByEventEvents = await prisma.event.findMany({
      where: { id: { in: storageByEventRows.map((r) => r.eventId) } },
      include: { owner: { select: { email: true } } },
    });
    const eventById = Object.fromEntries(storageByEventEvents.map((e) => [e.id, e]));

    res.json({
      guest_engagement: {
        total_searches: totalSearches,
        unique_guests: totalGuestClientIds.length,
        searches_with_matches: searchesWithMatches,
        match_rate: totalSearches > 0 ? searchesWithMatches / totalSearches : 0,
        total_feedback: totalFeedback,
        feedback_rate: totalMatchesShown > 0 ? totalFeedback / totalMatchesShown : 0,
      },
      feature_adoption: {
        drive_import_connected: driveImportCount,
        drive_sync_enabled: driveSyncOnCount,
        shoots_connected: shootsConnectedCount,
        drive_backup_enabled: driveBackupOnCount,
        active_guest_alert_subscriptions: activeAlertSubs,
      },
      storage_by_event: storageByEventRows.map((r) => ({
        event_id: r.eventId,
        event_name: eventById[r.eventId]?.name ?? "(deleted event)",
        owner_email: eventById[r.eventId]?.owner.email ?? "—",
        storage_used_bytes: r._sum.fileSize || 0,
        photo_count: r._count.eventId,
      })),
      top_clients: { sort, users: rankedUsers },
      drive_backup_quota: driveQuota,
    });
  } catch (err) {
    next(err);
  }
});

// --- Subscription plan catalog (MERGE: Studio-Verse Billing &
// Subscriptions, Phase 12) — platform-wide, so it lives in the existing
// admin router rather than a new one. ---

router.get("/plans", async (req, res, next) => {
  try {
    const plans = await prisma.subscriptionPlan.findMany({ orderBy: { displayOrder: "asc" } });
    res.json(plans);
  } catch (err) {
    next(err);
  }
});

router.post("/plans", async (req, res, next) => {
  try {
    const {
      plan_name: planName,
      plan_type: planType,
      duration_value: durationValue,
      duration_unit: durationUnit,
      photo_quota: photoQuota,
      price,
      wallet_credits: walletCredits,
      wallet_tier: walletTier,
      ai_credit_cost_per_photo: aiCreditCostPerPhoto,
      includes_ai_media: includesAiMedia,
      special_access_cutoff_date: specialAccessCutoffDate,
      display_order: displayOrder,
    } = req.body || {};
    if (!planName || !["SUBSCRIPTION", "WALLET"].includes(planType) || price == null) {
      return res.status(400).json({ error: "plan_name, plan_type (SUBSCRIPTION|WALLET), and price are required" });
    }
    if (typeof price !== "number" || !(price >= 0)) {
      return res.status(400).json({ error: "price must be a non-negative number" });
    }
    // MERGE (Phase 15 security/robustness review): a SUBSCRIPTION plan
    // missing duration/photoQuota, or a WALLET plan missing
    // walletCredits/walletTier, isn't a security hole but would 500 later
    // inside subscribeToPlan/rechargeWallet (e.g. `increment: null`) —
    // validate the type-specific required fields up front instead.
    if (planType === "SUBSCRIPTION" && (!durationValue || !["DAYS", "MONTHS", "YEARS"].includes(durationUnit) || photoQuota == null)) {
      return res.status(400).json({ error: "SUBSCRIPTION plans require duration_value, duration_unit (DAYS|MONTHS|YEARS), and photo_quota" });
    }
    if (planType === "SUBSCRIPTION" && (durationValue != null && !(durationValue > 0))) {
      return res.status(400).json({ error: "duration_value must be positive" });
    }
    if (planType === "SUBSCRIPTION" && (photoQuota != null && !(photoQuota >= 0))) {
      return res.status(400).json({ error: "photo_quota must be a non-negative number" });
    }
    if (planType === "WALLET" && (!walletCredits || !["INITIAL", "TOPUP"].includes(walletTier))) {
      return res.status(400).json({ error: "WALLET plans require wallet_credits and wallet_tier (INITIAL|TOPUP)" });
    }
    if (planType === "WALLET" && (walletCredits != null && !(walletCredits >= 0))) {
      return res.status(400).json({ error: "wallet_credits must be a non-negative number" });
    }
    const plan = await prisma.subscriptionPlan.create({
      data: {
        planName,
        planType,
        durationValue: durationValue ?? null,
        durationUnit: durationUnit ?? null,
        photoQuota: photoQuota ?? null,
        price,
        walletCredits: walletCredits ?? null,
        walletTier: walletTier ?? null,
        aiCreditCostPerPhoto: aiCreditCostPerPhoto ?? null,
        includesAiMedia: !!includesAiMedia,
        specialAccessCutoffDate: normalizeOptionalDate(specialAccessCutoffDate, "special_access_cutoff_date"),
        displayOrder: displayOrder ?? 0,
      },
    });
    res.status(201).json(plan);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.patch("/plans/:id", async (req, res, next) => {
  try {
    const plan = await prisma.subscriptionPlan.findUnique({ where: { id: req.params.id } });
    if (!plan) return res.status(404).json({ error: "Plan not found" });
    const {
      plan_name: planName,
      duration_value: durationValue,
      duration_unit: durationUnit,
      photo_quota: photoQuota,
      price,
      wallet_credits: walletCredits,
      wallet_tier: walletTier,
      ai_credit_cost_per_photo: aiCreditCostPerPhoto,
      includes_ai_media: includesAiMedia,
      special_access_cutoff_date: specialAccessCutoffDate,
      is_active: isActive,
      display_order: displayOrder,
    } = req.body || {};
    if (price !== undefined && price !== null && (typeof price !== "number" || !(price >= 0))) {
      return res.status(400).json({ error: "price must be a non-negative number" });
    }
    const data = {
      planName: planName ?? undefined,
      durationValue: durationValue ?? undefined,
      durationUnit: durationUnit ?? undefined,
      photoQuota: photoQuota ?? undefined,
      price: price ?? undefined,
      walletCredits: walletCredits ?? undefined,
      walletTier: walletTier ?? undefined,
      aiCreditCostPerPhoto: aiCreditCostPerPhoto ?? undefined,
      includesAiMedia: includesAiMedia ?? undefined,
      isActive: isActive ?? undefined,
      displayOrder: displayOrder ?? undefined,
    };
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "special_access_cutoff_date")) {
      data.specialAccessCutoffDate = normalizeOptionalDate(specialAccessCutoffDate, "special_access_cutoff_date");
    }
    const updated = await prisma.subscriptionPlan.update({
      where: { id: plan.id },
      data,
    });
    res.json(updated);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// --- Platform trial/grace settings (MERGE: Studio-Verse) ---

router.get("/platform-settings", async (req, res, next) => {
  try {
    res.json(await getPlatformSettings());
  } catch (err) {
    next(err);
  }
});

router.patch("/platform-settings", async (req, res, next) => {
  try {
    const { trial_duration_days, trial_photo_quota, monthly_grace_days, yearly_grace_days, free_access_enabled: freeAccessEnabled } = req.body || {};
    for (const [key, value] of Object.entries({
      trial_duration_days, trial_photo_quota, monthly_grace_days, yearly_grace_days,
    })) {
      if (value !== undefined && value !== null && (!Number.isInteger(value) || value < 1)) {
        return res.status(400).json({ error: `${key} must be a positive integer` });
      }
    }
    if (freeAccessEnabled !== undefined && freeAccessEnabled !== null && typeof freeAccessEnabled !== "boolean") {
      return res.status(400).json({ error: "free_access_enabled must be a boolean" });
    }
    const updated = await prisma.platformSettings.upsert({
      where: { id: "singleton" },
      update: {
        trialDurationDays: trial_duration_days ?? undefined,
        trialPhotoQuota: trial_photo_quota ?? undefined,
        monthlyGraceDays: monthly_grace_days ?? undefined,
        yearlyGraceDays: yearly_grace_days ?? undefined,
        freeAccessEnabled: freeAccessEnabled ?? undefined,
      },
      create: { id: "singleton", freeAccessEnabled: freeAccessEnabled ?? true },
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

export default router;
