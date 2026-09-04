import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "./prisma.js";

/// Gallery access upgrade (Phase 3): expiry presets, private-key locked
/// galleries, and client-login-only events.
///
/// Trust-model note: the key gates the guest JSON API (browse/search/
/// download/react). Direct photo file URLs keep the pre-existing UUID
/// trust model (unguessable, same as album spreads) — gating <img> tags
/// would need per-image signed URLs, a bigger change deliberately left
/// out. invite_only enforces exactly like client_login (public link
/// closed); the distinction is product vocabulary for studios.

export const ACCESS_MODES = ["public", "private_key", "client_login", "invite_only"];

const JWT_SECRET = process.env.JWT_SECRET;

function galleryTtlSeconds() {
  const value = Number(process.env.GALLERY_TOKEN_TTL_SECONDS || 12 * 60 * 60);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 12 * 60 * 60;
}

export function signGalleryToken({ eventId, slug }) {
  return jwt.sign({ eventId, slug, purpose: "gallery_unlock" }, JWT_SECRET, {
    expiresIn: galleryTtlSeconds(),
    audience: "pandaspot-gallery",
  });
}

export function verifyGalleryToken(token, event) {
  const payload = jwt.verify(token, JWT_SECRET, { audience: "pandaspot-gallery" });
  if (!payload || payload.purpose !== "gallery_unlock") throw new Error("bad token");
  if (payload.eventId !== event.id || payload.slug !== event.guestSlug) throw new Error("bad token");
  return payload;
}

export async function setAccessKey(eventId, key) {
  if (!key || typeof key !== "string" || !key.trim()) {
    throw Object.assign(new Error("access_key must be a non-empty string"), { status: 400 });
  }
  if (key.trim().length < 4 || key.length > 200) {
    throw Object.assign(new Error("access_key must be 4-200 characters"), { status: 400 });
  }
  const accessKeyHash = await bcrypt.hash(key.trim(), 10);
  return prisma.event.update({ where: { id: eventId }, data: { accessKeyHash } });
}

/// Checks one unlock attempt. Slow bcrypt compare is itself brute-force
/// throttling; the route additionally sits behind guestSearchLimiter.
export async function checkAccessKey(event, key) {
  if (!event.accessKeyHash) return false;
  if (!key || typeof key !== "string") return false;
  try {
    return await bcrypt.compare(key, event.accessKeyHash);
  } catch {
    return false;
  }
}

/// Gate for guest JSON routes. Returns null when access is granted;
/// otherwise the { status, body } denial to send. Unknown slugs 404
/// upstream — this never confirms or denies an event's existence beyond
/// what the route already does.
export function checkGalleryAccess(event, req) {
  const mode = event.accessMode || "public";
  if (mode === "public") return null;
  if (mode === "client_login" || mode === "invite_only") {
    return {
      status: 403,
      body: {
        error: "This gallery is private — please log in with your client account to continue.",
        code: "login_required",
      },
    };
  }
  // private_key: a gallery unlock token from POST /e/:slug/unlock.
  const token = req.headers?.["x-gallery-key"] || req.query?.gallery_key || null;
  if (token) {
    try {
      verifyGalleryToken(token, event);
      return null;
    } catch {
      // Fall through to the locked denial (never say why a token failed).
    }
  }
  return {
    status: 401,
    body: {
      error: "This gallery is locked — enter the access key from your photographer to continue.",
      code: "locked",
    },
  };
}

/// Public metadata flags for GET /e/:slug so the guest page can render
/// the branded prompt/login/expired screens with the studio's own logo.
export function galleryAccessFlags(event) {
  const mode = event.accessMode || "public";
  return {
    access_mode: mode,
    locked: mode !== "public",
    login_required: mode === "client_login" || mode === "invite_only",
  };
}
