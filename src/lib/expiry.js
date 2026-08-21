export const EVENT_EXPIRY_DAYS = 90;

export function computeExpiresAt(fromDate = new Date()) {
  const d = new Date(fromDate);
  d.setDate(d.getDate() + EVENT_EXPIRY_DAYS);
  return d;
}

export function isExpired(event) {
  return event.expiresAt && new Date(event.expiresAt) < new Date();
}
