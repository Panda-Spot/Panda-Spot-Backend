import { prisma } from "./prisma.js";

/// MERGE (Studio-Verse Billing & Subscriptions): ported from Studio-
/// Verse's src/utils/subscriptionAccess.js. "Tenant" = an ADMIN-role
/// User in this merge (see the schema's own top-of-file comment).
///
/// SAFETY NOTE: every PandaSpot studio that existed before this migration
/// has no TenantSubscription row. assertQuotaAvailable therefore treats
/// "no subscription history at all" as a legacy grandfathered account and
/// allows uploads. Once a studio has any trial/plan/grant history, the
/// Studio-Verse lifecycle is enforced normally.

const FALLBACK_TRIAL_DURATION_DAYS = parseInt(process.env.DEFAULT_TRIAL_DURATION_DAYS || "7", 10);
const FALLBACK_TRIAL_PHOTO_QUOTA = parseInt(process.env.DEFAULT_TRIAL_PHOTO_QUOTA || "200", 10);
const FALLBACK_MONTHLY_GRACE_DAYS = parseInt(process.env.DEFAULT_MONTHLY_GRACE_DAYS || "3", 10);
const FALLBACK_YEARLY_GRACE_DAYS = parseInt(process.env.DEFAULT_YEARLY_GRACE_DAYS || "12", 10);

/** The singleton PlatformSettings row, created on first call with the env
 * fallbacks above as its seed values (Super-Admin editable afterward). */
export async function getPlatformSettings() {
  return prisma.platformSettings.upsert({
    where: { id: "singleton" },
    update: {},
    create: {
      id: "singleton",
      trialDurationDays: FALLBACK_TRIAL_DURATION_DAYS,
      trialPhotoQuota: FALLBACK_TRIAL_PHOTO_QUOTA,
      monthlyGraceDays: FALLBACK_MONTHLY_GRACE_DAYS,
      yearlyGraceDays: FALLBACK_YEARLY_GRACE_DAYS,
      freeAccessEnabled: true,
    },
  });
}

