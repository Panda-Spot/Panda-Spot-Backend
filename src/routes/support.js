import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/role.js";

const router = Router();

/// MERGE (Studio-Verse Support Tickets, Phase 13): a tenant (ADMIN) raises
/// and replies on their own tickets; a SUPER_ADMIN sees every tenant's
/// tickets and replies across all of them. Replying as SUPER_ADMIN
/// auto-bumps an OPEN ticket to IN_PROGRESS — the one real business rule
/// from Studio-Verse's own ticket system, ported verbatim.
router.use(requireAuth, requireRole("ADMIN", "SUPER_ADMIN"));

function serializeTicket(t) {
  return {
    id: t.id,
    subject: t.subject,
    status: t.status,
    tenant: t.tenant ? { id: t.tenant.id, email: t.tenant.email, name: t.tenant.name } : undefined,
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

router.get("/tickets", async (req, res, next) => {
  try {
    const isSuperAdmin = req.user.role === "SUPER_ADMIN";
    const tickets = await prisma.supportTicket.findMany({
      where: isSuperAdmin ? {} : { tenantId: req.user.id },
      include: { tenant: true, replies: { include: { author: true }, orderBy: { createdAt: "asc" } } },
      orderBy: { updatedAt: "desc" },
    });
    res.json(tickets.map(serializeTicket));
  } catch (err) {
    next(err);
  }
});

router.post("/tickets", async (req, res, next) => {
  try {
    const { subject, message } = req.body || {};
    if (!subject || typeof subject !== "string" || !subject.trim()) {
      return res.status(400).json({ error: "subject is required" });
    }
    const ticket = await prisma.supportTicket.create({
      data: {
        tenantId: req.user.id,
        subject: subject.trim(),
        replies: message ? { create: { authorId: req.user.id, message: String(message).trim() } } : undefined,
      },
      include: { tenant: true, replies: { include: { author: true } } },
    });
    res.status(201).json(serializeTicket(ticket));
  } catch (err) {
    next(err);
  }
});

async function loadTicketForRequest(req, res) {
  const isSuperAdmin = req.user.role === "SUPER_ADMIN";
  const ticket = await prisma.supportTicket.findFirst({
    where: isSuperAdmin ? { id: req.params.id } : { id: req.params.id, tenantId: req.user.id },
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

    const isSuperAdmin = req.user.role === "SUPER_ADMIN";
    const updated = await prisma.$transaction(async (tx) => {
      await tx.supportTicketReply.create({ data: { ticketId: ticket.id, authorId: req.user.id, message: message.trim() } });
      return tx.supportTicket.update({
        where: { id: ticket.id },
        // MERGE (Studio-Verse): an admin reply auto-bumps OPEN -> IN_PROGRESS.
        data: isSuperAdmin && ticket.status === "OPEN" ? { status: "IN_PROGRESS" } : {},
        include: { tenant: true, replies: { include: { author: true }, orderBy: { createdAt: "asc" } } },
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
    // Tenants may only resolve or reopen their own ticket; only a
    // SUPER_ADMIN can set IN_PROGRESS or CLOSED.
    const allowedForTenant = ["OPEN", "RESOLVED"];
    const allStatuses = ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"];
    if (!allStatuses.includes(status)) {
      return res.status(400).json({ error: `status must be one of ${allStatuses.join(", ")}` });
    }
    if (!isSuperAdmin && !allowedForTenant.includes(status)) {
      return res.status(403).json({ error: "Only support staff can set that status." });
    }

    const updated = await prisma.supportTicket.update({ where: { id: ticket.id }, data: { status } });
    res.json({ status: updated.status });
  } catch (err) {
    next(err);
  }
});

export default router;
