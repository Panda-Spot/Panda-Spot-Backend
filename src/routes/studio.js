import { Router } from "express";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/role.js";
import { upload } from "../middleware/upload.js";
import { clientInviteLimiter } from "../lib/rateLimiters.js";
import { contentMatchesExtension } from "../lib/fileValidation.js";
import { IMAGE_EXTENSIONS, deleteFileIfExists, existsSync, saveContractTemplate } from "../lib/storage.js";
import { computeExpiresAt } from "../lib/expiry.js";
import { summarizeBillPayment } from "../lib/billingAccess.js";
import { sendClientInviteEmail } from "../lib/mailer.js";
import { configuredGateways, createPaymentIntent } from "../lib/paymentGateways.js";

const router = Router();

/// Public booking inquiry form (Phase 12): no login — the studio is
/// resolved by its claimed subdomain slug (/inquire/:slug). Rate-limited
/// like client invites (same abuse profile: public, account-creating).
/// Defined BEFORE the auth middleware below so it stays public.
router.post("/inquire/:slug", clientInviteLimiter, async (req, res, next) => {
  try {
    const studio = await prisma.user.findUnique({
      where: { studioSlug: String(req.params.slug || "").toLowerCase() },
      select: { id: true, studioName: true },
    });
    if (!studio) {
      return res.status(404).json({ error: "Studio not found" });
    }
    const { name, phone, email, event_type: eventType, event_date: eventDate, message } = req.body || {};
    if (!name || typeof name !== "string" || !name.trim() || name.length > 120) {
      return res.status(400).json({ error: "name is required (max 120)" });
    }
    if (!email || typeof email !== "string" || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: "A valid email address is required" });
    }
    if (phone !== undefined && phone !== null && phone !== "" && (typeof phone !== "string" || phone.length > 40)) {
      return res.status(400).json({ error: "phone must be a short string" });
    }
    let date = null;
    if (eventDate !== undefined && eventDate !== null && eventDate !== "") {
      try {
        date = asDate(eventDate, "event_date");
      } catch (err) {
        return res.status(err.status || 400).json({ error: err.message });
      }
    }
    const created = await prisma.bookingInquiry.create({
      data: {
        tenantId: studio.id,
        name: name.trim(),
        phone: phone?.trim() || null,
        email: email.toLowerCase(),
        eventType: eventType?.trim()?.slice(0, 80) || null,
        eventDate: date,
        message: message?.trim()?.slice(0, 2000) || null,
      },
    });
    res.status(201).json({ inquiry_id: created.id, studio: studio.studioName || "Studio" });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/// Business studio management suite (Phase 12): inquiries, packages,
/// contracts, questionnaires, bookings + billing linkage, expenses.
/// Tenant-scoped throughout — ADMIN User IS the tenant, so studios only
/// ever touch their own pipeline rows.
router.use(requireAuth, requireRole("ADMIN"));

const PUBLIC_WEB_URL = process.env.PUBLIC_WEB_URL || "http://localhost:5173";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function money(value, field) {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(n) || n < 0 || n > 9999999999) {
    throw Object.assign(new Error(`${field} must be a non-negative amount`), { status: 400 });
  }
  return Math.round(n * 100) / 100;
}

function asDate(value, field) {
  if (value === null || value === undefined || value === "") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw Object.assign(new Error(`${field} must be a valid date`), { status: 400 });
  }
  return d;
}

async function generateGuestSlug() {
  for (let i = 0; i < 5; i++) {
    const slug = randomBytes(6).toString("base64url");
    const existing = await prisma.event.findUnique({ where: { guestSlug: slug } });
    if (!existing) return slug;
  }
  throw Object.assign(new Error("Could not generate a unique link — try again"), { status: 500 });
}

// --- Inquiries ---

