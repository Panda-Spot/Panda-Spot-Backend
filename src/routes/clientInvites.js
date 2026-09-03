import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma.js";
import { signToken, setAuthCookie } from "../middleware/auth.js";
import { clientInviteLimiter } from "../lib/rateLimiters.js";

const router = Router();
const BCRYPT_ROUNDS = 10;

/// MERGE (Studio-Verse Photo Selection): mirrors routes/invites.js's shape
/// (preview + accept), but for client (USER-role) access instead of staff
/// collaborator access — see the ClientInvite model's own comment.
/// Deliberately public (no requireAuth): unlike a collaborator invite,
/// the invitee usually has no PandaSpot account yet, so accept itself
/// creates one.

router.get("/:token", clientInviteLimiter, async (req, res, next) => {
  try {
    const invite = await prisma.clientInvite.findUnique({
      where: { token: req.params.token },
      include: { event: true },
    });
    if (!invite || invite.acceptedAt) {
      return res.status(404).json({ error: "Invite not found" });
    }

    const existingUser = await prisma.user.findUnique({ where: { email: invite.email.toLowerCase() } });
    res.json({
      event_id: invite.event.id,
      event_name: invite.event.name,
      email: invite.email,
      // Lets the frontend show "log in" vs. "set a password" — an
      // existing account (e.g. invited to a second event) doesn't need a
      // new password.
      account_exists: !!existingUser,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/:token/accept", clientInviteLimiter, async (req, res, next) => {
  try {
    const invite = await prisma.clientInvite.findUnique({ where: { token: req.params.token } });
    if (!invite || invite.acceptedAt) {
      return res.status(404).json({ error: "Invite not found" });
    }

    let user = await prisma.user.findUnique({ where: { email: invite.email.toLowerCase() } });
    if (user) {
      if (user.role !== "USER") {
        return res.status(409).json({ error: "This email already has a different kind of PandaSpot account" });
      }
    } else {
      const { password, name } = req.body || {};
      if (!password || typeof password !== "string" || password.length < 8) {
        return res.status(400).json({ error: "password must be at least 8 characters" });
      }
      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      user = await prisma.user.create({
        data: {
          email: invite.email.toLowerCase(),
          passwordHash,
          name: (name && String(name).trim()) || invite.email.split("@")[0],
          role: "USER",
          emailVerifiedAt: new Date(), // clicking the emailed invite link is itself a real verification
        },
      });
    }

    await prisma.eventUserMapping.upsert({
      where: { eventId_userId: { eventId: invite.eventId, userId: user.id } },
      create: { eventId: invite.eventId, userId: user.id, favouriteCap: invite.favouriteCap },
      update: {},
    });

    await prisma.clientInvite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });

    const token = signToken(user);
    setAuthCookie(res, token);
    res.json({ ok: true, event_id: invite.eventId, token });
  } catch (err) {
    next(err);
  }
});

export default router;
