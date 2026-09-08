import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomBytes } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { prisma } from "../lib/prisma.js";
import { signToken, setAuthCookie, clearAuthCookie, requireAuth, blocklistToken, sessionTtlSeconds, sessionAbsoluteCapSeconds } from "../middleware/auth.js";
import { sendEmailVerificationEmail, sendPasswordResetEmail } from "../lib/mailer.js";
import { activateTrial } from "../lib/subscriptionAccess.js";
import { authLimiter, registerLimiter } from "../lib/rateLimiters.js";
import { envSuperAdminUser, isAdminEmail, isEnvSuperAdminCredentials, isEnvSuperAdminEmail } from "../middleware/admin.js";
import {
  isDriveBackupConfigured,
  isDriveBackupBetaUser,
  getConsentUrl,
  exchangeCodeForRefreshToken,
} from "../lib/driveBackupAuth.js";

const PUBLIC_WEB_URL = process.env.PUBLIC_WEB_URL || "http://localhost:5173";

const router = Router();
const BCRYPT_ROUNDS = 10;

// MERGE (Studio-Verse): account-lockout tuning, same env-driven pattern
// Studio-Verse used.
const ACCOUNT_LOCK_MAX_FAILED_ATTEMPTS = parseInt(process.env.ACCOUNT_LOCK_MAX_FAILED_ATTEMPTS || "5", 10);
const ACCOUNT_LOCK_DURATION_MINUTES = parseInt(process.env.ACCOUNT_LOCK_DURATION_MINUTES || "15", 10);
// A real bcrypt hash of a value nobody will ever type, compared against on
// every login for a nonexistent/passwordless account — keeps the response
// time indistinguishable from a real wrong-password check (Studio-Verse's
// timing-attack-resistant lookup, see STUDIO_VERSE_HANDOFF.md §3).
const DUMMY_HASH = "$2a$10$CwTycUXWue0Thq9StjUM0uJ8sgIhbtqE3Yb1xlXwGofYBBnbe1lYq";

// Unset GOOGLE_CLIENT_ID means Google Sign-In is simply not configured yet —
// the /auth/google route below cleanly 503s in that case rather than crash.
const googleClient = process.env.GOOGLE_CLIENT_ID ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID) : null;

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    email_verified: !!user.emailVerifiedAt,
    // MERGE (Studio-Verse): the new 4-tier role — kept alongside is_admin
    // for the frontend's existing admin navigation checks.
    role: user.role,
    is_admin: user.role === "SUPER_ADMIN",
    // Advanced/beta feature — see lib/driveBackupAuth.js. `drive_backup_beta`
    // lets the frontend show the per-event toggle only to allowlisted
    // photographers; `drive_backup_configured` reflects the platform's own
    // single Drive account (not per-user — see that file's top comment).
    drive_backup_beta: isDriveBackupBetaUser(user.email),
    drive_backup_configured: isDriveBackupConfigured(),
  };
}

/// Session model: "remember me" is an explicit opt-in at login.
/// - Unchecked (default): 30-minute token, renewed on activity via
///   POST /auth/refresh, hard-capped at 24 h from the original login.
/// - Checked: 7-day token, never renewed — the session simply ends 7 days
///   after login. Exempt from the frontend's 30-minute idle logout.
function parseRememberMe(body, defaultValue = false) {
  const v = body?.remember_me ?? body?.rememberMe;
  if (v === undefined || v === null) return defaultValue;
  return v === true || v === "true" || v === 1 || v === "1";
}

