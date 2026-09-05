import { prisma } from "./prisma.js";

/// Lead capture + attendee activity (Phase 10). Guests are keyed by the
/// same anonymous guestClientId the rest of the guest surface uses.
/// Everything here is best-effort from route hooks: a tracking failure
/// must never break a guest's search, download, or gallery view.

export const LEAD_MODES = ["disabled", "optional", "required_search", "required_download"];
export const GUEST_TYPES = ["guest", "family", "friend", "vendor", "other"];
export const LEAD_CONSENT_VERSION = "v1";
export const ACTIVITY_ACTIONS = ["gallery_open", "selfie_search", "download", "share", "feedback"];

export function leadConsentText(event) {
  return `I agree that ${event.name ? `"${event.name}"` : "this event"}'s studio may contact me about my photos. I understand I can ask for my data to be deleted at any time.`;
}

/// First-sight upsert: creates the lead row (or just bumps lastSeenAt).
/// Contact fields are only ever set from explicit guest input (upsertLead).
export async function touchLead({ eventId, guestClientId, source }) {
  if (!eventId || !guestClientId) return null;
  try {
    const existing = await prisma.guestLead.findUnique({
      where: { eventId_guestClientId: { eventId, guestClientId } },
    });
    if (existing) {
      return prisma.guestLead.update({
        where: { id: existing.id },
        data: { lastSeenAt: new Date() },
      });
    }
    return await prisma.guestLead.create({
      data: { eventId, guestClientId, source: source || null },
    });
  } catch (err) {
    console.error(`Lead touch failed (event ${eventId}):`, err.message);
    return null;
  }
}

export async function logActivity({ eventId, guestClientId, action, meta }) {
  if (!eventId || !guestClientId || !ACTIVITY_ACTIONS.includes(action)) return;
  try {
    await prisma.guestActivity.create({
      data: { eventId, guestClientId, action, meta: meta || null },
    });
  } catch (err) {
    console.error(`Activity log failed (event ${eventId}, ${action}):`, err.message);
  }
}

/// A lead is "captured" when it has a name, a way to reach them, and
/// their consent. Required-mode gates check this — not mere row existence.
export function isLeadComplete(lead) {
  if (!lead) return false;
  return !!(lead.name?.trim() && (lead.email?.trim() || lead.phone?.trim()) && lead.consentGiven);
}

/// Gate for search ("search") and download ("download") flows. Null when
/// the mode doesn't gate that action; throws { status:403,
//  code:"lead_required" } when it does and the lead is incomplete.
export async function requireLeadFor(event, kind, guestClientId) {
  const mode = event.leadCaptureMode || "disabled";
  const gatesSearch = mode === "required_search";
  const gatesDownload = mode === "required_download";
  if ((kind === "search" && !gatesSearch) || (kind === "download" && !gatesDownload)) return null;
  if (!guestClientId) {
    throw Object.assign(new Error("Please share your details first — this gallery asks every guest to introduce themselves."), {
      status: 403,
      code: "lead_required",
    });
  }
  const lead = await prisma.guestLead.findUnique({
    where: { eventId_guestClientId: { eventId: event.id, guestClientId } },
  });
  if (isLeadComplete(lead)) return lead;
  throw Object.assign(
    new Error(
      kind === "search"
        ? "Please share your details first — this event needs them before a face search can run."
        : "Please share your details first — this event needs them before downloads."
    ),
    { status: 403, code: "lead_required" }
  );
}
