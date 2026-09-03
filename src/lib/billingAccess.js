/// MERGE (Studio-Verse Billing & Subscriptions): ported field-for-field
/// from Studio-Verse's src/utils/billingAccess.js — same math, same
/// atomic-numbering pattern, translated to this project's camelCase
/// Prisma models and ESM.

/** Flat per-unit discount, then quantity — matches Studio-Verse exactly
 * (no percentage discounts anywhere in this model). */
export function computeItemsTotal(items) {
  return items.reduce((sum, item) => {
    const unit = Number(item.price) - Number(item.discountPerUnit || 0);
    return sum + unit * item.quantity;
  }, 0);
}

/** Whole-document flat discount on top of the summed items — clamped to
 * never go negative (a discount larger than the item total is not an
 * error, it's just floored at zero, same as Studio-Verse). */
export function computePayable(items, discountAmount) {
  const itemsTotal = computeItemsTotal(items);
  return Math.max(0, itemsTotal - Number(discountAmount || 0));
}

/**
 * Atomically claims the next sequential number for a document type
 * (quotation/bill/receipt), scoped per tenant. Must be called inside the
 * same `prisma.$transaction` that creates the document — the upsert's
 * `increment` is what makes two concurrent requests never collide.
 * `field` is one of "nextQuotationNumber" | "nextBillNumber" |
 * "nextReceiptNumber" on TenantBillingSettings.
 */
export async function claimNextNumber(tx, tenantId, field) {
  const settings = await tx.tenantBillingSettings.upsert({
    where: { tenantId },
    update: { [field]: { increment: 1 } },
    create: { tenantId, [field]: 2 },
  });
  return settings[field] - 1;
}