router.get("/inquiries", async (req, res, next) => {
  try {
    const status = req.query.status;
    if (status !== undefined && !["new", "contacted", "converted", "lost"].includes(status)) {
      return res.status(400).json({ error: 'status must be "new", "contacted", "converted" or "lost"' });
    }
    const inquiries = await prisma.bookingInquiry.findMany({
      where: { tenantId: req.user.id, ...(status ? { status } : {}) },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    res.json(inquiries.map(inquiryShape));
  } catch (err) {
    next(err);
  }
});

function inquiryShape(i) {
  return {
    id: i.id,
    name: i.name,
    phone: i.phone,
    email: i.email,
    event_type: i.eventType,
    event_date: i.eventDate,
    message: i.message,
    status: i.status,
    converted_event_id: i.convertedEventId,
    created_at: i.createdAt,
  };
}

router.patch("/inquiries/:id", async (req, res, next) => {
  try {
    const inquiry = await prisma.bookingInquiry.findFirst({
      where: { id: req.params.id, tenantId: req.user.id },
    });
    if (!inquiry) return res.status(404).json({ error: "Inquiry not found" });
    const { status } = req.body || {};
    if (!["new", "contacted", "converted", "lost"].includes(status)) {
      return res.status(400).json({ error: 'status must be "new", "contacted", "converted" or "lost"' });
    }
    const updated = await prisma.bookingInquiry.update({ where: { id: inquiry.id }, data: { status } });
    res.json(inquiryShape(updated));
  } catch (err) {
    next(err);
  }
});

// Convert an inquiry into a real Event + client invite + Booking.
// Creates the event (owned by the studio), emails the invite link
// best-effort, and marks the inquiry converted — all-or-nothing except
// the email, which must never fail the conversion itself.
router.post("/inquiries/:id/convert", async (req, res, next) => {
  try {
    const inquiry = await prisma.bookingInquiry.findFirst({
      where: { id: req.params.id, tenantId: req.user.id },
    });
    if (!inquiry) return res.status(404).json({ error: "Inquiry not found" });
    if (inquiry.convertedEventId) {
      return res.status(409).json({ error: "This inquiry was already converted.", event_id: inquiry.convertedEventId });
    }
    const { event_name: eventName } = req.body || {};
    const name = (eventName && String(eventName).trim()) || `${inquiry.name} — ${inquiry.eventType || "Event"}`.slice(0, 120);
    const guestSlug = await generateGuestSlug();
    const event = await prisma.event.create({
      data: {
        name,
        ownerId: req.user.id,
        guestSlug,
        expiresAt: computeExpiresAt(),
        eventDate: inquiry.eventDate,
        eventVenue: null,
        description: inquiry.message?.slice(0, 500) || null,
      },
    });
    const token = randomBytes(24).toString("base64url");
    const invite = await prisma.clientInvite.create({
      data: { eventId: event.id, email: inquiry.email.toLowerCase(), token },
    });
    const inviteUrl = `${PUBLIC_WEB_URL}/client-invites/${invite.token}`;
    try {
      await sendClientInviteEmail(inquiry.email, event.name, inviteUrl);
    } catch (err) {
      console.error(`Convert: invite email to ${inquiry.email} failed:`, err.message);
    }
    const booking = await prisma.booking.create({
      data: {
        tenantId: req.user.id,
        inquiryId: inquiry.id,
        clientName: inquiry.name,
        clientEmail: inquiry.email.toLowerCase(),
        clientPhone: inquiry.phone,
        eventType: inquiry.eventType,
        eventDate: inquiry.eventDate,
        eventId: event.id,
        status: "confirmed",
      },
    });
    await prisma.bookingInquiry.update({
      where: { id: inquiry.id },
      data: { status: "converted", convertedEventId: event.id },
    });
    res.status(201).json({
      event_id: event.id,
      guest_link: `/e/${event.guestSlug}`,
      invite_token: invite.token,
      invite_url: inviteUrl,
      booking_id: booking.id,
    });
  } catch (err) {
    next(err);
  }
});

// --- Shoot calendar ---
// Booked/shoot/inquiry dates in one payload: events by eventDate,
// bookings by eventDate, inquiries by eventDate. Defaults to the month
// containing `from` (or today) through +62 days.
router.get("/calendar", async (req, res, next) => {
  try {
    let from = req.query.from ? new Date(req.query.from) : new Date();
    if (Number.isNaN(from.getTime())) return res.status(400).json({ error: "from must be a valid date" });
    from = new Date(from.getFullYear(), from.getMonth(), 1);
    let to = req.query.to ? new Date(req.query.to) : new Date(from.getFullYear(), from.getMonth() + 2, 0);
    if (Number.isNaN(to.getTime())) return res.status(400).json({ error: "to must be a valid date" });
    to = new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59, 59);

    const [events, bookings, inquiries] = await Promise.all([
      prisma.event.findMany({
        where: { ownerId: req.user.id, eventDate: { gte: from, lte: to }, archivedAt: null },
        select: { id: true, name: true, eventDate: true },
        orderBy: { eventDate: "asc" },
      }),
      prisma.booking.findMany({
        where: { tenantId: req.user.id, eventDate: { gte: from, lte: to }, status: { not: "cancelled" } },
        select: { id: true, clientName: true, eventType: true, eventDate: true, status: true, eventId: true },
        orderBy: { eventDate: "asc" },
      }),
      prisma.bookingInquiry.findMany({
        where: { tenantId: req.user.id, eventDate: { gte: from, lte: to }, status: { in: ["new", "contacted"] } },
        select: { id: true, name: true, eventType: true, eventDate: true, status: true },
        orderBy: { eventDate: "asc" },
      }),
    ]);
    res.json({
      from,
      to,
      items: [
        ...events.map((e) => ({ kind: "event", date: e.eventDate, id: e.id, name: e.name })),
        ...bookings.map((b) => ({
          kind: "booking",
          date: b.eventDate,
          id: b.id,
          name: `${b.clientName}${b.eventType ? ` — ${b.eventType}` : ""}`,
          status: b.status,
          event_id: b.eventId,
        })),
        ...inquiries.map((i) => ({
          kind: "inquiry",
          date: i.eventDate,
          id: i.id,
          name: `${i.name}${i.eventType ? ` — ${i.eventType}` : ""}`,
          status: i.status,
        })),
      ].sort((a, b) => new Date(a.date) - new Date(b.date)),
    });
  } catch (err) {
    next(err);
  }
});

// --- Packages ---

function packageShape(p) {
  return {
    id: p.id,
    name: p.name,
    price: Number(p.price),
    deliverables: p.deliverables,
    included_photos: p.includedPhotos,
    included_albums: p.includedAlbums,
    included_events: p.includedEvents,
    active: p.active,
    created_at: p.createdAt,
  };
}

router.get("/packages", async (req, res, next) => {
  try {
    const packages = await prisma.studioPackage.findMany({
      where: { tenantId: req.user.id },
      orderBy: { createdAt: "desc" },
    });
    res.json(packages.map(packageShape));
  } catch (err) {
    next(err);
  }
});

router.post("/packages", async (req, res, next) => {
  try {
    const { name, price, deliverables, included_photos, included_albums, included_events } = req.body || {};
    if (!name || typeof name !== "string" || !name.trim() || name.length > 120) {
      return res.status(400).json({ error: "name is required (max 120)" });
    }
    let amount;
    try {
      amount = money(price, "price");
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }
    if (amount === null) return res.status(400).json({ error: "price is required" });
    const items = deliverables === undefined ? [] : deliverables;
    if (!Array.isArray(items) || items.some((d) => typeof d !== "string" || d.length > 200)) {
      return res.status(400).json({ error: "deliverables must be an array of short strings" });
    }
    for (const [key, label] of [["included_photos", "included_photos"], ["included_albums", "included_albums"], ["included_events", "included_events"]]) {
      const v = req.body?.[key];
      if (v !== undefined && (!Number.isInteger(v) || v < 0 || v > 100000)) {
        return res.status(400).json({ error: `${label} must be an integer 0-100000` });
      }
    }
    const created = await prisma.studioPackage.create({
      data: {
        tenantId: req.user.id,
        name: name.trim(),
        price: amount,
        deliverables: items,
        includedPhotos: req.body?.included_photos ?? 0,
        includedAlbums: req.body?.included_albums ?? 0,
        includedEvents: req.body?.included_events ?? 1,
      },
    });
    res.status(201).json(packageShape(created));
  } catch (err) {
    next(err);
  }
});

router.patch("/packages/:id", async (req, res, next) => {
  try {
    const pkg = await prisma.studioPackage.findFirst({ where: { id: req.params.id, tenantId: req.user.id } });
    if (!pkg) return res.status(404).json({ error: "Package not found" });
    const data = {};
    const { name, price, deliverables, included_photos, included_albums, included_events, active } = req.body || {};
    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim() || name.length > 120) {
        return res.status(400).json({ error: "name must be a non-empty string (max 120)" });
      }
      data.name = name.trim();
    }
    if (price !== undefined) {
      try {
        const amount = money(price, "price");
        if (amount === null) return res.status(400).json({ error: "price is required" });
        data.price = amount;
      } catch (err) {
        return res.status(err.status || 400).json({ error: err.message });
      }
    }
    if (deliverables !== undefined) {
      if (!Array.isArray(deliverables) || deliverables.some((d) => typeof d !== "string" || d.length > 200)) {
        return res.status(400).json({ error: "deliverables must be an array of short strings" });
      }
      data.deliverables = deliverables;
    }
    for (const [key, field] of [["included_photos", "includedPhotos"], ["included_albums", "includedAlbums"], ["included_events", "includedEvents"]]) {
      const v = req.body?.[key];
      if (v !== undefined) {
        if (!Number.isInteger(v) || v < 0 || v > 100000) {
          return res.status(400).json({ error: `${key} must be an integer 0-100000` });
        }
        data[field] = v;
      }
    }
    if (active !== undefined) {
      if (typeof active !== "boolean") return res.status(400).json({ error: "active must be a boolean" });
      data.active = active;
    }
    if (Object.keys(data).length === 0) return res.status(400).json({ error: "No package change provided." });
    const updated = await prisma.studioPackage.update({ where: { id: pkg.id }, data });
    res.json(packageShape(updated));
  } catch (err) {
    next(err);
  }
});

