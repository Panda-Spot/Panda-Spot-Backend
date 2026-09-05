import { prisma } from "./prisma.js";

/// Consent-first Face Search + guest-data privacy (Phase 2).
///
/// Selfie-lifecycle honesty note: uploads arrive via multer memoryStorage
/// (see middleware/upload.js) — selfie bytes NEVER touch disk. The only
/// biometric persisted is the GuestSearch embedding row. "Auto-delete" of
/// selfies therefore means: process in memory, then explicitly zero the
/// buffers (scrubSelfieBuffers) instead of waiting for GC. Retention
/// settings below govern the persisted search records, not raw files.

export const PRIVACY_CONSENT_VERSION = "v1";

export function defaultPrivacyNotice(studioName, eventName) {
  const studio = studioName || "the studio";
  return (
    `To find your photos at ${eventName || "this event"}, ${studio} scans your selfie for faces and ` +
    `compares it with faces in the event gallery. Your selfie is used only for this search — it is never ` +
    `saved or shared, and the search record can be deleted on request. Tick the box to agree and start your search.`
  );
}

export function effectivePrivacyNotice(event) {
  if (event.privacyNoticeText && event.privacyNoticeText.trim()) return event.privacyNoticeText;
  return defaultPrivacyNotice(event.owner?.studioName, event.name);
}

/// Gate for POST /e/:slug/search[/group]. Returns the GuestConsent row id
/// when consent was just logged, null when the event doesn't require it.
/// Throws { status:403 } when required but not given. `consented` arrives
/// from multipart bodies, so "true"/"1" count alongside boolean true.
export async function requireSelfieConsent(event, { consented, guestClientId, req }) {
  if (!event.requireFaceSearchConsent) return null;
  const given = consented === true || consented === "true" || consented === "1";
  if (!given) {
    throw Object.assign(
      new Error("Please tick the consent box first — this event needs your permission before a face search can run."),
      { status: 403, code: "consent_required" }
    );
  }
  const row = await prisma.guestConsent.create({
    data: {
      eventId: event.id,
      guestClientId: guestClientId || "anonymous",
      consentText: effectivePrivacyNotice(event),
      consentVersion: PRIVACY_CONSENT_VERSION,
      ip: req?.ip || null,
      userAgent: (req?.get?.("user-agent") || "").slice(0, 300) || null,
    },
  });
  return row.id;
}

/// Zeroes multer memory buffers in place right after matching. Best-effort
/// and synchronous — call it in a finally so early returns can't skip it.
export function scrubSelfieBuffers(files) {
  for (const file of files || []) {
    try {
      if (file?.buffer) file.buffer.fill(0);
    } catch {
      // A buffer that can't be scrubbed is still GC'd with the request —
      // never let cleanup break the response.
    }
  }
}

/// Everything the platform holds for one guest id on one event — the
/// payload behind both the guest's export request and the admin's review.
export async function resolveGuestData(eventId, guestClientId) {
  const [searches, alerts, reactions, comments, consents, requests, lead, activities] = await Promise.all([
    prisma.guestSearch.findMany({ where: { eventId, guestClientId }, orderBy: { createdAt: "asc" } }),
    prisma.guestAlertSubscription.findMany({ where: { eventId, guestClientId } }),
    prisma.photoLike.findMany({ where: { eventId, guestClientId } }),
    prisma.photoComment.findMany({ where: { eventId, guestClientId }, orderBy: { createdAt: "asc" } }),
    prisma.guestConsent.findMany({ where: { eventId, guestClientId }, orderBy: { consentedAt: "asc" } }),
    prisma.guestDataRequest.findMany({ where: { eventId, guestClientId }, orderBy: { createdAt: "asc" } }),
    // Phase 10: the guest's lead row + activity trail join the export.
    prisma.guestLead.findUnique({ where: { eventId_guestClientId: { eventId, guestClientId } } }),
    prisma.guestActivity.findMany({ where: { eventId, guestClientId }, orderBy: { createdAt: "asc" } }),
  ]);
  return {
    searches: searches.map((s) => ({
      id: s.id,
      faces_detected: s.facesDetected,
      match_count: s.matchCount,
      created_at: s.createdAt,
    })),
    alert_subscriptions: alerts.map((a) => ({
      channel: a.channel,
      contact: a.contact,
      active: a.active,
      created_at: a.createdAt,
    })),
    reactions: reactions.map((r) => ({ photo_id: r.photoId, reaction: r.reactionType, created_at: r.createdAt })),
    comments: comments.map((c) => ({ photo_id: c.photoId, name: c.guestName, text: c.text, created_at: c.createdAt })),
    consents: consents.map((c) => ({ consented_at: c.consentedAt, version: c.consentVersion })),
    requests: requests.map((r) => ({ type: r.type, status: r.status, created_at: r.createdAt, resolved_at: r.resolvedAt })),
    lead: lead
      ? {
          name: lead.name,
          phone: lead.phone,
          email: lead.email,
          guest_type: lead.guestType,
          consent_given: lead.consentGiven,
          source: lead.source,
          first_seen_at: lead.firstSeenAt,
          last_seen_at: lead.lastSeenAt,
        }
      : null,
    activities: activities.map((a) => ({ action: a.action, meta: a.meta, created_at: a.createdAt })),
  };
}

