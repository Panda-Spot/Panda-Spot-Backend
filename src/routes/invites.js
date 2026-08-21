import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

// Public — a not-yet-logged-in invitee needs to be able to preview what
// event/email an invite link is for before they register or log in.
router.get("/:token", async (req, res, next) => {
  try {
    const invite = await prisma.eventInvite.findUnique({
      where: { token: req.params.token },
      include: { event: true },
    });
    // Treat an already-accepted invite as gone, same as a missing one — it
    // shouldn't be "previewable" again once consumed.
    if (!invite || invite.acceptedAt) {
      return res.status(404).json({ error: "Invite not found" });
    }

    res.json({
      event_id: invite.event.id,
      event_name: invite.event.name,
      email: invite.email,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/:token/accept", requireAuth, async (req, res, next) => {
  try {
    const invite = await prisma.eventInvite.findUnique({ where: { token: req.params.token } });
    if (!invite || invite.acceptedAt) {
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

    await prisma.eventInvite.update({
      where: { id: invite.id },
      data: { acceptedAt: new Date() },
    });

    res.json({ ok: true, event_id: invite.eventId });
  } catch (err) {
    next(err);
  }
});

export default router;
