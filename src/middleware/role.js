/// MERGE (Studio-Verse): role-allowlist guard for the 4-tier model
/// (SUPER_ADMIN/ADMIN/USER/INVITED) added in the schema merge — see
/// MERGE_PLAN.md D2. Use after requireAuth, which attaches req.user.role.
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    next();
  };
}
