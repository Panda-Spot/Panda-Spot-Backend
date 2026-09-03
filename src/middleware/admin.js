const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

export function isAdminEmail(email) {
  return ADMIN_EMAILS.includes((email || "").toLowerCase());
}

/// MERGE (Studio-Verse): a SUPER_ADMIN-role account (see the Role enum in
/// schema.prisma) is now also accepted, alongside the original
/// ADMIN_EMAILS env-var allowlist — kept as a belt-and-suspenders
/// fallback rather than removed, since it's working production behavior.
export function requireAdmin(req, res, next) {
  if (!isAdminEmail(req.user?.email) && req.user?.role !== "SUPER_ADMIN") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}