function graceDaysForPlan(plan, settings) {
  return plan?.durationUnit === "YEARS" ? settings.yearlyGraceDays : settings.monthlyGraceDays;
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

export function planDurationDays(plan) {
  if (plan.durationUnit === "YEARS") return plan.durationValue * 365;
  if (plan.durationUnit === "MONTHS") return plan.durationValue * 30;
  return plan.durationValue; // DAYS
}

export function computePlanExpiry(plan, from = new Date()) {
  if (plan.planType !== "SUBSCRIPTION") return null;
  return addDays(from, planDurationDays(plan));
}

function formatDate(date) {
  return new Date(date).toISOString().slice(0, 10);
}

export function assertPlanVisibleToTenant(plan, tenant) {
  if (!plan.specialAccessCutoffDate) return;
  if (new Date(tenant.createdAt) >= new Date(plan.specialAccessCutoffDate)) {
    throw new Error(`This plan is only available to studios that joined before ${formatDate(plan.specialAccessCutoffDate)}.`);
  }
}

/**
 * Pure function: given a TenantSubscription row (with its plan included)
 * and the current PlatformSettings, returns the Prisma `data` patch to
 * apply if this row's state needs to change right now, or `null` if it's
 * still current. No side effects — callers decide whether/how to persist
 * and whether to run purgeTenantContent (kept separate so this stays
 * trivially unit-testable).
 */
export function evaluateSubscriptionLifecycle(sub, settings, now = new Date()) {
  if (sub.status === "EXPIRED" || sub.status === "CANCELLED") return null;

  if (sub.status === "GRACE") {
    if (sub.graceEndsAt && now <= sub.graceEndsAt) return null;
    return { status: "EXPIRED", isActive: false };
  }

  // TRIAL or ACTIVE
  if (!sub.expiresAt || now <= sub.expiresAt) return null;
  const days = graceDaysForPlan(sub.subscriptionPlan, settings);
  return { status: "GRACE", graceEndsAt: addDays(sub.expiresAt, days) };
}

/**
 * The lazy sweep: reads the tenant's one active subscription row (if
 * any), evaluates whether its state needs to advance, persists that
 * advance if so (running purgeTenantContent first if the transition is
 * into EXPIRED), and returns the up-to-date row. Returns null if the
 * tenant has never had a subscription at all.
 */
export async function getActiveSubscription(tenantId) {
  const sub = await prisma.tenantSubscription.findFirst({
    where: { tenantId, isActive: true },
    include: { subscriptionPlan: true },
  });
  if (!sub) return null;

  const settings = await getPlatformSettings();
  const patch = evaluateSubscriptionLifecycle(sub, settings);
  if (!patch) return sub;

  if (patch.status === "EXPIRED") {
    await purgeTenantContent(tenantId);
  }
  const updated = await prisma.tenantSubscription.update({
    where: { id: sub.id },
    data: patch,
    include: { subscriptionPlan: true },
  });
  return updated;
}

/**
 * Irreversibly deletes every Event (and everything under it) owned by
 * this tenant — the EXPIRED-transition purge. Deliberately does NOT
 * touch the User row itself or its subscription history. Not scheduled
 * or called from anywhere automatically in this pass — see this file's
 * top-of-file safety note. Adapted to this project's real Event/Photo
 * graph (Studio-Verse's own version deleted its UploadedMedia/
 * EventUserMapping/EventTenantMapping equivalents — this deletes every
 * child table that has a real FK into an Event this tenant owns).
 */
export async function purgeTenantContent(tenantId) {
  const events = await prisma.event.findMany({ where: { ownerId: tenantId }, select: { id: true } });
  const eventIds = events.map((e) => e.id);
  if (eventIds.length === 0) return;

  await prisma.$transaction([
    prisma.matchFeedback.deleteMany({ where: { search: { eventId: { in: eventIds } } } }),
    prisma.guestSearch.deleteMany({ where: { eventId: { in: eventIds } } }),
    prisma.face.deleteMany({ where: { eventId: { in: eventIds } } }),
    prisma.photoComment.deleteMany({ where: { eventId: { in: eventIds } } }),
    prisma.photoLike.deleteMany({ where: { eventId: { in: eventIds } } }),
    prisma.clientFavourite.deleteMany({ where: { photo: { eventId: { in: eventIds } } } }),
    prisma.studioFavourite.deleteMany({ where: { photo: { eventId: { in: eventIds } } } }),
    prisma.photo.deleteMany({ where: { eventId: { in: eventIds } } }),
    prisma.eventUserMapping.deleteMany({ where: { eventId: { in: eventIds } } }),
    prisma.clientInvite.deleteMany({ where: { eventId: { in: eventIds } } }),
    prisma.eventCollaborator.deleteMany({ where: { eventId: { in: eventIds } } }),
    prisma.eventInvite.deleteMany({ where: { eventId: { in: eventIds } } }),
    prisma.guestAlertSubscription.deleteMany({ where: { eventId: { in: eventIds } } }),
    prisma.zipDownload.deleteMany({ where: { eventId: { in: eventIds } } }),
    prisma.event.deleteMany({ where: { id: { in: eventIds } } }),
  ]);
}

/** Throws if uploading should be blocked right now (GRACE/EXPIRED, or quota
 * exhausted). Legacy studios with no subscription history are grandfathered:
 * they predate the merge and keep uploading until a plan/trial/grant is
 * explicitly assigned, after which the Studio-Verse quota lifecycle applies. */
export async function assertQuotaAvailable(tenantId) {
  const settings = await getPlatformSettings();
  if (settings.freeAccessEnabled) return null;

  const sub = await getActiveSubscription(tenantId);
  if (!sub) {
    const hasHistory = await prisma.tenantSubscription.count({ where: { tenantId } });
    if (hasHistory === 0) return null;
    throw new Error("No active subscription — uploads are paused until you renew.");
  }
  if (sub.status === "GRACE" || sub.status === "EXPIRED" || sub.status === "CANCELLED") {
    throw new Error("No active subscription — uploads are paused until you renew.");
  }
  if (sub.photoQuotaUsed >= sub.photoQuotaTotal) {
    throw new Error("Photo quota reached for your current plan.");
  }
  return sub;
}

export async function consumeQuota(tenantId, count = 1) {
  if (!count || count < 1) return;
  const settings = await getPlatformSettings();
  if (settings.freeAccessEnabled) return;
  await prisma.tenantSubscription.updateMany({
    where: { tenantId, isActive: true, status: { in: ["TRIAL", "ACTIVE"] } },
    data: { photoQuotaUsed: { increment: count } },
  });
}

/** One-time-only trial activation. Studio-Verse enforces this via a
 * dedicated Tenant.trial_activated_at flag; this merge has no separate
 * Tenant table to add that to, so it checks subscription history instead
 * (any prior row with changeType "TRIAL") — same one-time guarantee,
 * smaller schema diff. purgeTenantContent never deletes
 * TenantSubscription rows, so this history check survives an EXPIRED
 * purge exactly like Studio-Verse's flag would. */
export async function activateTrial(tenantId) {
  const priorTrial = await prisma.tenantSubscription.findFirst({ where: { tenantId, changeType: "TRIAL" } });
  if (priorTrial) {
    throw new Error("Trial already used for this account.");
  }

  const settings = await getPlatformSettings();
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    await tx.tenantSubscription.updateMany({ where: { tenantId, isActive: true }, data: { isActive: false } });
    return tx.tenantSubscription.create({
      data: {
        tenantId,
        subscriptionPlanId: null,
        status: "TRIAL",
        changeType: "TRIAL",
        photoQuotaTotal: settings.trialPhotoQuota,
        startsAt: now,
        expiresAt: addDays(now, settings.trialDurationDays),
      },
    });
  });
}

