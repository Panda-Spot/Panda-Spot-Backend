import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/role.js";
import { computeItemsTotal, computePayable, claimNextNumber, summarizeBillPayment } from "../lib/billingAccess.js";
import { streamBillPdf, streamQuotationPdf, streamReceiptPdf } from "../lib/billingPdf.js";

const router = Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OVERPAY_EPSILON = 0.01;

/// MERGE (Studio-Verse Billing & Subscriptions): every route here is
/// scoped to the logged-in ADMIN (studio/"tenant") — a studio's own
/// service catalog, quotations, bills, and payments. See
/// lib/billingAccess.js for the shared math/numbering this reuses.
router.use(requireAuth, requireRole("ADMIN", "SUPER_ADMIN"));

/** Finds a billing client by email, creating a bare USER-role record if
 * none exists yet — this is deliberately NOT the same thing as a Photo
 * Selection ClientInvite (routes/clientInvites.js): a billing client
 * doesn't need portal login at all, just a real row to bill against. A
 * client created here has no passwordHash, so they simply can't log in
 * until/unless separately invited to a Photo Selection event. */
async function resolveOrCreateClient(email, name) {
  const normalizedEmail = email.toLowerCase();
  let client = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (client) {
    if (client.role !== "USER") {
      throw Object.assign(new Error("This email already has a different kind of PandaSpot account"), { status: 409 });
    }
    return client;
  }
  return prisma.user.create({
    data: { email: normalizedEmail, name: name?.trim() || normalizedEmail.split("@")[0], role: "USER" },
  });
}

function itemsFromBody(items) {
  if (!Array.isArray(items) || items.length === 0) return [];
  return items.map((i) => ({
    name: String(i.name || "").slice(0, 200),
    price: i.price,
    quantity: Math.max(1, parseInt(i.quantity, 10) || 1),
    discountPerUnit: i.discount_per_unit ?? 0,
  }));
}

// --- GST display settings (Phase 18H) ---
// Display-only fields printed on quotation/bill/receipt PDFs (see
// lib/billingPdf.js) — no tax math anywhere, matching Studio-Verse's own
// GST display fields. Lazily created so pre-existing studios get a row on
// first read.

function serializeBillingSettings(row) {
  return {
    gstin_number: row?.gstinNumber ?? null,
    gst_state: row?.gstState ?? null,
  };
}

router.get("/settings", async (req, res, next) => {
  try {
    const row = await prisma.tenantBillingSettings.upsert({
      where: { tenantId: req.user.id },
      create: { tenantId: req.user.id },
      update: {},
    });
    res.json(serializeBillingSettings(row));
  } catch (err) {
    next(err);
  }
});

router.patch("/settings", async (req, res, next) => {
  try {
    const { gstin_number: gstinNumber, gst_state: gstState } = req.body || {};
    const data = {};
    if (gstinNumber !== undefined) {
      if (gstinNumber !== null && (typeof gstinNumber !== "string" || gstinNumber.trim() === "")) {
        return res.status(400).json({ error: "gstin_number must be a non-empty string, or null to clear" });
      }
      data.gstinNumber = gstinNumber === null ? null : gstinNumber.trim().slice(0, 20);
    }
    if (gstState !== undefined) {
      if (gstState !== null && (typeof gstState !== "string" || gstState.trim() === "")) {
        return res.status(400).json({ error: "gst_state must be a non-empty string, or null to clear" });
      }
      data.gstState = gstState === null ? null : gstState.trim().slice(0, 60);
    }
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: "No settings change provided." });
    }
    const row = await prisma.tenantBillingSettings.upsert({
      where: { tenantId: req.user.id },
      create: { tenantId: req.user.id, ...data },
      update: data,
    });
    res.json(serializeBillingSettings(row));
  } catch (err) {
    next(err);
  }
});

// --- Service catalog ---

router.get("/services", async (req, res, next) => {  try {
    const services = await prisma.studioService.findMany({ where: { tenantId: req.user.id }, orderBy: { name: "asc" } });
    res.json(services);
  } catch (err) {
    next(err);
  }
});

router.post("/services", async (req, res, next) => {
  try {
    const { name, price } = req.body || {};
    if (!name || typeof name !== "string") return res.status(400).json({ error: "name is required" });
    const service = await prisma.studioService.create({ data: { tenantId: req.user.id, name, price: price ?? null } });
    res.status(201).json(service);
  } catch (err) {
    next(err);
  }
});