/// Issues a token + cookie for `user` and returns the JSON body the
/// frontend needs to run its session timers (absolute expiry + class).
function issueSession(res, user, rememberMe) {
  const token = signToken(user, rememberMe);
  setAuthCookie(res, token, rememberMe);
  const expiresIn = sessionTtlSeconds(rememberMe);
  return {
    ...publicUser(user),
    token,
    remember_me: rememberMe,
    expires_in: expiresIn,
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}

router.post("/register", registerLimiter, async (req, res, next) => {
  try {
    const { email, password, name } = req.body || {};
    if (!email || typeof email !== "string" || !password || typeof password !== "string" || !name || typeof name !== "string") {
      return res.status(400).json({ error: "email, password, and name are required" });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "password must be at least 8 characters" });
    }

    const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (existing) {
      return res.status(409).json({ error: "An account with that email already exists" });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = await prisma.user.create({
      data: { email: email.toLowerCase(), passwordHash, name },
    });

    // Manual collaborator approval: pending invites are NEVER auto-accepted
    // at signup. The invitee must open /invites/:token and click Accept.
    // (Kept as a no-op block so the intent is explicit in code history.)

    // Soft, non-blocking email verification — sending this must never fail
    // the registration response itself, same pattern as the invite
    // auto-accept logic above.
    try {
      const token = randomBytes(24).toString("base64url");
      await prisma.emailVerificationToken.create({
        data: {
          userId: user.id,
          token,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
      const verifyUrl = `${PUBLIC_WEB_URL}/verify-email/${token}`;
      await sendEmailVerificationEmail(user.email, verifyUrl);
    } catch (err) {
      console.error(`Failed to send verification email for new user ${user.id}:`, err);
    }

    // Auto-start the one-time free trial on self-registration (mirrors
    // Studio-Verse signup) — best-effort like everything else here; a
    // trial failure must never fail registration itself.
    try {
      await activateTrial(user.id);
    } catch (err) {
      console.error(`Failed to auto-activate trial for new user ${user.id}:`, err.message);
    }

    // Self-registration opts into remember-me (7-day session) — there is
    // no checkbox on the register form; only the login form asks.
    const rememberMe = parseRememberMe(req.body, true);
    res.status(201).json(issueSession(res, user, rememberMe));
  } catch (err) {
    next(err);
  }
});

router.post("/login", authLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }

    if (isEnvSuperAdminCredentials(String(email), String(password))) {
      const admin = envSuperAdminUser();
      return res.json(issueSession(res, admin, true));
    }

    const user = await prisma.user.findUnique({ where: { email: String(email).toLowerCase() } });
    if (!user) {
      // MERGE (Studio-Verse): still run a bcrypt compare against a dummy
      // hash so a nonexistent account takes the same time to reject as a
      // real wrong-password attempt — prevents email enumeration via
      // response timing.
      await bcrypt.compare(password, DUMMY_HASH);
      return res.status(401).json({ error: "Invalid email or password" });
    }

    if (!user.passwordHash) {
      await bcrypt.compare(password, DUMMY_HASH);
      return res.status(401).json({ error: "This account uses Google Sign-In — continue with Google instead." });
    }

    // MERGE (Studio-Verse): account lockout — checked before the password
    // compare so a locked account can't be brute-forced further while
    // locked, but after the null-checks above so those don't leak
    // lock-vs-nonexistent-account timing differences worth caring about.
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minutesLeft = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
      return res.status(403).json({ error: `Too many failed attempts. Try again in ${minutesLeft} minute${minutesLeft === 1 ? "" : "s"}.` });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      const attempts = user.failedLoginAttempts + 1;
      const lockingNow = attempts >= ACCOUNT_LOCK_MAX_FAILED_ATTEMPTS;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: lockingNow ? 0 : attempts,
          lockedUntil: lockingNow ? new Date(Date.now() + ACCOUNT_LOCK_DURATION_MINUTES * 60000) : null,
        },
      });
      return res.status(401).json({ error: "Invalid email or password" });
    }

    if (user.suspendedAt) {
      return res.status(403).json({ error: "This account has been suspended" });
    }

    if (user.failedLoginAttempts > 0 || user.lockedUntil) {
      await prisma.user.update({ where: { id: user.id }, data: { failedLoginAttempts: 0, lockedUntil: null } });
    }

    const rememberMe = parseRememberMe(req.body, false);
    res.json(issueSession(res, user, rememberMe));
  } catch (err) {
    next(err);
  }
});

