import sharp from "sharp";
import { ensureEventThumbDir, eventThumbPath } from "./storage.js";

const THUMB_MAX_DIMENSION = 480;
const THUMB_JPEG_QUALITY = 78;

/**
 * Generates a resized JPEG preview (~480px on the long edge) from an
 * already-in-memory image buffer and saves it to disk, for fast gallery
 * grids — full-size originals are only fetched on download/share/zip.
 * Returns the absolute path saved, or null if generation failed (a bad/
 * unusual image the original upload's own extension+content-sniff checks
 * let through) — callers should fall back to the original file, never
 * fail the whole upload over a missing thumbnail.
 */
export async function generateThumbnail(buffer, eventId, photoId) {
  try {
    await ensureEventThumbDir(eventId);
    const outPath = eventThumbPath(eventId, photoId);
    await sharp(buffer)
      .rotate() // respect EXIF orientation before resizing
      .resize(THUMB_MAX_DIMENSION, THUMB_MAX_DIMENSION, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: THUMB_JPEG_QUALITY })
      .toFile(outPath);
    return outPath;
  } catch (err) {
    console.error(`Thumbnail generation failed for photo ${photoId}:`, err);
    return null;
  }
}
