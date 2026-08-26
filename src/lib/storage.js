import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const STORAGE_DIR = process.env.STORAGE_DIR || "./storage";

export const ALLOWED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

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
