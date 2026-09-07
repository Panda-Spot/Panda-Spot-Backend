import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

// My invitations — logged-in user lists invites sent to their own email.
// Used by the separate "My Invitations" page (manual Accept/Reject).
router.get("/mine", requireAuth, async (req, res, next) => {
  try {
    const me = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!me) return res.status(401).json({ error: "Account not found" });
    const rows = await prisma.eventInvite.findMany({
      where: {
        email: { equals: me.email, mode: "insensitive" },
        acceptedAt: null,
        declinedAt: null,
      },
      include: { event: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({
      invites: rows.map((i) => ({
        token: i.token,
        invite_id: i.id,
        email: i.email,
        event_id: i.eventId,
        event_name: i.event?.name || "Event",
        invited_at: i.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Sent invitations — owner lists every invite they sent across all events
// they own, with pending / accepted / declined status + timestamps.
// Used by the separate "Team" page.
router.get("/sent", requireAuth, async (req, res, next) => {
  try {
    const owned = await prisma.event.findMany({
      where: { ownerId: req.user.id },
      select: { id: true, name: true },
    });
    const ownedIds = owned.map((e) => e.id);
    const nameById = Object.fromEntries(owned.map((e) => [e.id, e.name]));
    if (ownedIds.length === 0) return res.json({ invites: [] });
    const rows = await prisma.eventInvite.findMany({
      where: { eventId: { in: ownedIds } },
      orderBy: { createdAt: "desc" },
    });
    res.json({
      invites: rows.map((i) => ({
        invite_id: i.id,
        token: i.token,
        email: i.email,
        event_id: i.eventId,
        event_name: nameById[i.eventId] || "Event",
        invited_at: i.createdAt,
        accepted_at: i.acceptedAt,
        declined_at: i.declinedAt || null,
        status: i.acceptedAt ? "accepted" : i.declinedAt ? "declined" : "pending",
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Public — a not-yet-logged-in invitee needs to be able to preview what
// event/email an invite link is for before they register or log in.
router.get("/:token", async (req, res, next) => {
  try {
    const invite = await prisma.eventInvite.findUnique({
      where: { token: req.params.token },
      include: { event: true },
    });
    // Consumed or declined invites are no longer previewable.
    if (!invite || invite.acceptedAt || invite.declinedAt) {
      return res.status(404).json({ error: "Invite not found" });
    }

    res.json({
      event_id: invite.event.id,
      event_name: invite.event.name,
      email: invite.email,
      invited_at: invite.createdAt,
    });
  } catch (err) {
    next(err);
  }
});

// Manual Accept — only on explicit button click, never auto-fired on page
// open and never auto-done at signup. Email must match the invite.
router.post("/:token/accept", requireAuth, async (req, res, next) => {
  try {
    const invite = await prisma.eventInvite.findUnique({ where: { token: req.params.token } });
    if (!invite || invite.acceptedAt || invite.declinedAt) {
      return res.status(404).json({ error: "Invite not found" });
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user || user.email.toLowerCase() !== invite.email.toLowerCase()) {
      return res.status(403).json({ error: "This invite was sent to a different email address" });
    }

    await prisma.eventCollaborator.upsert({
      where: { eventId_userId: { eventId: invite.eventId, userId: user.id } },
      create: { eventId: invite.eventId, userId: user.id },
      update: {},
    });

    const updated = await prisma.eventInvite.update({
      where: { id: invite.id },
      data: { acceptedAt: new Date() },
    });

    res.json({ ok: true, event_id: invite.eventId, accepted_at: updated.acceptedAt });
  } catch (err) {
    next(err);
  }
});

// Manual Decline — invitee rejects; owner sees declined_at timestamp.
router.post("/:token/decline", requireAuth, async (req, res, next) => {
  try {
    const invite = await prisma.eventInvite.findUnique({ where: { token: req.params.token } });
    if (!invite || invite.acceptedAt || invite.declinedAt) {
      return res.status(404).json({ error: "Invite not found" });
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user || user.email.toLowerCase() !== invite.email.toLowerCase()) {
      return res.status(403).json({ error: "This invite was sent to a different email address" });
    }

    const updated = await prisma.eventInvite.update({
      where: { id: invite.id },
      data: { declinedAt: new Date() },
    });

    res.json({ ok: true, event_id: invite.eventId, declined_at: updated.declinedAt });
  } catch (err) {
    next(err);
  }
});

export default router;
