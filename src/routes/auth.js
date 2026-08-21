import { Router } from "express";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { prisma } from "../lib/prisma.js";
import { signToken, setAuthCookie, clearAuthCookie, requireAuth } from "../middleware/auth.js";
import { sendEmailVerificationEmail, sendPasswordResetEmail } from "../lib/mailer.js";
import { authLimiter, registerLimiter } from "../lib/rateLimiters.js";
import { isAdminEmail } from "../middleware/admin.js";

const PUBLIC_WEB_URL = process.env.PUBLIC_WEB_URL || "http://localhost:5173";

const router = Router();
const BCRYPT_ROUNDS = 10;

// Unset GOOGLE_CLIENT_ID means Google Sign-In is simply not configured yet —
// the /auth/google route below cleanly 503s in that case rather than crash.
const googleClient = process.env.GOOGLE_CLIENT_ID ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID) : null;

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    email_verified: !!user.emailVerifiedAt,
    is_admin: isAdminEmail(user.email),
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

    // Auto-accept any pending collaborator invites sent to this email before
    // the user ever signed up — a bonus convenience, not load-bearing (the
    // frontend's explicit /invites/:token accept flow is a safety net for
    // this too), so failures here must never fail registration itself.
    try {
      const pendingInvites = await prisma.eventInvite.findMany({
        where: { acceptedAt: null, email: { equals: user.email, mode: "insensitive" } },
      });
      for (const invite of pendingInvites) {
        await prisma.eventCollaborator.upsert({
          where: { eventId_userId: { eventId: invite.eventId, userId: user.id } },
          create: { eventId: invite.eventId, userId: user.id },
          update: {},
        });
        await prisma.eventInvite.update({
          where: { id: invite.id },
          data: { acceptedAt: new Date() },
        });
      }
    } catch (err) {
      console.error(`Failed to auto-accept invites for new user ${user.id}:`, err);
    }

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

    const token = signToken(user);
    setAuthCookie(res, token);
    res.status(201).json(publicUser(user));
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

    const user = await prisma.user.findUnique({ where: { email: String(email).toLowerCase() } });
    if (!user) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    if (!user.passwordHash) {
      return res.status(401).json({ error: "This account uses Google Sign-In — continue with Google instead." });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = signToken(user);
    setAuthCookie(res, token);
    res.json(publicUser(user));
  } catch (err) {
    next(err);
  }
});

router.post("/logout", (req, res) => {
  clearAuthCookie(res);
  res.status(204).end();
});

router.get("/me", requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    res.json(publicUser(user));
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

    const token = signToken(user);
    setAuthCookie(res, token);
    res.json(publicUser(user));
  } catch (err) {
    next(err);
  }
});

export default router;
