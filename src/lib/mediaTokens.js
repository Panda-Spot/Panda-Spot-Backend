import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET;
const DEFAULT_TTL_SECONDS = 60;

function ttlSeconds() {
  const value = Number(process.env.MEDIA_TOKEN_TTL_SECONDS || DEFAULT_TTL_SECONDS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_TTL_SECONDS;
}

export function signMediaToken({ eventId, photoId, variant = "original", purpose = "photo_selection" }) {
  return jwt.sign({ eventId, photoId, variant, purpose }, JWT_SECRET, {
    expiresIn: ttlSeconds(),
    audience: "pandaspot-media",
  });
}

export function verifyMediaToken(token) {
  return jwt.verify(token, JWT_SECRET, { audience: "pandaspot-media" });
}