/// Erases one guest's Face Search footprint. MatchFeedback rows go first
/// (no DB cascade from GuestSearch). Consent rows are deliberately KEPT —
/// they're the legal proof processing was allowed, not biometric data.
/// Returns per-table counts for the admin audit trail.
export async function eraseGuestData(eventId, guestClientId) {
  const searchIds = (
    await prisma.guestSearch.findMany({ where: { eventId, guestClientId }, select: { id: true } })
  ).map((s) => s.id);
  const feedback = searchIds.length
    ? await prisma.matchFeedback.deleteMany({ where: { searchId: { in: searchIds } } })
    : { count: 0 };
  const [searches, alerts, reactions, comments, leads, activities] = await Promise.all([
    prisma.guestSearch.deleteMany({ where: { eventId, guestClientId } }),
    prisma.guestAlertSubscription.deleteMany({ where: { eventId, guestClientId } }),
    prisma.photoLike.deleteMany({ where: { eventId, guestClientId } }),
    prisma.photoComment.deleteMany({ where: { eventId, guestClientId } }),
    // Phase 10: the lead row + activity trail are the guest's data too.
    prisma.guestLead.deleteMany({ where: { eventId, guestClientId } }),
    prisma.guestActivity.deleteMany({ where: { eventId, guestClientId } }),
  ]);
  return {
    searches: searches.count,
    feedback: feedback.count,
    alert_subscriptions: alerts.count,
    reactions: reactions.count,
    comments: comments.count,
    leads: leads.count,
    activities: activities.count,
  };
}

/// Hourly sweep (mirrors lib/photoRetention.js): purges GuestSearch
/// embedding rows older than each opted-in event's guestDataRetentionDays.
/// Null = keep until event deletion. Consent audit rows are never purged.
export async function runGuestDataRetentionSweep() {
  const events = await prisma.event.findMany({
    where: { guestDataRetentionDays: { not: null } },
    select: { id: true, guestDataRetentionDays: true },
  });
  let purgedSearches = 0;
  let purgedFeedback = 0;
  for (const event of events) {
    const days = event.guestDataRetentionDays;
    if (!Number.isFinite(days) || days < 0) continue;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    try {
      const stale = await prisma.guestSearch.findMany({
        where: { eventId: event.id, createdAt: { lt: cutoff } },
        select: { id: true },
      });
      if (stale.length === 0) continue;
      const ids = stale.map((s) => s.id);
      purgedFeedback += (await prisma.matchFeedback.deleteMany({ where: { searchId: { in: ids } } })).count;
      purgedSearches += (await prisma.guestSearch.deleteMany({ where: { id: { in: ids } } })).count;
    } catch (err) {
      console.error(`Guest-data retention sweep failed for event ${event.id}:`, err.message);
    }
  }
  return { purgedSearches, purgedFeedback };
}

export function startGuestDataRetentionScheduler() {
  const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly — cheap no-op when nothing opted in
  setInterval(() => {
    runGuestDataRetentionSweep().catch((err) => console.error("Guest-data retention sweep failed:", err));
  }, CHECK_INTERVAL_MS);
}
