import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/role.js";
import {
  activateTrial,
  downgradePlan,
  getActiveSubscription,
  getPlatformSettings,
  rechargeWallet,
  subscribeToPlan,
  upgradePlan,
} from "../lib/subscriptionAccess.js";

const router = Router();

/// MERGE (Studio-Verse Billing & Subscriptions): every route here acts on
/// the logged-in ADMIN (studio/"tenant") account itself — see
/// lib/subscriptionAccess.js's top-of-file safety note before wiring any
/// of this into upload/quota enforcement.
router.use(requireAuth, requireRole("ADMIN", "SUPER_ADMIN"));

router.get("/plans", async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    const plans = await prisma.subscriptionPlan.findMany({
      where: {
        isActive: true,
        OR: [{ specialAccessCutoffDate: null }, { specialAccessCutoffDate: { gt: user.createdAt } }],
      },
      orderBy: { displayOrder: "asc" },
    });
    res.json(plans);
  } catch (err) {
    next(err);
  }
});

router.get("/me", async (req, res, next) => {
  try {
    const [subscription, settings] = await Promise.all([
      getActiveSubscription(req.user.id),
      getPlatformSettings(),
    ]);
    const [wallet, aiIndexedPhotoCount] = await Promise.all([
      prisma.tenantWallet.findUnique({ where: { tenantId: req.user.id } }),
      prisma.photo.count({
        where: {
          event: { ownerId: req.user.id },
          faceIndexedAt: { not: null },
        },
      }),
    ]);
    res.json({
      free_access_enabled: settings?.freeAccessEnabled ?? true,
      subscription: subscription
        ? {
            id: subscription.id,
            plan_name: subscription.subscriptionPlan?.planName ?? null,
            status: subscription.status,
            photo_quota_total: subscription.photoQuotaTotal,
            photo_quota_used: subscription.photoQuotaUsed,
            starts_at: subscription.startsAt,
            expires_at: subscription.expiresAt,
            grace_ends_at: subscription.graceEndsAt,
          }
        : null,
      wallet_balance: wallet?.balanceCredits ?? 0,
      ai_indexed_photo_count: aiIndexedPhotoCount,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/trial", async (req, res, next) => {
  try {
    const sub = await activateTrial(req.user.id);
    res.json({ status: sub.status, expires_at: sub.expiresAt });
  } catch (err) {
    if (err.code === "P2002") return res.status(409).json({ error: "You already have an active subscription." });
    res.status(400).json({ error: err.message });
  }
});

router.post("/subscribe", async (req, res, next) => {
  try {
    const { plan_id: planId } = req.body || {};
    if (!planId) return res.status(400).json({ error: "plan_id is required" });
    const sub = await subscribeToPlan(req.user.id, planId);
    res.json({ status: sub.status, expires_at: sub.expiresAt });
  } catch (err) {
    if (err.code === "P2002") return res.status(409).json({ error: "You already have an active subscription." });
    res.status(400).json({ error: err.message });
  }
});

router.post("/upgrade", async (req, res, next) => {
  try {
    const { plan_id: planId } = req.body || {};
    if (!planId) return res.status(400).json({ error: "plan_id is required" });
    const result = await upgradePlan(req.user.id, planId);
    res.json({ status: result.subscription.status, charged: result.charged, mock: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/downgrade", async (req, res, next) => {
  try {
    const { plan_id: planId } = req.body || {};
    if (!planId) return res.status(400).json({ error: "plan_id is required" });
    const result = await downgradePlan(req.user.id, planId);
    res.json({ status: result.subscription.status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/wallet/recharge", async (req, res, next) => {
  try {
    const { plan_id: planId } = req.body || {};
    if (!planId) return res.status(400).json({ error: "plan_id is required" });
    const wallet = await rechargeWallet(req.user.id, planId);
    res.json({ balance_credits: wallet.balanceCredits });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/wallet/transactions", async (req, res, next) => {
  try {
    const transactions = await prisma.walletTransaction.findMany({
      where: { tenantId: req.user.id },
      orderBy: { createdAt: "desc" },
    });
    res.json(
      transactions.map((t) => ({
        id: t.id,
        type: t.type,
        credits: t.credits,
        balance_after: t.balanceAfter,
        reference: t.reference,
        notes: t.notes,
        created_at: t.createdAt,
      }))
    );
  } catch (err) {
    next(err);
  }
});

// MERGE (Studio-Verse plan-change history, Phase 18H): the tenant's own
// full subscription ledger — every subscribe/upgrade/downgrade/trial/free
// grant row, newest first. Read-only; mirrors the history the admin
// console already shows per studio.
router.get("/history", async (req, res, next) => {
  try {
    const rows = await prisma.tenantSubscription.findMany({
      where: { tenantId: req.user.id },
      include: { subscriptionPlan: true },
      orderBy: { createdAt: "desc" },
    });
    res.json(
      rows.map((sub) => ({
        id: sub.id,
        plan_id: sub.subscriptionPlanId,
        plan_name: sub.subscriptionPlan?.planName ?? null,
        status: sub.status,
        change_type: sub.changeType,
        is_free_grant: sub.isFreeGrant,
        photo_quota_total: sub.photoQuotaTotal,
        photo_quota_used: sub.photoQuotaUsed,
        starts_at: sub.startsAt,
        expires_at: sub.expiresAt,
        created_at: sub.createdAt,
      }))
    );
  } catch (err) {
    next(err);
  }
});

export default router;
