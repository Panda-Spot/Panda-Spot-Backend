import { Router } from "express";
import { randomBytes } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/admin.js";
import { bucketByDay } from "../lib/dailyBuckets.js";
import { deleteEventCascade } from "../lib/eventLifecycle.js";
import { FREE_EVENT_LIMIT, FREE_EVENT_STORAGE_BYTES, DEFAULT_PHOTO_RETENTION_DAYS } from "../lib/planLimits.js";
import { sendEmailVerificationEmail } from "../lib/mailer.js";
import { getDriveAccountQuota } from "../lib/driveBackup.js";
import { getPlatformSettings, getActiveSubscription } from "../lib/subscriptionAccess.js";

const PUBLIC_WEB_URL = process.env.PUBLIC_WEB_URL || "http://localhost:5173";

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
    custom_photo_retention_days: user.customPhotoRetentionDays,
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

    // MERGE (Studio-Verse Billing & Subscriptions, Phase 14): surfaces the
    // tenant's subscription in the same admin client-detail view Studio-
    // Verse had — informational only, see lib/subscriptionAccess.js's own
    // safety note on why this isn't enforced against uploads yet.
    const subscription = await getActiveSubscription(user.id);

    res.json({
      subscription: subscription
        ? {
            plan_name: subscription.subscriptionPlan?.planName ?? null,
            status: subscription.status,
            photo_quota_total: subscription.photoQuotaTotal,
            photo_quota_used: subscription.photoQuotaUsed,
            expires_at: subscription.expiresAt,
          }
        : null,
      id: user.id,
      name: user.name,
      email: user.email,
      email_verified: !!user.emailVerifiedAt,
      is_suspended: !!user.suspendedAt,
      created_at: user.createdAt,
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
        _count: { select: { photos: true } },
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
      photo_source_counts: photoSourceCounts,
      storage_used_bytes: storageAgg._sum.fileSize || 0,
      created_at: event.createdAt,
      expires_at: event.expiresAt,
      started: !!event.startedAt,
      drive_folder_url: event.driveFolderUrl,
      drive_sync_enabled: event.driveSyncEnabled,
      shoots_connected: !!event.ftpUsername,
      drive_backup_enabled: event.driveBackupEnabled,
      collaborators: event.collaborators.map((c) => ({ id: c.user.id, name: c.user.name, email: c.user.email })),
    });
  } catch (err) {
    next(err);
  }
});

router.delete("/events/:id", async (req, res, next) => {
  try {
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
      display_order: displayOrder,
    } = req.body || {};
    if (!planName || !["SUBSCRIPTION", "WALLET"].includes(planType) || price == null) {
      return res.status(400).json({ error: "plan_name, plan_type (SUBSCRIPTION|WALLET), and price are required" });
    }
    // MERGE (Phase 15 security/robustness review): a SUBSCRIPTION plan
    // missing duration/photoQuota, or a WALLET plan missing
    // walletCredits/walletTier, isn't a security hole but would 500 later
    // inside subscribeToPlan/rechargeWallet (e.g. `increment: null`) —
    // validate the type-specific required fields up front instead.
    if (planType === "SUBSCRIPTION" && (!durationValue || !["DAYS", "MONTHS", "YEARS"].includes(durationUnit) || photoQuota == null)) {
      return res.status(400).json({ error: "SUBSCRIPTION plans require duration_value, duration_unit (DAYS|MONTHS|YEARS), and photo_quota" });
    }
    if (planType === "WALLET" && (!walletCredits || !["INITIAL", "TOPUP"].includes(walletTier))) {
      return res.status(400).json({ error: "WALLET plans require wallet_credits and wallet_tier (INITIAL|TOPUP)" });
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
        displayOrder: displayOrder ?? 0,
      },
    });
    res.status(201).json(plan);
  } catch (err) {
    next(err);
  }
});

router.patch("/plans/:id", async (req, res, next) => {
  try {
    const plan = await prisma.subscriptionPlan.findUnique({ where: { id: req.params.id } });
    if (!plan) return res.status(404).json({ error: "Plan not found" });
    const { is_active: isActive, display_order: displayOrder, price } = req.body || {};
    const updated = await prisma.subscriptionPlan.update({
      where: { id: plan.id },
      data: {
        isActive: isActive ?? undefined,
        displayOrder: displayOrder ?? undefined,
        price: price ?? undefined,
      },
    });
    res.json(updated);
  } catch (err) {
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
    const { trial_duration_days, trial_photo_quota, monthly_grace_days, yearly_grace_days } = req.body || {};
    const updated = await prisma.platformSettings.upsert({
      where: { id: "singleton" },
      update: {
        trialDurationDays: trial_duration_days ?? undefined,
        trialPhotoQuota: trial_photo_quota ?? undefined,
        monthlyGraceDays: monthly_grace_days ?? undefined,
        yearlyGraceDays: yearly_grace_days ?? undefined,
      },
      create: { id: "singleton" },
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

export default router;