/// Sliding renewal for default (non-remember) sessions: while the user is
/// active the frontend calls this before the 30-minute token dies and gets
/// a fresh one of the same class. Rotation blocklists the presented token
/// (hourly-pruned, see lib/tokenMaintenance.js). Renewal stops at the
/// absolute cap measured from the ORIGINAL login (iat): 24 h default,
/// 7 days remember-me — past that the client must log in again.
router.post("/refresh", requireAuth, async (req, res, next) => {
  try {
    const presented =
      (req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null) ||
      req.query?.token ||
      req.cookies?.pandaspot_token;
    const payload = jwt.verify(presented, process.env.JWT_SECRET);
    // Tokens minted before the remember-me feature carry no `rm` claim —
    // treat them as remember-me so existing sessions aren't abruptly cut.
    const rememberMe = payload.rm !== false;
    const ageSeconds = Date.now() / 1000 - (payload.iat || 0);
    if (ageSeconds > sessionAbsoluteCapSeconds(rememberMe)) {
      return res.status(401).json({ error: "Session expired — please log in again", code: "session_expired" });
    }
    const user = payload.env_super_admin && payload.sub === "env-super-admin"
      ? envSuperAdminUser()
      : { id: payload.sub, email: payload.email, role: req.user.role };
    if (!user) {
      return res.status(401).json({ error: "Invalid or expired session" });
    }
    await blocklistToken(payload);
    const token = signToken(user, rememberMe);
    setAuthCookie(res, token, rememberMe);
    const expiresIn = sessionTtlSeconds(rememberMe);
    res.json({
      token,
      remember_me: rememberMe,
      expires_in: expiresIn,
      expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/logout", async (req, res) => {
  // MERGE (Studio-Verse): real token invalidation, not just clearing the
  // cookie — a Bearer token in storage would otherwise keep working until
  // its own expiry after "logging out". Best-effort: an already-
  // invalid/missing token just means there's nothing to blocklist.
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : req.query?.token || req.cookies?.pandaspot_token;
  if (token) {
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      await blocklistToken(payload);
    } catch {
      // invalid/expired token — nothing to blocklist, still clear the cookie below
    }
  }
  clearAuthCookie(res);
  res.status(204).end();
});

router.get("/me", requireAuth, async (req, res, next) => {
  try {
    if (req.user.envSuperAdmin) {
      return res.json(publicUser(envSuperAdminUser()));
    }
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    res.json(publicUser(user));
  } catch (err) {
    next(err);
  }
});

// MERGE (Studio-Verse): authenticated password change — verifies the
// current password, enforces the same 8-char minimum as registration, and
// blocklists the presented token so every other session using it must log
// in again (Studio-Verse's changePassword, see STUDIO_VERSE_HANDOFF.md §5).
// Google-only accounts (no password set yet) may set one without a current
// password; everyone else must prove the old one.
router.put("/change-password", requireAuth, async (req, res, next) => {
  try {
    const { current_password: currentPassword, new_password: newPassword } = req.body || {};
    if (!newPassword || typeof newPassword !== "string") {
      return res.status(400).json({ error: "current_password and new_password are required" });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: "New password must be at least 8 characters" });
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    if (user.passwordHash) {
      if (!currentPassword || typeof currentPassword !== "string") {
        return res.status(400).json({ error: "current_password and new_password are required" });
      }
      if (currentPassword === newPassword) {
        return res.status(400).json({ error: "New password must be different from the current password" });
      }
      const isMatch = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!isMatch) {
        return res.status(401).json({ error: "Current password is incorrect" });
      }
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(newPassword, BCRYPT_ROUNDS) },
    });

    // Force re-login everywhere this token was in use.
    await blocklistToken({ jti: req.user.jti, exp: req.user.exp });
    clearAuthCookie(res);

    res.json({ ok: true, message: "Password changed successfully. Please log in again." });
  } catch (err) {
    next(err);
  }
});

