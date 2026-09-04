export const EVENT_EXPIRY_DAYS = 90;

export function computeExpiresAt(fromDate = new Date()) {
  const d = new Date(fromDate);
  d.setDate(d.getDate() + EVENT_EXPIRY_DAYS);
  return d;
}

export function isExpired(event) {
  // MERGE (Studio-Verse archive, Phase 18E): an archived event reads as
  // guest-closed everywhere this helper gates (all of routes/guest.js) —
  // archiving hides the event from guests exactly like the 90-day
  // soft-close does, while the studio keeps full access and can restore.
  if (event.archivedAt) return true;
  return event.expiresAt && new Date(event.expiresAt) < new Date();
}
