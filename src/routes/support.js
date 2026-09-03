import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/role.js";

const router = Router();

/// MERGE (Studio-Verse Support Tickets): support is now routed by requester.
/// ADMIN/INVITED/collaborator-side tickets go to SUPER_ADMIN. USER/client
/// tickets are assigned to the owning studio admin for the selected Photo
/// Selection event, while still remaining visible to SUPER_ADMIN.
router.use(requireAuth, requireRole("ADMIN", "SUPER_ADMIN", "USER", "INVITED"));

function serializeTicket(t) {
  return {
    id: t.id,
    subject: t.subject,
    status: t.status,
    tenant: t.tenant ? { id: t.tenant.id, email: t.tenant.email, name: t.tenant.name } : undefined,
    requester: t.requester ? { id: t.requester.id, email: t.requester.email, name: t.requester.name, role: t.requester.role } : undefined,
    event: t.event ? { id: t.event.id, name: t.event.name } : undefined,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
    replies: (t.replies || []).map((r) => ({
      id: r.id,
      message: r.message,
      author: { id: r.author.id, name: r.author.name, role: r.author.role },
      created_at: r.createdAt,
    })),
  };
}

function includeTicketRelations() {
  return {
    tenant: true,
    requester: true,
    event: true,
    replies: { include: { author: true }, orderBy: { createdAt: "asc" } },
  };
}

async function resolveClientTicketTarget(userId, eventId) {
  const mappings = eventId
    ? await prisma.eventUserMapping.findMany({ where: { eventId, userId }, include: { event: true } })
    : await prisma.eventUserMapping.findMany({ where: { userId }, include: { event: true }, orderBy: { createdAt: "desc" } });

  const activeMappings = mappings.filter((m) => m.event.photoSelectionEnabled);
  if (activeMappings.length === 0) {
    const error = new Error(eventId ? "You don't have access to this event." : "Choose an event before raising a client support ticket.");
    error.status = eventId ? 404 : 400;
    throw error;
  }
  if (!eventId && activeMappings.length > 1) {
    const error = new Error("event_id is required when your account has access to multiple events.");
    error.status = 400;
    throw error;
  }

  const mapping = activeMappings[0];
  return { tenantId: mapping.event.ownerId, eventId: mapping.eventId };
}

router.get("/tickets", async (req, res, next) => {
  try {
    const isSuperAdmin = req.user.role === "SUPER_ADMIN";
    const isStudioAdmin = req.user.role === "ADMIN";
    const tickets = await prisma.supportTicket.findMany({
      where: isSuperAdmin
        ? {}
        : isStudioAdmin
          ? { OR: [{ requesterId: req.user.id }, { tenantId: req.user.id, NOT: { requesterId: req.user.id } }] }
          : { requesterId: req.user.id },
      include: includeTicketRelations(),
      orderBy: { updatedAt: "desc" },
    });
    res.json(tickets.map(serializeTicket));
  } catch (err) {
    next(err);
  }
});

router.post("/tickets", async (req, res, next) => {
  try {
    const { subject, message, event_id: eventId } = req.body || {};
    if (!subject || typeof subject !== "string" || !subject.trim()) {
      return res.status(400).json({ error: "subject is required" });
    }
    const target = req.user.role === "USER"
      ? await resolveClientTicketTarget(req.user.id, eventId)
      : { tenantId: req.user.id, eventId: null };
    const ticket = await prisma.supportTicket.create({
      data: {
        tenantId: target.tenantId,
        requesterId: req.user.id,
        eventId: target.eventId,
        subject: subject.trim(),
        replies: message ? { create: { authorId: req.user.id, message: String(message).trim() } } : undefined,
      },
      include: includeTicketRelations(),
    });
    res.status(201).json(serializeTicket(ticket));
  } catch (err) {
    next(err);
  }
});

async function loadTicketForRequest(req, res) {
  const isSuperAdmin = req.user.role === "SUPER_ADMIN";
  const isStudioAdmin = req.user.role === "ADMIN";
  const ticket = await prisma.supportTicket.findFirst({
    where: isSuperAdmin
      ? { id: req.params.id }
      : isStudioAdmin
        ? { id: req.params.id, OR: [{ requesterId: req.user.id }, { tenantId: req.user.id, NOT: { requesterId: req.user.id } }] }
        : { id: req.params.id, requesterId: req.user.id },
  });
  if (!ticket) {
    res.status(404).json({ error: "Ticket not found" });
    return null;
  }
  return ticket;
}

router.post("/tickets/:id/reply", async (req, res, next) => {
  try {
    const ticket = await loadTicketForRequest(req, res);
    if (!ticket) return;
    if (ticket.status === "CLOSED") {
      return res.status(409).json({ error: "This ticket is closed." });
    }

    const { message } = req.body || {};
    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "message is required" });
    }

    const isSupportResponder = req.user.role === "SUPER_ADMIN" || (req.user.role === "ADMIN" && ticket.tenantId === req.user.id && ticket.requesterId !== req.user.id);
    const updated = await prisma.$transaction(async (tx) => {
      await tx.supportTicketReply.create({ data: { ticketId: ticket.id, authorId: req.user.id, message: message.trim() } });
      return tx.supportTicket.update({
        where: { id: ticket.id },
        // MERGE (Studio-Verse): a support-side reply auto-bumps OPEN -> IN_PROGRESS.
        data: isSupportResponder && ticket.status === "OPEN" ? { status: "IN_PROGRESS" } : {},
        include: includeTicketRelations(),
      });
    });
    res.status(201).json(serializeTicket(updated));
  } catch (err) {
    next(err);
  }
});

router.post("/tickets/:id/status", async (req, res, next) => {
  try {
    const ticket = await loadTicketForRequest(req, res);
    if (!ticket) return;

    const { status } = req.body || {};
    const isSuperAdmin = req.user.role === "SUPER_ADMIN";
    const isStudioSupport = req.user.role === "ADMIN" && ticket.tenantId === req.user.id && ticket.requesterId !== req.user.id;
    // Requesters may only resolve or reopen their own ticket; studio support
    // and SUPER_ADMIN can move tickets through the full support lifecycle.
    const allowedForTenant = ["OPEN", "RESOLVED"];
    const allStatuses = ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"];
    if (!allStatuses.includes(status)) {
      return res.status(400).json({ error: `status must be one of ${allStatuses.join(", ")}` });
    }
    if (!isSuperAdmin && !isStudioSupport && !allowedForTenant.includes(status)) {
      return res.status(403).json({ error: "Only support staff can set that status." });
    }

    const updated = await prisma.supportTicket.update({ where: { id: ticket.id }, data: { status } });
    res.json({ status: updated.status });
  } catch (err) {
    next(err);
  }
});

export default router;