router.post("/email-verification/request", requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    if (user.emailVerifiedAt) {
      return res.json({ ok: true, already_verified: true });
    }

    const token = randomBytes(24).toString("base64url");
    await prisma.emailVerificationToken.create({
      data: {
        userId: user.id,
        token,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    const verifyUrl = `${PUBLIC_WEB_URL}/verify-email/${token}`;
    await sendEmailVerificationEmail(user.email, verifyUrl);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/email-verification/:token/confirm", async (req, res, next) => {
  try {
    const record = await prisma.emailVerificationToken.findUnique({ where: { token: req.params.token } });
    if (!record || record.usedAt || record.expiresAt < new Date()) {
      return res.status(404).json({ error: "This verification link is invalid or has expired" });
    }

    await prisma.user.update({ where: { id: record.userId }, data: { emailVerifiedAt: new Date() } });
    await prisma.emailVerificationToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/password-reset/request", authLimiter, async (req, res, next) => {
  try {
    const { email } = req.body || {};
    if (!email || typeof email !== "string") {
      return res.status(400).json({ error: "email is required" });
    }

    // Always respond { ok: true } regardless of whether an account exists —
    // prevents user-enumeration via response-timing/shape. Only internally
    // create+send a reset token if a matching user is actually found.
    try {
      const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
      if (user) {
        const token = randomBytes(24).toString("base64url");
        await prisma.passwordResetToken.create({
          data: {
            userId: user.id,
            token,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          },
        });
        const resetUrl = `${PUBLIC_WEB_URL}/reset-password/${token}`;
        await sendPasswordResetEmail(user.email, resetUrl);
      }
    } catch (err) {
      console.error("Failed while processing password reset request:", err);
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/password-reset/:token/confirm", async (req, res, next) => {
  try {
    const { password } = req.body || {};
    if (!password || typeof password !== "string" || password.length < 8) {
      return res.status(400).json({ error: "password must be at least 8 characters" });
    }

    const record = await prisma.passwordResetToken.findUnique({ where: { token: req.params.token } });
    if (!record || record.usedAt || record.expiresAt < new Date()) {
      return res.status(404).json({ error: "This password reset link is invalid or has expired" });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await prisma.user.update({ where: { id: record.userId }, data: { passwordHash } });
    await prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/google", async (req, res, next) => {
  try {
    if (!googleClient) {
      return res.status(503).json({ error: "Google Sign-In isn't configured yet" });
    }
    const { id_token: idToken } = req.body || {};
    if (!idToken || typeof idToken !== "string") {
      return res.status(400).json({ error: "id_token is required" });
    }

    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({ idToken, audience: process.env.GOOGLE_CLIENT_ID });
      payload = ticket.getPayload();
    } catch {
      return res.status(401).json({ error: "Invalid Google credential" });
    }

    const googleId = payload.sub;
    const email = (payload.email || "").toLowerCase();
    if (!email) {
      return res.status(400).json({ error: "Google account has no email" });
    }

    // Env super-admin via Google: same elevation as password login — if the
    // Google-verified email matches SUPER_ADMIN_EMAIL (or ADMIN_EMAIL
    // fallback), issue the env SUPER_ADMIN session instead of a studio User
    // session. No User row needed, suspension N/A (env account).
    if (isEnvSuperAdminEmail(email)) {
      const admin = envSuperAdminUser();
      if (admin) {
        return res.json(issueSession(res, admin, true));
      }
    }

    let user = await prisma.user.findUnique({ where: { googleId } });
    if (!user) {
      user = await prisma.user.findUnique({ where: { email } });
      if (user) {
        // Existing password-based account signing in with Google for the first time — link it.
        user = await prisma.user.update({ where: { id: user.id }, data: { googleId } });
      } else {
        user = await prisma.user.create({
          data: {
            email,
            name: payload.name || email.split("@")[0],
            passwordHash: null,
            googleId,
            emailVerifiedAt: new Date(), // Google already verified this address
          },
        });
      }
    }

    if (user.suspendedAt) {
      return res.status(403).json({ error: "This account has been suspended" });
    }

    // Google one-tap has no remember-me checkbox — default to the 7-day
    // session (explicit opt-out isn't offered in this flow).
    const rememberMe = parseRememberMe(req.body, true);
    res.json(issueSession(res, user, rememberMe));
  } catch (err) {
    next(err);
  }
});

// --- Drive backup (advanced/beta) — see lib/driveBackupAuth.js ---
//
// One-time ADMIN setup only, not something every photographer connects —
// there is exactly one platform-wide Drive account
// (GOOGLE_DRIVE_BACKUP_REFRESH_TOKEN), used across every event with the
// per-event toggle on. This flow just gets that one refresh token; it's
// never persisted to the database (a single global secret belongs in the
// server's own .env, same as every other credential here) — the callback
// below renders it once for an admin to copy into .env and restart.

router.get("/google/drive-backup/connect", requireAuth, async (req, res, next) => {
  try {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      return res.status(503).json({ error: "Drive backup isn't configured yet (missing GOOGLE_CLIENT_ID/SECRET)" });
    }
    if (req.user.role !== "SUPER_ADMIN" || !isAdminEmail(req.user.email)) {
      return res.status(403).json({ error: "Only a platform admin can (re)connect Drive backup" });
    }
    res.redirect(getConsentUrl());
  } catch (err) {
    next(err);
  }
});

router.get("/google/drive-backup/callback", async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.status(400).send(`Drive backup connection failed: ${escapeHtml(String(error))}`);
  }

  try {
    const refreshToken = await exchangeCodeForRefreshToken(code);
    res.send(
      `<pre style="font-family: monospace; white-space: pre-wrap; padding: 24px;">` +
        `Drive backup connected.\n\n` +
        `Add this to the server's .env, then restart it:\n\n` +
        `GOOGLE_DRIVE_BACKUP_REFRESH_TOKEN="${escapeHtml(refreshToken)}"\n\n` +
        `This token is shown once and not stored anywhere by PandaSpot itself — copy it now.` +
        `</pre>`
    );
  } catch (err) {
    res.status(500).send(`Drive backup connection failed: ${escapeHtml(err.message)}`);
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export default router;
