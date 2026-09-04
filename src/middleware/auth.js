import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { envSuperAdminUser, isEnvSuperAdminEmail } from "./admin.js";

const JWT_SECRET = process.env.JWT_SECRET;
const COOKIE_NAME = "pandaspot_token";
const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days, matches the existing token lifetime

/// MERGE (Studio-Verse): every token gets a unique `jti` so a single token
/// can be blocklisted early (real logout, "log out everywhere" after a
/// password reset) without needing to rotate JWT_SECRET and invalidate
/// every session at once.
export function signToken(user) {
  const isEnvSuperAdmin = user.role === "SUPER_ADMIN" && isEnvSuperAdminEmail(user.email) && user.id === "env-super-admin";
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, env_super_admin: isEnvSuperAdmin, jti: randomUUID() },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL_SECONDS }
  );
}

// The frontend (Vercel) and this API (VPS) live on entirely different
// registrable domains in production, not just different ports — a genuinely
// cross-site setup. `SameSite=Lax` only sends a cookie on top-level
// navigations, never on cross-site fetch()/XHR, so every authenticated
// request after login would silently drop the cookie and 401. `None`
// requires `Secure`, which is fine here since everything is HTTPS in
// production and browsers treat `http://localhost` as a secure context too,
// so this works for local dev against a local server without changes.
const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "none",
  secure: true,
};

export function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    ...COOKIE_OPTIONS,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  });
}

export function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, COOKIE_OPTIONS);
}

/**
 * The cookie above is kept as a harmless bonus (works fine if this ever ends
 * up same-site with its frontend), but it's no longer the primary auth
 * mechanism — cross-site cookies get silently dropped by third-party-cookie
 * blocking in Safari (default) and increasingly Chrome, with no reliable way
 * to detect that from the server side. The real mechanism is a Bearer token:
 * every login/register/google response includes `token` in the JSON body;
 * the frontend stores it (localStorage) and sends it back as
 * `Authorization: Bearer <token>` on every request. The one exception is the
 * SSE upload-progress stream, since EventSource can't set custom headers —
 * that one passes the token as a `?token=` query param instead.
 */
function extractToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  if (req.query?.token) return req.query.token;
  return req.cookies?.[COOKIE_NAME];
}

/**
 * Reads and verifies the auth token (header, query param, or cookie, in
 * that order), attaches { id, email } to req.user, or 401s.
 *
 * Also checks User.suspendedAt on every call — a deliberate departure from
 * this being otherwise-stateless JWT verification (the token itself proves
 * nothing about current suspension status, and a token is valid for up to
 * 30 days). Only touches photographer-facing routes, never guest traffic,
 * so the extra query per request is an acceptable cost for a suspension to
 * actually take effect immediately instead of only at the account's next
 * fresh login. See routes/admin.js for how suspendedAt gets set.
 */
export async function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "Invalid or expired session" });
  }
  try {
    // MERGE (Studio-Verse): reject a token that's been explicitly logged
    // out / force-invalidated early, even though it's still
    // cryptographically valid and unexpired.
    if (payload.jti) {
      const blocked = await prisma.tokenBlocklist.findUnique({ where: { jti: payload.jti } });
      if (blocked) {
        return res.status(401).json({ error: "Invalid or expired session" });
      }
    }
    if (payload.env_super_admin && payload.sub === "env-super-admin" && isEnvSuperAdminEmail(payload.email)) {
      const admin = envSuperAdminUser();
      if (!admin) return res.status(401).json({ error: "Invalid or expired session" });
      req.user = { id: admin.id, email: admin.email, jti: payload.jti, exp: payload.exp, role: admin.role, envSuperAdmin: true };
      return next();
    }
    const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { suspendedAt: true, role: true } });
    if (!user) {
      // Deleted by an admin (see routes/admin.js) — the token is otherwise
      // still cryptographically valid for up to 30 days, so this needs an
      // explicit check rather than relying on the JWT alone.
      return res.status(401).json({ error: "Invalid or expired session" });
    }
    if (user.suspendedAt) {
      return res.status(403).json({ error: "This account has been suspended" });
    }
    req.user = { id: payload.sub, email: payload.email, jti: payload.jti, exp: payload.exp, role: user.role };
    return next();
  } catch (err) {
    return next(err);
  }
}

/// MERGE (Studio-Verse): blocklists the currently-authenticated request's
/// own token so it can't be reused, even though it hasn't naturally
/// expired yet. Call from routes/auth.js's /logout (real invalidation,
/// not just clearing the cookie) and anywhere a password changes /
/// "log out everywhere" is triggered.
export async function blocklistToken({ jti, exp }) {
  if (!jti || !exp) return; // older tokens signed before this feature have no jti — nothing to blocklist
  await prisma.tokenBlocklist.upsert({
    where: { jti },
    create: { jti, expiresAt: new Date(exp * 1000) },
    update: {},
  });
}

/** Non-throwing variant: attaches req.user if a valid token is present, otherwise leaves it undefined. */
export function attachUserIfPresent(req, _res, next) {
  const token = extractToken(req);
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      req.user = { id: payload.sub, email: payload.email };
    } catch {
      // ignore invalid token, treat as anonymous
    }
  }
  next();
}

export { COOKIE_NAME };