router.delete("/packages/:id", async (req, res, next) => {
  try {
    const pkg = await prisma.studioPackage.findFirst({ where: { id: req.params.id, tenantId: req.user.id } });
    if (!pkg) return res.status(404).json({ error: "Package not found" });
    await prisma.studioPackage.delete({ where: { id: pkg.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// --- Contract templates + client contracts ---

router.get("/contract-templates", async (req, res, next) => {
  try {
    const rows = await prisma.contractTemplate.findMany({
      where: { tenantId: req.user.id },
      orderBy: { createdAt: "desc" },
    });
    res.json(rows.map((t) => ({ id: t.id, name: t.name, file_size: t.fileSize, created_at: t.createdAt })));
  } catch (err) {
    next(err);
  }
});

router.post("/contract-templates", upload.single("contract"), async (req, res, next) => {
  try {
    const { name } = req.body || {};
    if (!name || typeof name !== "string" || !name.trim() || name.length > 120) {
      return res.status(400).json({ error: "name is required (max 120)" });
    }
    if (!req.file) {
      return res.status(400).json({ error: "No contract file uploaded (expected multipart field 'contract')" });
    }
    const ext = path.extname(req.file.originalname).toLowerCase();
    // PDFs have no image/video magic bytes — check the %PDF header
    // directly (same pattern as album print-PDF uploads).
    const isPdf = req.file.buffer.length > 4 && req.file.buffer.toString("ascii", 0, 4) === "%PDF";
    if (ext !== ".pdf" || !isPdf) {
      return res.status(415).json({ error: "Contract templates must be real PDF files" });
    }
    const filePath = await saveContractTemplate(req.user.id, req.file.originalname, req.file.buffer);
    const created = await prisma.contractTemplate.create({
      data: { tenantId: req.user.id, name: name.trim(), filePath, fileSize: req.file.buffer.length },
    });
    res.status(201).json({ id: created.id, name: created.name, file_size: created.fileSize });
  } catch (err) {
    next(err);
  }
});

router.delete("/contract-templates/:id", async (req, res, next) => {
  try {
    const template = await prisma.contractTemplate.findFirst({
      where: { id: req.params.id, tenantId: req.user.id },
    });
    if (!template) return res.status(404).json({ error: "Template not found" });
    await deleteFileIfExists(template.filePath);
    await prisma.contractTemplate.delete({ where: { id: template.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

function contractShape(c) {
  return {
    id: c.id,
    template_id: c.templateId,
    template_name: c.template?.name || null,
    event_id: c.eventId,
    client_email: c.clientEmail,
    status: c.status,
    signature_name: c.signatureName,
    accepted_at: c.acceptedAt,
    created_at: c.createdAt,
  };
}

router.get("/contracts", async (req, res, next) => {
  try {
    const status = req.query.status;
    if (status !== undefined && !["sent", "signed"].includes(status)) {
      return res.status(400).json({ error: 'status must be "sent" or "signed"' });
    }
    const rows = await prisma.clientContract.findMany({
      where: { tenantId: req.user.id, ...(status ? { status } : {}) },
      include: { template: true },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    res.json(rows.map(contractShape));
  } catch (err) {
    next(err);
  }
});

router.post("/contracts", async (req, res, next) => {
  try {
    const { template_id: templateId, event_id: eventId, client_email: clientEmail } = req.body || {};
    if (!clientEmail || typeof clientEmail !== "string" || !EMAIL_RE.test(clientEmail)) {
      return res.status(400).json({ error: "A valid client_email is required" });
    }
    let template = null;
    if (templateId !== undefined && templateId !== null) {
      template = await prisma.contractTemplate.findFirst({ where: { id: templateId, tenantId: req.user.id } });
      if (!template) return res.status(404).json({ error: "Template not found" });
    }
    if (eventId !== undefined && eventId !== null) {
      const event = await prisma.event.findFirst({ where: { id: eventId, ownerId: req.user.id } });
      if (!event) return res.status(404).json({ error: "Event not found" });
    }
    const created = await prisma.clientContract.create({
      data: {
        tenantId: req.user.id,
        templateId: template?.id || null,
        eventId: eventId || null,
        clientEmail: clientEmail.toLowerCase(),
      },
      include: { template: true },
    });
    res.status(201).json(contractShape(created));
  } catch (err) {
    next(err);
  }
});

router.delete("/contracts/:id", async (req, res, next) => {
  try {
    const contract = await prisma.clientContract.findFirst({
      where: { id: req.params.id, tenantId: req.user.id },
    });
    if (!contract) return res.status(404).json({ error: "Contract not found" });
    await prisma.clientContract.delete({ where: { id: contract.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Studio-side file fetch for an assigned contract's template.
router.get("/contracts/:id/file", async (req, res, next) => {
  try {
    const contract = await prisma.clientContract.findFirst({
      where: { id: req.params.id, tenantId: req.user.id },
      include: { template: true },
    });
    if (!contract?.template?.filePath || !existsSync(contract.template.filePath)) {
      return res.status(404).json({ error: "Contract file not available" });
    }
    res.setHeader("Content-Type", "application/pdf");
    res.sendFile(contract.template.filePath);
  } catch (err) {
    next(err);
  }
});

// --- Questionnaires ---

const QUESTION_TYPES = ["text", "choice", "date"];

function validateQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0 || questions.length > 100) {
    return "questions must be a non-empty array (max 100)";
  }
  const ids = new Set();
  for (const q of questions) {
    if (!q || typeof q.id !== "string" || !q.id.trim() || q.id.length > 60) return "each question needs a short string id";
    if (ids.has(q.id)) return "question ids must be unique";
    ids.add(q.id);
    if (typeof q.label !== "string" || !q.label.trim() || q.label.length > 500) return "each question needs a label (max 500)";
    if (!QUESTION_TYPES.includes(q.type)) return "question type must be text, choice, or date";
    if (q.type === "choice") {
      if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 20) {
        return "choice questions need 2-20 options";
      }
      if (q.options.some((o) => typeof o !== "string" || !o.trim() || o.length > 200)) {
        return "options must be short strings";
      }
    }
  }
  return null;
}

router.get("/questionnaires", async (req, res, next) => {
  try {
    const rows = await prisma.questionnaire.findMany({
      where: { tenantId: req.user.id },
      include: { _count: { select: { assignments: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json(
      rows.map((q) => ({
        id: q.id,
        title: q.title,
        questions: q.questions,
        active: q.active,
        assignment_count: q._count.assignments,
        created_at: q.createdAt,
      }))
    );
  } catch (err) {
    next(err);
  }
});

router.post("/questionnaires", async (req, res, next) => {
  try {
    const { title, questions } = req.body || {};
    if (!title || typeof title !== "string" || !title.trim() || title.length > 120) {
      return res.status(400).json({ error: "title is required (max 120)" });
    }
    const problem = validateQuestions(questions);
    if (problem) return res.status(400).json({ error: problem });
    const created = await prisma.questionnaire.create({
      data: { tenantId: req.user.id, title: title.trim(), questions },
    });
    res.status(201).json({ id: created.id, title: created.title });
  } catch (err) {
    next(err);
  }
});

router.patch("/questionnaires/:id", async (req, res, next) => {
  try {
    const q = await prisma.questionnaire.findFirst({ where: { id: req.params.id, tenantId: req.user.id } });
    if (!q) return res.status(404).json({ error: "Questionnaire not found" });
    const data = {};
    const { title, questions, active } = req.body || {};
    if (title !== undefined) {
      if (typeof title !== "string" || !title.trim() || title.length > 120) {
        return res.status(400).json({ error: "title must be a non-empty string (max 120)" });
      }
      data.title = title.trim();
    }
    if (questions !== undefined) {
      const problem = validateQuestions(questions);
      if (problem) return res.status(400).json({ error: problem });
      data.questions = questions;
    }
    if (active !== undefined) {
      if (typeof active !== "boolean") return res.status(400).json({ error: "active must be a boolean" });
      data.active = active;
    }
    if (Object.keys(data).length === 0) return res.status(400).json({ error: "No questionnaire change provided." });
    const updated = await prisma.questionnaire.update({ where: { id: q.id }, data });
    res.json({ id: updated.id, title: updated.title });
  } catch (err) {
    next(err);
  }
});

router.delete("/questionnaires/:id", async (req, res, next) => {
  try {
    const q = await prisma.questionnaire.findFirst({ where: { id: req.params.id, tenantId: req.user.id } });
    if (!q) return res.status(404).json({ error: "Questionnaire not found" });
    await prisma.questionnaire.delete({ where: { id: q.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Assign to a client on an event (email and/or existing user id).
router.post("/questionnaires/:id/assign", async (req, res, next) => {
  try {
    const q = await prisma.questionnaire.findFirst({ where: { id: req.params.id, tenantId: req.user.id } });
    if (!q) return res.status(404).json({ error: "Questionnaire not found" });
    const { event_id: eventId, client_email: clientEmail, client_user_id: clientUserId } = req.body || {};
    if (typeof eventId !== "string") return res.status(400).json({ error: "event_id is required" });
    const event = await prisma.event.findFirst({ where: { id: eventId, ownerId: req.user.id } });
    if (!event) return res.status(404).json({ error: "Event not found" });
    if (clientEmail !== undefined && clientEmail !== null && (typeof clientEmail !== "string" || !EMAIL_RE.test(clientEmail))) {
      return res.status(400).json({ error: "A valid client_email is required" });
    }
    if (!clientEmail && !clientUserId) {
      return res.status(400).json({ error: "client_email or client_user_id is required" });
    }
    const created = await prisma.questionnaireAssignment.create({
      data: {
        questionnaireId: q.id,
        eventId: event.id,
        clientEmail: clientEmail?.toLowerCase() || null,
        clientUserId: clientUserId || null,
      },
    });
    res.status(201).json({ assignment_id: created.id });
  } catch (err) {
    next(err);
  }
});

// Studio read-side: assignments with response state for one questionnaire.
router.get("/questionnaires/:id/assignments", async (req, res, next) => {
  try {
    const q = await prisma.questionnaire.findFirst({ where: { id: req.params.id, tenantId: req.user.id } });
    if (!q) return res.status(404).json({ error: "Questionnaire not found" });
    const rows = await prisma.questionnaireAssignment.findMany({
      where: { questionnaireId: q.id },
      include: { response: true, event: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    res.json(
      rows.map((a) => ({
        assignment_id: a.id,
        event: a.event,
        client_email: a.clientEmail,
        submitted: !!a.response,
        submitted_at: a.response?.submittedAt || null,
        answers: a.response?.answers || null,
        created_at: a.createdAt,
      }))
    );
  } catch (err) {
    next(err);
  }
});

// --- Bookings ---

const BOOKING_STATUSES = ["inquiry", "confirmed", "completed", "cancelled"];

function bookingShape(b) {
  return {
    id: b.id,
    inquiry_id: b.inquiryId,
    client_name: b.clientName,
    client_email: b.clientEmail,
    client_phone: b.clientPhone,
    event_type: b.eventType,
    event_date: b.eventDate,
    package_id: b.packageId,
    event_id: b.eventId,
    agreed_amount: b.agreedAmount != null ? Number(b.agreedAmount) : null,
    bill_id: b.billId,
    status: b.status,
    notes: b.notes,
    created_at: b.createdAt,
  };
}

router.get("/bookings", async (req, res, next) => {
  try {
    const status = req.query.status;
    if (status !== undefined && !BOOKING_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of ${BOOKING_STATUSES.join(", ")}` });
    }
    const rows = await prisma.booking.findMany({
      where: { tenantId: req.user.id, ...(status ? { status } : {}) },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    res.json(rows.map(bookingShape));
  } catch (err) {
    next(err);
  }
});

router.post("/bookings", async (req, res, next) => {
  try {
    const { client_name: clientName, client_email: clientEmail, client_phone: clientPhone, event_type: eventType, event_date: eventDate, package_id: packageId, event_id: eventId, agreed_amount: agreedAmount, bill_id: billId, notes } = req.body || {};
    if (!clientName || typeof clientName !== "string" || !clientName.trim() || clientName.length > 120) {
      return res.status(400).json({ error: "client_name is required (max 120)" });
    }
    if (clientEmail !== undefined && clientEmail !== null && clientEmail !== "" && (typeof clientEmail !== "string" || !EMAIL_RE.test(clientEmail))) {
      return res.status(400).json({ error: "A valid client_email is required" });
    }
    let amount = null;
    if (agreedAmount !== undefined && agreedAmount !== null && agreedAmount !== "") {
      try {
        amount = money(agreedAmount, "agreed_amount");
      } catch (err) {
        return res.status(err.status || 400).json({ error: err.message });
      }
    }
    let pkg = null;
    if (packageId !== undefined && packageId !== null) {
      pkg = await prisma.studioPackage.findFirst({ where: { id: packageId, tenantId: req.user.id } });
      if (!pkg) return res.status(404).json({ error: "Package not found" });
    }
    if (eventId !== undefined && eventId !== null) {
      const event = await prisma.event.findFirst({ where: { id: eventId, ownerId: req.user.id } });
      if (!event) return res.status(404).json({ error: "Event not found" });
    }
    let bill = null;
    if (billId !== undefined && billId !== null) {
      bill = await prisma.bill.findFirst({ where: { id: billId, tenantId: req.user.id } });
      if (!bill) return res.status(404).json({ error: "Bill not found" });
    }
    const created = await prisma.booking.create({
      data: {
        tenantId: req.user.id,
        clientName: clientName.trim(),
        clientEmail: clientEmail?.toLowerCase() || null,
        clientPhone: clientPhone?.trim() || null,
        eventType: eventType?.trim() || null,
        eventDate: asDate(eventDate, "event_date"),
        packageId: pkg?.id || null,
        eventId: eventId || null,
        agreedAmount: amount,
        billId: bill?.id || null,
        notes: notes?.trim()?.slice(0, 1000) || null,
      },
    });
    res.status(201).json(bookingShape(created));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.patch("/bookings/:id", async (req, res, next) => {
  try {
    const booking = await prisma.booking.findFirst({ where: { id: req.params.id, tenantId: req.user.id } });
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    const data = {};
    const { client_name, client_email, client_phone, event_type, event_date, package_id, event_id, agreed_amount, bill_id, status, notes } = req.body || {};
    if (client_name !== undefined) {
      if (typeof client_name !== "string" || !client_name.trim() || client_name.length > 120) {
        return res.status(400).json({ error: "client_name must be a non-empty string (max 120)" });
      }
      data.clientName = client_name.trim();
    }
    if (client_email !== undefined) {
      if (client_email !== null && client_email !== "" && (typeof client_email !== "string" || !EMAIL_RE.test(client_email))) {
        return res.status(400).json({ error: "A valid client_email is required" });
      }
      data.clientEmail = client_email ? client_email.toLowerCase() : null;
    }
    if (client_phone !== undefined) data.clientPhone = client_phone?.trim() || null;
    if (event_type !== undefined) data.eventType = event_type?.trim() || null;
    if (event_date !== undefined) {
      try {
        data.eventDate = asDate(event_date, "event_date");
      } catch (err) {
        return res.status(err.status || 400).json({ error: err.message });
      }
    }
    if (package_id !== undefined) {
      if (package_id === null) {
        data.packageId = null;
      } else {
        const pkg = await prisma.studioPackage.findFirst({ where: { id: package_id, tenantId: req.user.id } });
        if (!pkg) return res.status(404).json({ error: "Package not found" });
        data.packageId = pkg.id;
      }
    }
    if (event_id !== undefined) {
      if (event_id === null) {
        data.eventId = null;
      } else {
        const event = await prisma.event.findFirst({ where: { id: event_id, ownerId: req.user.id } });
        if (!event) return res.status(404).json({ error: "Event not found" });
        data.eventId = event.id;
      }
    }
    if (agreed_amount !== undefined) {
      try {
        data.agreedAmount = money(agreed_amount, "agreed_amount");
      } catch (err) {
        return res.status(err.status || 400).json({ error: err.message });
      }
    }
    if (bill_id !== undefined) {
      if (bill_id === null) {
        data.billId = null;
      } else {
        const bill = await prisma.bill.findFirst({ where: { id: bill_id, tenantId: req.user.id } });
        if (!bill) return res.status(404).json({ error: "Bill not found" });
        data.billId = bill.id;
      }
    }
    if (status !== undefined) {
      if (!BOOKING_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of ${BOOKING_STATUSES.join(", ")}` });
      }
      data.status = status;
    }
    if (notes !== undefined) data.notes = notes?.trim()?.slice(0, 1000) || null;
    if (Object.keys(data).length === 0) return res.status(400).json({ error: "No booking change provided." });
    const updated = await prisma.booking.update({ where: { id: booking.id }, data });
    res.json(bookingShape(updated));
  } catch (err) {
    next(err);
  }
});

// Booking money view: agreed amount, linked bill summary (payable/paid/
// balance/receipts) when a bill is attached, advance vs balance split.
router.get("/bookings/:id", async (req, res, next) => {
  try {
    const booking = await prisma.booking.findFirst({ where: { id: req.params.id, tenantId: req.user.id } });
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    let bill = null;
    if (booking.billId) {
      const row = await prisma.bill.findFirst({
        where: { id: booking.billId, tenantId: req.user.id },
        include: { items: true, payments: true },
      });
      bill = summarizeBillPayment(row);
    }
    const agreed = booking.agreedAmount != null ? Number(booking.agreedAmount) : null;
    const total = bill ? bill.payable : agreed || 0;
    const paid = bill ? bill.paid : 0;
    res.json({
      ...bookingShape(booking),
      bill,
      total,
      paid_total: paid,
      balance_due: Math.max(0, total - paid),
      advance_status: total <= 0 ? "none" : paid <= 0 ? "unpaid" : paid < total ? "partial" : "paid",
    });
  } catch (err) {
    next(err);
  }
});

// Gateway intent (structure-ready): resolves 501 until a provider module
// registers credentials — never a hardcoded charge path.
router.post("/bookings/:id/payment-intent", async (req, res, next) => {
  try {
    const booking = await prisma.booking.findFirst({ where: { id: req.params.id, tenantId: req.user.id } });
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    const { provider, amount, currency } = req.body || {};
    if (typeof provider !== "string" || !provider) {
      return res.status(400).json({ error: "provider is required" });
    }
    let minor;
    try {
      const major = money(amount, "amount");
      if (major === null) return res.status(400).json({ error: "amount is required" });
      minor = Math.round(major * 100);
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }
    try {
      const intent = await createPaymentIntent({ provider, bookingId: booking.id, amountMinor: minor, currency, meta: { tenantId: req.user.id } });
      res.json({ provider, ...intent, configured_gateways: configuredGateways() });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message, configured_gateways: configuredGateways() });
    }
  } catch (err) {
    next(err);
  }
});

// --- Expenses ---

function expenseShape(e) {
  return {
    id: e.id,
    event_id: e.eventId,
    event_name: e.event?.name || null,
    category: e.category,
    amount: Number(e.amount),
    vendor: e.vendor,
    notes: e.notes,
    spent_at: e.spentAt,
    created_at: e.createdAt,
  };
}

router.get("/expenses", async (req, res, next) => {
  try {
    const { event_id: eventId, category } = req.query || {};
    const rows = await prisma.expense.findMany({
      where: {
        tenantId: req.user.id,
        ...(eventId ? { eventId } : {}),
        ...(category ? { category } : {}),
      },
      include: { event: { select: { name: true } } },
      orderBy: { spentAt: "desc" },
      take: 1000,
    });
    res.json(rows.map(expenseShape));
  } catch (err) {
    next(err);
  }
});

router.post("/expenses", async (req, res, next) => {
  try {
    const { event_id: eventId, category, amount, vendor, notes, spent_at: spentAt } = req.body || {};
    if (!category || typeof category !== "string" || !category.trim() || category.length > 80) {
      return res.status(400).json({ error: "category is required (max 80)" });
    }
    let value;
    try {
      value = money(amount, "amount");
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }
    if (value === null || value <= 0) return res.status(400).json({ error: "amount must be greater than zero" });
    if (eventId !== undefined && eventId !== null) {
      const event = await prisma.event.findFirst({ where: { id: eventId, ownerId: req.user.id } });
      if (!event) return res.status(404).json({ error: "Event not found" });
    }
    let spent = new Date();
    if (spentAt !== undefined && spentAt !== null && spentAt !== "") {
      try {
        spent = asDate(spentAt, "spent_at");
      } catch (err) {
        return res.status(err.status || 400).json({ error: err.message });
      }
    }
    const created = await prisma.expense.create({
      data: {
        tenantId: req.user.id,
        eventId: eventId || null,
        category: category.trim(),
        amount: value,
        vendor: vendor?.trim()?.slice(0, 120) || null,
        notes: notes?.trim()?.slice(0, 1000) || null,
        spentAt: spent,
      },
      include: { event: { select: { name: true } } },
    });
    res.status(201).json(expenseShape(created));
  } catch (err) {
    next(err);
  }
});

router.patch("/expenses/:id", async (req, res, next) => {
  try {
    const expense = await prisma.expense.findFirst({ where: { id: req.params.id, tenantId: req.user.id } });
    if (!expense) return res.status(404).json({ error: "Expense not found" });
    const data = {};
    const { category, amount, vendor, notes, spent_at, event_id } = req.body || {};
    if (category !== undefined) {
      if (typeof category !== "string" || !category.trim() || category.length > 80) {
        return res.status(400).json({ error: "category must be a non-empty string (max 80)" });
      }
      data.category = category.trim();
    }
    if (amount !== undefined) {
      let value;
      try {
        value = money(amount, "amount");
      } catch (err) {
        return res.status(err.status || 400).json({ error: err.message });
      }
      if (value === null || value <= 0) return res.status(400).json({ error: "amount must be greater than zero" });
      data.amount = value;
    }
    if (vendor !== undefined) data.vendor = vendor?.trim()?.slice(0, 120) || null;
    if (notes !== undefined) data.notes = notes?.trim()?.slice(0, 1000) || null;
    if (spent_at !== undefined) {
      try {
        data.spentAt = asDate(spent_at, "spent_at") || new Date();
      } catch (err) {
        return res.status(err.status || 400).json({ error: err.message });
      }
    }
    if (event_id !== undefined) {
      if (event_id === null) {
        data.eventId = null;
      } else {
        const event = await prisma.event.findFirst({ where: { id: event_id, ownerId: req.user.id } });
        if (!event) return res.status(404).json({ error: "Event not found" });
        data.eventId = event.id;
      }
    }
    if (Object.keys(data).length === 0) return res.status(400).json({ error: "No expense change provided." });
    const updated = await prisma.expense.update({
      where: { id: expense.id },
      data,
      include: { event: { select: { name: true } } },
    });
    res.json(expenseShape(updated));
  } catch (err) {
    next(err);
  }
});

router.delete("/expenses/:id", async (req, res, next) => {
  try {
    const expense = await prisma.expense.findFirst({ where: { id: req.params.id, tenantId: req.user.id } });
    if (!expense) return res.status(404).json({ error: "Expense not found" });
    await prisma.expense.delete({ where: { id: expense.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Profit estimate: booked income (bill payable where linked, else agreed
// amount) vs recorded expenses — per event or studio-wide.
router.get("/expenses/report", async (req, res, next) => {
  try {
    const { event_id: eventId } = req.query || {};
    if (eventId) {
      const event = await prisma.event.findFirst({ where: { id: eventId, ownerId: req.user.id } });
      if (!event) return res.status(404).json({ error: "Event not found" });
    }
    const [bookings, expenses] = await Promise.all([
      prisma.booking.findMany({ where: { tenantId: req.user.id, ...(eventId ? { eventId } : {}) } }),
      prisma.expense.findMany({ where: { tenantId: req.user.id, ...(eventId ? { eventId } : {}) } }),
    ]);
    let incomeTotal = 0;
    let paidTotal = 0;
    for (const b of bookings) {
      if (b.billId) {
        const bill = await prisma.bill.findFirst({
          where: { id: b.billId, tenantId: req.user.id },
          include: { items: true, payments: true },
        });
        const summary = summarizeBillPayment(bill);
        if (summary) {
          incomeTotal += summary.payable;
          paidTotal += summary.paid;
          continue;
        }
      }
      incomeTotal += b.agreedAmount != null ? Number(b.agreedAmount) : 0;
    }
    const expensesTotal = expenses.reduce((sum, e) => sum + Number(e.amount), 0);
    const byCategory = {};
    for (const e of expenses) {
      byCategory[e.category] = Math.round(((byCategory[e.category] || 0) + Number(e.amount)) * 100) / 100;
    }
    res.json({
      event_id: eventId || null,
      booking_count: bookings.length,
      income_total: Math.round(incomeTotal * 100) / 100,
      collected_total: Math.round(paidTotal * 100) / 100,
      expenses_total: Math.round(expensesTotal * 100) / 100,
      expenses_by_category: byCategory,
      profit_estimate: Math.round((incomeTotal - expensesTotal) * 100) / 100,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
