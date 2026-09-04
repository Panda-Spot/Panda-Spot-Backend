import { prisma } from "./prisma.js";

/**
 * Deletes blocklist rows whose tokens have already expired naturally — an
 * expired JWT fails `jwt.verify` before the blocklist check ever runs (see
 * middleware/auth.js), so these rows are pure dead weight. Mirrors
 * Studio-Verse's `pruneExpired` blocklist maintenance.
 */
export async function pruneExpiredBlocklist() {
  const result = await prisma.tokenBlocklist.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  if (result.count > 0) {
    console.log(`Pruned ${result.count} expired token-blocklist row(s).`);
  }
  return result.count;
}

export function startTokenMaintenanceScheduler() {
  const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly, alongside the retention sweep
  setInterval(() => {
    pruneExpiredBlocklist().catch((err) => console.error("Token blocklist prune failed:", err));
  }, CHECK_INTERVAL_MS);
}
