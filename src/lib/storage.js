import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const STORAGE_DIR = process.env.STORAGE_DIR || "./storage";

export const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

/** Uploadable video containers (Phase 20 — no face indexing, gallery/
 * delivery only; see fileValidation.js's sniffing + the faceSearchVisible
 * convention in routes/events.js's upload job). */
export const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"]);

/** Everything a Photo row may point at (images + video). Branding, covers,
 * camera captures, and guest selfies stay images-only via
 * IMAGE_EXTENSIONS at their own call sites. */
export const ALLOWED_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]);

// fileValidation.js imports the sets above (one direction only — this
// module never imports fileValidation, so there is no cycle).

/** Resolves STORAGE_DIR to an absolute path (relative to process cwd if not absolute). */
export function storageRoot() {
  return path.resolve(STORAGE_DIR);
}

/** Absolute directory for a given event's photos. */
export function eventDir(eventId) {
  return path.join(storageRoot(), "events", eventId);
}

/** Absolute path for a specific photo file within an event's directory. */
export function eventPhotoPath(eventId, filename) {
  return path.join(eventDir(eventId), filename);
}

/** Ensures an event's photo directory exists on disk. */
export async function ensureEventDir(eventId) {
  const dir = eventDir(eventId);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

/** Writes a buffer to disk under the given event's directory, returns the absolute path. */
export async function saveEventPhoto(eventId, filename, buffer) {
  await ensureEventDir(eventId);
  const fullPath = eventPhotoPath(eventId, filename);
  await fsp.writeFile(fullPath, buffer);
  return fullPath;
}

/** Absolute directory for a given event's Shoots (camera-to-cloud) captures
 * that ended up stored locally — kept separate from directly-uploaded
 * photos so the two sources are easy to tell apart on disk. Used only when
 * Drive backup is off or its upload failed (see lib/captureIngest.js). */
export function eventShootsDir(eventId) {
  return path.join(eventDir(eventId), "shoots");
}

/** Writes a Shoots-captured buffer to disk under the event's dedicated shoots/
 * subfolder, returns the absolute path. */
export async function saveEventShootsPhoto(eventId, filename, buffer) {
  const dir = eventShootsDir(eventId);
  await fsp.mkdir(dir, { recursive: true });
  const fullPath = path.join(dir, filename);
  await fsp.writeFile(fullPath, buffer);
  return fullPath;
}

/** True if a path exists on disk (sync, used for quick 404 checks before streaming). */
export function existsSync(filePath) {
  return fs.existsSync(filePath);
}

/**
 * Saves (or replaces) an event's cover photo. Lives directly in the
 * event's own directory as `cover.<ext>` so cascade-delete removes it
 * with everything else — no lifecycle hook needed. Client-side 16:9
 * cropping happens before upload; the server stores the bytes as-is after
 * the usual extension + content-sniff checks at the route layer.
 */
export async function saveEventCover(eventId, filename, buffer) {
  const dir = await ensureEventDir(eventId);

  const ext = path.extname(filename).toLowerCase();
  const newPath = path.join(dir, `cover${ext}`);

  // Remove any previous cover under a different extension.
  let existing = [];
  try {
    existing = await fsp.readdir(dir);
  } catch {
    existing = [];
  }
  for (const entry of existing) {
    if (entry.startsWith("cover.") && path.join(dir, entry) !== newPath) {
      await fsp.unlink(path.join(dir, entry)).catch(() => {});
    }
  }

  await fsp.writeFile(newPath, buffer);
  return newPath;
}

/** Absolute directory for in-progress chunked-upload part files. */
export function uploadPartsDir() {
  return path.join(storageRoot(), "uploads", "parts");
}
/** Absolute path of one upload stage's accumulating part file. */
export function uploadPartPath(stageId) {
  return path.join(uploadPartsDir(), `${stageId}.part`);
}

/**
 * Appends one chunk to a stage's part file. The offset must equal the
 * bytes already received — this is what makes interrupted uploads
 * resumable (the client asks the stage how much arrived and continues
 * from there) and rejects overlapping/duplicate writes.
 */
export async function appendUploadPart(stageId, offset, buffer) {
  await fsp.mkdir(uploadPartsDir(), { recursive: true });
  const fullPath = uploadPartPath(stageId);
  let current = 0;
  try {
    current = (await fsp.stat(fullPath)).size;
  } catch {
    current = 0;
  }
  if (current !== offset) {
    throw Object.assign(
      new Error(`Chunk offset ${offset} does not match received bytes ${current} — resume from ${current}`),
      { status: 409 }
    );
  }
  const handle = await fsp.open(fullPath, "a");
  try {
    await handle.write(buffer, 0, buffer.length, current);
  } finally {
    await handle.close();
  }
  return current + buffer.length;
}

/** Bytes received so far for a stage (0 when no part file exists yet). */
export async function uploadPartSize(stageId) {
  try {
    return (await fsp.stat(uploadPartPath(stageId))).size;
  } catch {
    return 0;
  }
}

/** Best-effort removal of a stage's part file (abort/cleanup path). */
export async function deleteUploadPart(stageId) {
  await fsp.unlink(uploadPartPath(stageId)).catch(() => {});
}

/** Absolute directory for a given event's photo thumbnails (kept separate from originals). */
export function eventThumbDir(eventId) {
  return path.join(eventDir(eventId), "thumbs");
}

/** Absolute path for one photo's thumbnail — always saved as .jpg regardless of the original's format. */
export function eventThumbPath(eventId, photoId) {
  return path.join(eventThumbDir(eventId), `${photoId}.jpg`);
}

/** Ensures an event's thumbnail directory exists on disk. */
export async function ensureEventThumbDir(eventId) {
  const dir = eventThumbDir(eventId);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

/** Deletes a single file if it exists — best-effort, never throws (a missing
 * file on disk shouldn't block deleting the DB row that pointed to it). */
export async function deleteFileIfExists(filePath) {
  if (!filePath) return;
  await fsp.unlink(filePath).catch(() => {});
}

/** Recursively removes an entire event's photo/thumbnail directory (used when
 * deleting a whole event) — best-effort, never throws. */
export async function removeEventDir(eventId) {
  await fsp.rm(eventDir(eventId), { recursive: true, force: true }).catch(() => {});
}

/** Absolute directory for a given user's branding assets. */
export function brandingDir(userId) {
  return path.join(storageRoot(), "branding", userId);
}

/**
 * Saves (or overwrites) a photographer's studio logo. Always keeps exactly
 * one logo file per user — if a previous logo exists under a different
 * extension (e.g. they re-upload a .png after a .jpg), the old file is
 * deleted first so it doesn't linger as an orphan.
 */
export async function saveBrandingLogo(userId, filename, buffer) {
  const dir = brandingDir(userId);
  await fsp.mkdir(dir, { recursive: true });

  const ext = path.extname(filename).toLowerCase();
  const newPath = path.join(dir, `logo${ext}`);

  // Remove any previous logo file(s) under other extensions.
  let existing = [];
  try {
    existing = await fsp.readdir(dir);
  } catch {
    existing = [];
  }
  for (const entry of existing) {
    if (entry.startsWith("logo") && path.join(dir, entry) !== newPath) {
      await fsp.unlink(path.join(dir, entry)).catch(() => {});
    }
  }

  await fsp.writeFile(newPath, buffer);
  return newPath;
}

/**
 * Saves (or overwrites) a photographer's watermark overlay image — same
 * one-file-per-user pattern as the logo above, stored as `watermark.<ext>`
 * beside it so lifecycle behavior matches.
 */
export async function saveBrandingWatermark(userId, filename, buffer) {
  const dir = brandingDir(userId);
  await fsp.mkdir(dir, { recursive: true });

  const ext = path.extname(filename).toLowerCase();
  const newPath = path.join(dir, `watermark${ext}`);

  let existing = [];
  try {
    existing = await fsp.readdir(dir);
  } catch {
    existing = [];
  }
  for (const entry of existing) {
    if (entry.startsWith("watermark.") && path.join(dir, entry) !== newPath) {
      await fsp.unlink(path.join(dir, entry)).catch(() => {});
    }
  }

  await fsp.writeFile(newPath, buffer);
  return newPath;
}

/** Absolute directory for one album's files (inside its event's own
 * directory, so event cascade-delete removes album files with everything
 * else — no lifecycle hook needed). */
export function albumDir(eventId, albumId) {
  return path.join(eventDir(eventId), "albums", albumId);
}

/** Absolute directory for one album version's spread images. */
export function albumVersionDir(eventId, albumId, versionNumber) {
  return path.join(albumDir(eventId, albumId), `v${versionNumber}`);
}

/** Writes one album spread image, returns the absolute path. */
export async function saveAlbumPage(eventId, albumId, versionNumber, filename, buffer) {
  const dir = albumVersionDir(eventId, albumId, versionNumber);
  await fsp.mkdir(dir, { recursive: true });
  const fullPath = path.join(dir, filename);
  await fsp.writeFile(fullPath, buffer);
  return fullPath;
}