/** A full renewal onto a SUBSCRIPTION-type plan — cancels whatever's
 * currently active, starts a brand-new period from now, price-locked. */
export async function subscribeToPlan(tenantId, planId) {
  const [plan, tenant] = await Promise.all([
    prisma.subscriptionPlan.findUnique({ where: { id: planId } }),
    prisma.user.findUnique({ where: { id: tenantId }, select: { id: true, createdAt: true } }),
  ]);
  if (!plan || !plan.isActive) throw new Error("Plan not found");
  if (!tenant) throw new Error("Studio not found");
  assertPlanVisibleToTenant(plan, tenant);
  if (plan.planType !== "SUBSCRIPTION") throw new Error("This plan isn't a subscription plan — use wallet recharge instead.");

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    await tx.tenantSubscription.updateMany({ where: { tenantId, isActive: true }, data: { isActive: false } });
    return tx.tenantSubscription.create({
      data: {
        tenantId,
        subscriptionPlanId: plan.id,
        status: "ACTIVE",
        changeType: "SUBSCRIBE",
        lockedPrice: plan.price,
        isPriceLocked: true,
        photoQuotaTotal: plan.photoQuota ?? 0,
        startsAt: now,
        expiresAt: computePlanExpiry(plan, now),
      },
    });
  });
}

function assertPlanSwapAllowed(currentSub, targetPlan) {
  if (!currentSub || ["GRACE", "EXPIRED", "CANCELLED"].includes(currentSub.status)) {
    throw new Error("No active subscription to change — subscribe first.");
  }
  if (targetPlan.planType !== "SUBSCRIPTION" || targetPlan.durationUnit !== currentSub.subscriptionPlan?.durationUnit) {
    throw new Error("You can only switch to another subscription plan with the same billing period.");
  }
  if (targetPlan.id === currentSub.subscriptionPlanId) {
    throw new Error("You're already on this plan.");
  }
}

/** Keeps the current period (startsAt/expiresAt/photoQuotaUsed)
 * unchanged, only swaps the plan/quota ceiling — no proration, matching
 * Studio-Verse exactly. Not price-locked (unlike a fresh subscribe). */
async function swapActivePlan(tenantId, targetPlanId, changeType) {
  const [currentSub, targetPlan] = await Promise.all([
    prisma.tenantSubscription.findFirst({ where: { tenantId, isActive: true }, include: { subscriptionPlan: true } }),
    prisma.subscriptionPlan.findUnique({ where: { id: targetPlanId } }),
  ]);
  if (!targetPlan || !targetPlan.isActive) throw new Error("Plan not found");
  assertPlanSwapAllowed(currentSub, targetPlan);

  return prisma.$transaction(async (tx) => {
    await tx.tenantSubscription.update({ where: { id: currentSub.id }, data: { isActive: false } });
    return tx.tenantSubscription.create({
      data: {
        tenantId,
        subscriptionPlanId: targetPlan.id,
        status: currentSub.status,
        changeType,
        isPriceLocked: false,
        lockedPrice: null,
        photoQuotaTotal: targetPlan.photoQuota ?? 0,
        photoQuotaUsed: currentSub.photoQuotaUsed,
        startsAt: currentSub.startsAt,
        expiresAt: currentSub.expiresAt,
      },
    });
  });
}

/** Requires targetPrice > currentPrice — "charges" the difference (mock,
 * no real gateway, matching Studio-Verse exactly). */
