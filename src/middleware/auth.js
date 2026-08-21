import jwt from "jsonwebtoken";

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

/** Reads and verifies the JWT cookie, attaches { id, email } to req.user, or 401s. */
export function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: payload.sub, email: payload.email };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired session" });
  }
}

/** Non-throwing variant: attaches req.user if a valid cookie is present, otherwise leaves it undefined. */
export function attachUserIfPresent(req, _res, next) {
  const token = req.cookies?.[COOKIE_NAME];
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