router.patch("/services/:id", async (req, res, next) => {
  try {
    const service = await prisma.studioService.findFirst({ where: { id: req.params.id, tenantId: req.user.id } });
    if (!service) return res.status(404).json({ error: "Service not found" });
    const { name, price, is_active: isActive } = req.body || {};
    const updated = await prisma.studioService.update({
      where: { id: service.id },
      data: {
        name: name ?? undefined,
        price: price ?? undefined,
        isActive: isActive ?? undefined,
      },
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// --- Quotations ---

router.post("/quotations", async (req, res, next) => {
  try {
    const { client_email: clientEmail, client_name: clientName, items, discount_amount: discountAmount } = req.body || {};
    if (!clientEmail || !EMAIL_RE.test(clientEmail)) return res.status(400).json({ error: "A valid client_email is required" });
    const parsedItems = itemsFromBody(items);

    const client = await resolveOrCreateClient(clientEmail, clientName);

    const quotation = await prisma.$transaction(async (tx) => {
      const number = await claimNextNumber(tx, req.user.id, "nextQuotationNumber");
      return tx.quotation.create({
        data: {
          tenantId: req.user.id,
          clientId: client.id,
          quotationNumber: number,
          discountAmount: discountAmount ?? 0,
          items: { create: parsedItems },
        },
        include: { items: true, client: true },
      });
    });
    res.status(201).json(serializeQuotation(quotation));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.get("/quotations", async (req, res, next) => {
  try {
    const quotations = await prisma.quotation.findMany({
      where: { tenantId: req.user.id },
      include: { items: true, client: true, bill: { include: { items: true, payments: true } } },
      orderBy: { quotationNumber: "desc" },
    });
    res.json(quotations.map(serializeQuotation));
  } catch (err) {
    next(err);
  }
});

router.get("/quotations/:id", async (req, res, next) => {
  try {
    const quotation = await prisma.quotation.findFirst({
      where: { id: req.params.id, tenantId: req.user.id },
      include: { items: true, client: true, bill: { include: { items: true, payments: true } } },
    });
    if (!quotation) return res.status(404).json({ error: "Quotation not found" });
    res.json(serializeQuotation(quotation));
  } catch (err) {
    next(err);
  }
});

router.get("/quotations/:id/pdf", async (req, res, next) => {
  try {
    const quotation = await prisma.quotation.findFirst({
      where: { id: req.params.id, tenantId: req.user.id },
      include: { items: { orderBy: { createdAt: "asc" } }, client: true, tenant: true },
    });
    if (!quotation) return res.status(404).json({ error: "Quotation not found" });
    const settings = await prisma.tenantBillingSettings.findUnique({ where: { tenantId: req.user.id } });
    return streamQuotationPdf(res, { tenant: quotation.tenant, settings, quotation });
  } catch (err) {
    next(err);
  }
});

router.patch("/quotations/:id", async (req, res, next) => {
  try {
    const quotation = await prisma.quotation.findFirst({ where: { id: req.params.id, tenantId: req.user.id } });
    if (!quotation) return res.status(404).json({ error: "Quotation not found" });
    if (quotation.status === "CONFIRMED") {
      return res.status(409).json({ error: "This quotation is already confirmed and can't be edited." });
    }

    const { items, discount_amount: discountAmount } = req.body || {};
    const parsedItems = items !== undefined ? itemsFromBody(items) : null;

    const updated = await prisma.$transaction(async (tx) => {
      if (parsedItems) {
        await tx.quotationItem.deleteMany({ where: { quotationId: quotation.id } });
      }
      return tx.quotation.update({
        where: { id: quotation.id },
        data: {
          discountAmount: discountAmount ?? undefined,
          items: parsedItems ? { create: parsedItems } : undefined,
        },
        include: { items: true, client: true },
      });
    });
    res.json(serializeQuotation(updated));
  } catch (err) {
    next(err);
  }
});

router.delete("/quotations/:id", async (req, res, next) => {
  try {
    const quotation = await prisma.quotation.findFirst({ where: { id: req.params.id, tenantId: req.user.id } });
    if (!quotation) return res.status(404).json({ error: "Quotation not found" });
    if (quotation.status === "CONFIRMED") {
      return res.status(409).json({ error: "This quotation is already confirmed and can't be deleted." });
    }
    await prisma.quotation.delete({ where: { id: quotation.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// MERGE: the ONLY way a Bill gets created — enforced here in application
// code, matching Studio-Verse exactly (a direct POST bypassing any UI is
// still blocked by these two checks).
router.post("/quotations/:id/confirm", async (req, res, next) => {
  try {
    const quotation = await prisma.quotation.findFirst({
      where: { id: req.params.id, tenantId: req.user.id },
      include: { items: true, bill: true },
    });
    if (!quotation) return res.status(404).json({ error: "Quotation not found" });
    if (quotation.status === "CONFIRMED" || quotation.bill) {
      return res.status(409).json({ error: "This quotation is already confirmed." });
    }
    if (quotation.items.length === 0) {
      return res.status(400).json({ error: "Cannot confirm an empty quotation." });
    }

    const bill = await prisma.$transaction(async (tx) => {
      const number = await claimNextNumber(tx, req.user.id, "nextBillNumber");
      const created = await tx.bill.create({
        data: {
          tenantId: req.user.id,
          clientId: quotation.clientId,
          quotationId: quotation.id,
          billNumber: number,
          discountAmount: quotation.discountAmount,
          items: {
            create: quotation.items.map((i) => ({
              name: i.name,
              price: i.price,
              quantity: i.quantity,
              discountPerUnit: i.discountPerUnit,
            })),
          },
        },
        include: { items: true, client: true },
      });
      await tx.quotation.update({ where: { id: quotation.id }, data: { status: "CONFIRMED" } });
      return created;
    });
    res.status(201).json(serializeBill(bill));
  } catch (err) {
    next(err);
  }
});

// --- Bills (immutable — deliberately no PATCH/DELETE route) ---

router.get("/bills", async (req, res, next) => {
  try {
    const bills = await prisma.bill.findMany({
      where: { tenantId: req.user.id },
      include: { items: true, client: true, payments: true },
      orderBy: { billNumber: "desc" },
    });
    res.json(bills.map(serializeBill));
  } catch (err) {
    next(err);
  }
});

router.get("/bills/:id", async (req, res, next) => {
  try {
    const bill = await prisma.bill.findFirst({
      where: { id: req.params.id, tenantId: req.user.id },
      include: { items: true, client: true, payments: { orderBy: { receiptNumber: "asc" } } },
    });
    if (!bill) return res.status(404).json({ error: "Bill not found" });
    res.json(serializeBill(bill));
  } catch (err) {
    next(err);
  }
});

router.get("/bills/:id/pdf", async (req, res, next) => {
  try {
    const bill = await prisma.bill.findFirst({
      where: { id: req.params.id, tenantId: req.user.id },
      include: {
        items: { orderBy: { createdAt: "asc" } },
        client: true,
        tenant: true,
        payments: { orderBy: { receiptNumber: "asc" } },
      },
    });
    if (!bill) return res.status(404).json({ error: "Bill not found" });
    const settings = await prisma.tenantBillingSettings.findUnique({ where: { tenantId: req.user.id } });
    return streamBillPdf(res, { tenant: bill.tenant, settings, bill });
  } catch (err) {
    next(err);
  }
});

router.get("/payments/:receiptNumber/pdf", async (req, res, next) => {
  try {
    const receiptNumber = Number(req.params.receiptNumber);
    if (!Number.isInteger(receiptNumber) || receiptNumber < 1) {
      return res.status(400).json({ error: "Invalid receipt number" });
    }

    const payment = await prisma.payment.findFirst({
      where: { tenantId: req.user.id, receiptNumber },
      include: {
        tenant: true,
        bill: {
          include: {
            client: true,
            items: true,
            payments: { orderBy: { receiptNumber: "asc" } },
          },
        },
      },
    });
    if (!payment) return res.status(404).json({ error: "Receipt not found" });

    const payable = computePayable(payment.bill.items || [], payment.bill.discountAmount);
    const paidThroughThis = payment.bill.payments
      .filter((p) => p.receiptNumber <= payment.receiptNumber)
      .reduce((sum, p) => sum + Number(p.amount), 0);
    const balanceAfter = Math.max(0, payable - paidThroughThis);
    const settings = await prisma.tenantBillingSettings.findUnique({ where: { tenantId: req.user.id } });

    return streamReceiptPdf(res, { tenant: payment.tenant, settings, payment, bill: payment.bill, balanceAfter });
  } catch (err) {
    next(err);
  }
});

// --- Payments ---

router.post("/bills/:id/payments", async (req, res, next) => {
  try {
    const bill = await prisma.bill.findFirst({
      where: { id: req.params.id, tenantId: req.user.id },
      include: { items: true, payments: true },
    });
    if (!bill) return res.status(404).json({ error: "Bill not found" });
    if (bill.status === "PAID") return res.status(409).json({ error: "This bill is already fully paid." });

    const { amount, method, remark } = req.body || {};
    const paymentAmount = Number(amount);
    if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
      return res.status(400).json({ error: "A positive amount is required" });
    }
    const validMethods = ["CASH", "GPAY", "CARD", "BANK_TRANSFER", "CHEQUE"];
    if (!validMethods.includes(method)) {
      return res.status(400).json({ error: `method must be one of ${validMethods.join(", ")}` });
    }

    const payable = computePayable(bill.items, bill.discountAmount);
    const alreadyPaid = bill.payments.reduce((sum, p) => sum + Number(p.amount), 0);
    const remaining = payable - alreadyPaid;
    // MERGE (Studio-Verse): the 0.01 epsilon absorbs Decimal/float
    // rounding — ported verbatim, not an arbitrary choice.
    if (paymentAmount > remaining + OVERPAY_EPSILON) {
      return res.status(400).json({ error: `Payment exceeds the remaining balance of ${remaining.toFixed(2)}.` });
    }

    const result = await prisma.$transaction(async (tx) => {
      const number = await claimNextNumber(tx, req.user.id, "nextReceiptNumber");
      const payment = await tx.payment.create({
        data: { tenantId: req.user.id, billId: bill.id, receiptNumber: number, amount: paymentAmount, method, remark },
      });
      const newPaidTotal = alreadyPaid + paymentAmount;
      const newStatus = newPaidTotal >= payable - OVERPAY_EPSILON ? "PAID" : "PARTIALLY_PAID";
      await tx.bill.update({ where: { id: bill.id }, data: { status: newStatus } });
      return { payment, status: newStatus };
    });

    res.status(201).json({
      receipt_number: result.payment.receiptNumber,
      amount: Number(result.payment.amount),
      method: result.payment.method,
      bill_status: result.status,
    });
  } catch (err) {
    next(err);
  }
});

function serializeQuotation(q) {
  const items = q.items || [];
  return {
    id: q.id,
    quotation_number: q.quotationNumber,
    status: q.status,
    discount_amount: Number(q.discountAmount),
    payable: computePayable(items, q.discountAmount),
    client: q.client ? { id: q.client.id, email: q.client.email, name: q.client.name } : undefined,
    items: items.map(serializeItem),
    has_bill: !!q.bill,
    // Reflect the generated bill's live payment state (paid/balance/
    // receipts) so the quotations list can show it without a second
    // round trip — null until confirmed.
    bill: summarizeBillPayment(q.bill),
    created_at: q.createdAt,
  };
}

function serializeBill(b) {
  const items = b.items || [];
  const payments = b.payments || [];
  const payable = computePayable(items, b.discountAmount);
  const paid = payments.reduce((sum, p) => sum + Number(p.amount), 0);
  return {
    id: b.id,
    bill_number: b.billNumber,
    status: b.status,
    discount_amount: Number(b.discountAmount),
    payable,
    paid,
    remaining: Math.max(0, payable - paid),
    receipt_count: payments.length,
    client: b.client ? { id: b.client.id, email: b.client.email, name: b.client.name } : undefined,
    items: items.map(serializeItem),
    payments: payments.map((p) => ({
      receipt_number: p.receiptNumber,
      amount: Number(p.amount),
      method: p.method,
      remark: p.remark,
      created_at: p.createdAt,
    })),
    created_at: b.createdAt,
  };
}

function serializeItem(i) {
  return {
    name: i.name,
    price: Number(i.price),
    quantity: i.quantity,
    discount_per_unit: Number(i.discountPerUnit),
  };
}

export default router;