export async function upgradePlan(tenantId, targetPlanId) {
  const currentSub = await prisma.tenantSubscription.findFirst({
    where: { tenantId, isActive: true },
    include: { subscriptionPlan: true },
  });
  const targetPlan = await prisma.subscriptionPlan.findUnique({ where: { id: targetPlanId } });
  if (!targetPlan) throw new Error("Plan not found");
  const currentPrice = Number(currentSub?.lockedPrice ?? currentSub?.subscriptionPlan?.price ?? 0);
  if (Number(targetPlan.price) <= currentPrice) {
    throw new Error("Upgrade target must cost more than your current plan.");
  }
  const updated = await swapActivePlan(tenantId, targetPlanId, "UPGRADE");
  return { subscription: updated, charged: Number(targetPlan.price) - currentPrice, mock: true };
}

/** Requires targetPrice < currentPrice — no charge, no refund either
 * (the forfeited difference is a known, intentional Studio-Verse rule). */
export async function downgradePlan(tenantId, targetPlanId) {
  const currentSub = await prisma.tenantSubscription.findFirst({
    where: { tenantId, isActive: true },
    include: { subscriptionPlan: true },
  });
  const targetPlan = await prisma.subscriptionPlan.findUnique({ where: { id: targetPlanId } });
  if (!targetPlan) throw new Error("Plan not found");
  const currentPrice = Number(currentSub?.lockedPrice ?? currentSub?.subscriptionPlan?.price ?? 0);
  if (Number(targetPlan.price) >= currentPrice) {
    throw new Error("Downgrade target must cost less than your current plan.");
  }
  const updated = await swapActivePlan(tenantId, targetPlanId, "DOWNGRADE");
  return { subscription: updated };
}

/** WALLET-plan purchase: the first one must be an INITIAL-tier plan, and
 * every one after that must be TOPUP-tier — matching Studio-Verse's
 * exact sequencing rule. Mocked payment (reference: "MOCK_PAID"). */
export async function rechargeWallet(tenantId, planId) {
  const [plan, tenant] = await Promise.all([
    prisma.subscriptionPlan.findUnique({ where: { id: planId } }),
    prisma.user.findUnique({ where: { id: tenantId }, select: { id: true, createdAt: true } }),
  ]);
  if (!plan || !plan.isActive || plan.planType !== "WALLET") throw new Error("Wallet plan not found");
  if (!tenant) throw new Error("Studio not found");
  assertPlanVisibleToTenant(plan, tenant);

  const existingWallet = await prisma.tenantWallet.findUnique({ where: { tenantId } });
  if (!existingWallet && plan.walletTier !== "INITIAL") {
    throw new Error("You must purchase the initial wallet plan before you can top up.");
  }
  if (existingWallet && plan.walletTier !== "TOPUP") {
    throw new Error("You've already activated your wallet — use a top-up plan instead.");
  }

  return prisma.$transaction(async (tx) => {
    await tx.tenantWallet.upsert({
      where: { tenantId },
      update: {},
      create: { tenantId, balanceCredits: 0 },
    });
    const updatedWallet = await tx.tenantWallet.update({
      where: { tenantId },
      data: { balanceCredits: { increment: plan.walletCredits } },
    });
    await tx.walletTransaction.create({
      data: {
        tenantId,
        type: "RECHARGE",
        credits: plan.walletCredits,
        balanceAfter: updatedWallet.balanceCredits,
        reference: "MOCK_PAID",
        notes: `Recharge via plan ${plan.planName}`,
      },
    });
    return updatedWallet;
  });
}

/** Debits AI-usage credits atomically. Ported for parity but — same as
 * Studio-Verse itself — not called from any real face-matching code path
 * yet; a future integration point once AI-credit-gated search is built. */
export async function deductAiCredits(tenantId, credits) {
  return prisma.$transaction(async (tx) => {
    const wallet = await tx.tenantWallet.findUnique({ where: { tenantId } });
    if (!wallet || wallet.balanceCredits < credits) {
      throw new Error("Insufficient wallet balance.");
    }
    const updated = await tx.tenantWallet.update({
      where: { tenantId },
      data: { balanceCredits: { decrement: credits } },
    });
    await tx.walletTransaction.create({
      data: { tenantId, type: "AI_USAGE", credits: -credits, balanceAfter: updated.balanceCredits },
    });
    return updated;
  });
}
