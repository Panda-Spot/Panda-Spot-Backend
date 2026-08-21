/**
 * Builds a zero-filled array of the last `days` days (oldest first) as
 * [{ date: "2026-08-01", count: N }, ...] from a plain array of Date/ISO
 * values — e.g. GuestSearch.createdAt rows. JS-side bucketing rather than a
 * SQL GROUP BY, consistent with how this codebase avoids raw SQL except
 * where the pgvector Unsupported type forces it (see lib/faces.js).
 */
export function bucketByDay(dates, days = 30) {
  const counts = new Map();
  for (const d of dates) {
    const key = new Date(d).toISOString().slice(0, 10);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const result = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(today);
    day.setDate(day.getDate() - i);
    const key = day.toISOString().slice(0, 10);
    result.push({ date: key, count: counts.get(key) || 0 });
  }
  return result;
}
