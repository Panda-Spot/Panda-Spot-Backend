import sharp from "sharp";
import { ensureEventThumbDir, eventThumbPath } from "./storage.js";

const THUMB_MAX_DIMENSION = 480;
const THUMB_JPEG_QUALITY = 78;

/**
 * Orientation-corrected original dimensions of an image buffer ({width,
 * height}, nulls when unreadable). Shared by generateThumbnail (below) and
 * face-closeup extraction (lib/faces.js) so both agree on the coordinate
 * space the detector's bboxes live in.
 */
export async function originalDimensions(buffer) {
  try {
    const meta = await sharp(buffer).metadata();
    if (meta?.width && meta?.height) {
      const swap = [5, 6, 7, 8].includes(meta.orientation);
      return { width: swap ? meta.height : meta.width, height: swap ? meta.width : meta.height };
    }
  } catch {
    // fall through to nulls
  }
  return { width: null, height: null };
}

/**
 * Generates a resized JPEG preview (~480px on the long edge) from an
 * already-in-memory image buffer and saves it to disk, for fast gallery
 * grids — full-size originals are only fetched on download/share/zip.
 * Returns { path, width, height } — width/height are the ORIGINAL image
 * dimensions (orientation-corrected), which face-crop math needs because
 * bboxes are stored in original-image pixels while everything displayed
 * is the thumbnail. Null path on failure (a bad/unusual image the upload's
 * own checks let through) — callers should fall back to the original file,
 * never fail the whole upload over a missing thumbnail; dims are null then.
 */
export async function generateThumbnail(buffer, eventId, photoId) {
  const { width, height } = await originalDimensions(buffer);
  try {
    await ensureEventThumbDir(eventId);
    const outPath = eventThumbPath(eventId, photoId);
    await sharp(buffer)
      .rotate() // respect EXIF orientation before resizing
      .resize(THUMB_MAX_DIMENSION, THUMB_MAX_DIMENSION, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: THUMB_JPEG_QUALITY })
      .toFile(outPath);
    return { path: outPath, width, height };
  } catch (err) {
    console.error(`Thumbnail generation failed for photo ${photoId}:`, err);
    return { path: null, width, height };
  }
}
