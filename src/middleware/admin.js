const SUPER_ADMIN_EMAIL = (process.env.SUPER_ADMIN_EMAIL || process.env.ADMIN_EMAIL || "")
  .trim()
  .toLowerCase();

export function isAdminEmail(email) {
  return !!SUPER_ADMIN_EMAIL && SUPER_ADMIN_EMAIL === (email || "").toLowerCase();
}

export function isEnvSuperAdminEmail(email) {
  return isAdminEmail(email);
}

export function isEnvSuperAdminCredentials(email, password) {
  return isEnvSuperAdminEmail(email) && !!process.env.SUPER_ADMIN_PASSWORD && password === process.env.SUPER_ADMIN_PASSWORD;
}

export function envSuperAdminUser() {
  if (!SUPER_ADMIN_EMAIL) return null;
  return {
    id: "env-super-admin",
    email: SUPER_ADMIN_EMAIL,
    name: process.env.SUPER_ADMIN_NAME || "PandaSpot Super Admin",
    role: "SUPER_ADMIN",
    emailVerifiedAt: new Date(),
  };
}

/// Platform admin access is restricted to the SUPER_ADMIN role. The
/// production super-admin account can be env-backed, so it does not need a
/// User row in the database.
export function requireAdmin(req, res, next) {
  if (req.user?.role !== "SUPER_ADMIN") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}
