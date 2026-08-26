import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma.js";

const JWT_SECRET = process.env.JWT_SECRET;
const COOKIE_NAME = "pandaspot_token";

export function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: "30d" });
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
    const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { suspendedAt: true } });
    if (!user) {
      // Deleted by an admin (see routes/admin.js) — the token is otherwise
      // still cryptographically valid for up to 30 days, so this needs an
      // explicit check rather than relying on the JWT alone.
      return res.status(401).json({ error: "Invalid or expired session" });
    }
    if (user.suspendedAt) {
      return res.status(403).json({ error: "This account has been suspended" });
    }
  } catch (err) {
    return next(err);
  }
  req.user = { id: payload.sub, email: payload.email };
  next();
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
