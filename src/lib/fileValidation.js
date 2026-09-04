import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from "./storage.js";

/**
 * Sniffs the actual image type from file content (magic bytes), independent
 * of the filename's extension — a renamed .exe with a .jpg extension won't
 * pass this. Returns ".jpg", ".png", ".webp", or null if none match.
 */
export function sniffedImageExtension(buffer) {
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return ".jpg";
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return ".png";
  if (buffer.length > 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return ".webp";
  return null;
}

/**
 * Sniffs a video container from magic bytes (first 12 bytes suffice, so
 * Drive imports can verify with a ranged partial download instead of the
 * whole file). MP4/MOV/M4V share the ISO-BMFF `ftyp` box; MKV/WebM share
 * EBML; AVI is RIFF. Returns ".mp4", ".mov", ".webm", ".mkv", ".avi",
 * ".m4v", or null.
 */
export function sniffedVideoExtension(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer.toString("ascii", 4, 8) === "ftyp") {
    const brand = buffer.toString("ascii", 8, 12);
    if (brand.startsWith("qt")) return ".mov";
    if (buffer.length > 12 && buffer.toString("ascii", 0, 4) === "wide") return ".mov";
    return ".mp4";
  }
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return ".webm";
  }
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "AVI ") return ".avi";
  return null;
}

/** True if the extension is an uploadable video container. */
export function isVideoExtension(ext) {
  return VIDEO_EXTENSIONS.has(String(ext || "").toLowerCase());
}

/** True if the filename points at an uploadable video container. */
export function isVideoFilename(filename) {
  const lower = String(filename || "").toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return false;
  return isVideoExtension(lower.slice(dot));
}

/** True for still-image extensions (face-searchable media). */
export function isImageExtension(ext) {
  return IMAGE_EXTENSIONS.has(String(ext || "").toLowerCase());
}

/**
 * True if the file's actual content matches its claimed extension —
 * images via sniffedImageExtension, video via sniffedVideoExtension.
 * Containers sharing magic are accepted interchangeably within their
 * family (mp4/mov/m4v ftyp; webm/mkv EBML — extension alone decides
 * which player path serves them, the bytes are equivalent).
 */
export function contentMatchesExtension(buffer, declaredExt) {
  const ext = String(declaredExt || "").toLowerCase();
  if (isVideoExtension(ext)) {
    const sniffed = sniffedVideoExtension(buffer);
    if (!sniffed) return false;
    const ftypFamily = new Set([".mp4", ".mov", ".m4v"]);
    const ebmlFamily = new Set([".webm", ".mkv"]);
    if (sniffed === ".avi") return ext === ".avi";
    if (ftypFamily.has(sniffed)) return ftypFamily.has(ext);
    if (ebmlFamily.has(sniffed)) return ebmlFamily.has(ext);
    return sniffed === ext;
  }
  const sniffed = sniffedImageExtension(buffer);
  if (!sniffed) return false;
  if (sniffed === ".jpg") return ext === ".jpg" || ext === ".jpeg";
  return sniffed === ext;
}
