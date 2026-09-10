import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import sharp from "sharp";
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import { detectFaces } from "./faceEngine.js";
import { downloadFile, findDriveFileByName } from "./googleDrive.js";
import { deletePhotoFacesDir, ensurePhotoFacesDir, existsSync, faceThumbPath } from "./storage.js";
import { originalDimensions } from "./thumbnails.js";
import { getEffectiveThreshold } from "./threshold.js";

const FACE_THUMB_SIZE = 192;

/**
 * Converts a plain JS number array into the pgvector text literal format,
 * e.g. [0.1, 0.2, 0.3] -> "[0.1,0.2,0.3]"
 */
function toVectorLiteral(embedding) {
  return `[${embedding.join(",")}]`;
}

/**
 * Inserts a single Face row. The `embedding` column is `vector(512)`, an
 * Unsupported type in Prisma Client, so this has to go through $executeRaw
 * with the embedding cast to ::vector from a text literal, and bbox cast to
 * ::jsonb from a JSON string. All values are still passed as bound
 * parameters (template literal placeholders), so this is not string
 * concatenation / SQL injection prone.
 */
export async function insertFace({ id, photoId, eventId, bbox, embedding, detScore, thumbnailPath, bboxSpace, personName }) {
  const faceId = id || randomUUID();
  const vectorLiteral = toVectorLiteral(embedding);
  const bboxJson = JSON.stringify(bbox);

  await prisma.$executeRaw`
    INSERT INTO "Face" (id, "photoId", "eventId", bbox, embedding, "detScore", "thumbnailPath", "bboxSpace", "personName", "createdAt")
    VALUES (${faceId}, ${photoId}, ${eventId}, ${bboxJson}::jsonb, ${vectorLiteral}::vector, ${detScore}, ${thumbnailPath}, ${bboxSpace || null}, ${personName || null}, now())
  `;

  return faceId;
}

export async function detectFacesForPhoto(buffer, filename) {
  const detection = await detectFaces(buffer, filename);
  return detection.faces || [];
}

/**
 * Bakes EXIF orientation into the pixels (upright JPEG) BEFORE detection.
 * The detector (cv2) ignores EXIF, so without this, bboxes for portrait/
 * phone photos live in the sideways raw grid while everything displayed
 * (thumbnails, viewer, crops) is EXIF-rotated — wrong-face/empty closeups.
 * With this, detection, storage dims, extraction, and display all share
 * the displayed coordinate space. Already-upright images pass through
 * near-untouched (sharp .rotate() is a no-op for orientation 1).
 */
export async function normalizeOrientation(buffer) {
  try {
    return await sharp(buffer).rotate().jpeg({ quality: 92 }).toBuffer();
  } catch {
    return buffer;
  }
}

/**
 * Raw (EXIF-ignored) pixel dims of a buffer — the grid legacy face rows
 * (bboxSpace NULL, detected on raw bytes) live in. Used only by the
 * thumbnail backfill for those rows; everything else uses
 * originalDimensions() (orientation-corrected).
 */
export async function rawDimensions(buffer) {
  try {
    const meta = await sharp(buffer).metadata();
    if (meta?.width && meta?.height) return { width: meta.width, height: meta.height };
  } catch {
    // fall through to nulls
  }
  return { width: null, height: null };
}

/**
 * Extracts one padded-square face closeup (192px JPEG) from the full image
 * buffer and saves it under the face's id.
 *
 * Coordinate spaces (the whole point of `space`): the detector reads raw
 * bytes with cv2, which IGNORES EXIF orientation, so bboxes from rows
 * indexed before orientation normalization ('raw' space, or legacy rows
 * with bboxSpace NULL) live in the UNROTATED pixel grid and must be
 * extracted from the unrotated buffer with unrotated dims. Rows indexed
 * after normalization (bboxSpace 'displayed') live in the displayed
 * (EXIF-rotated) grid and extract from the .rotate()d canvas with
 * orientation-corrected dims. Mixing the two is what produced wrong-face
 * and empty crops on phone/portrait uploads.
 *
 * Best-effort per face — returns the absolute path or null, never throws
 * (one bad box must not fail indexing).
 */
export async function saveFaceThumbnail({ eventId, photoId, faceId, buffer, bbox, origWidth, origHeight, rawSpace = false }) {
  try {
    const [x1, y1, x2, y2] = (Array.isArray(bbox) ? bbox : []).map(Number);
    if (![x1, y1, x2, y2].every(Number.isFinite) || !origWidth || !origHeight) return null;
    const left = Math.max(0, Math.min(x1 / origWidth, 1));
    const top = Math.max(0, Math.min(y1 / origHeight, 1));
    const right = Math.max(0, Math.min(x2 / origWidth, 1));
    const bottom = Math.max(0, Math.min(y2 / origHeight, 1));
    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    const outPath = faceThumbPath(eventId, photoId, faceId);
    await ensurePhotoFacesDir(eventId, photoId);
    // Dims must come from the SAME canvas the extract runs on: rotated
    // canvas for displayed-space bboxes, raw metadata for raw-space ones.
    const meta = await sharp(buffer).metadata().catch(() => null);
    if (!meta?.width || !meta?.height) return null;
    const swap = !rawSpace && [5, 6, 7, 8].includes(meta.orientation);
    const rw = swap ? meta.height : meta.width;
    const rh = swap ? meta.width : meta.height;
    if (!rw || !rh) return null;
    // Pixel-square window (not a fraction square): on a non-square photo
    // a fraction square is a wide/tall pixel rect, and cover-resizing it
    // to 192px crops the face off-center. Center on the face in pixels.
    const fwPx = Math.max(0, (right - left) * rw);
    const fhPx = Math.max(0, (bottom - top) * rh);
    let side = Math.max(fwPx, fhPx) * 1.7;
    side = Math.min(side, rw, rh);
    if (!(side > 0)) return null;
    const x0 = Math.min(Math.max(cx * rw - side / 2, 0), Math.max(0, rw - side));
    const y0 = Math.min(Math.max(cy * rh - side / 2, 0), Math.max(0, rh - side));
    let pipeline = sharp(buffer);
    if (!rawSpace) pipeline = pipeline.rotate();
    await pipeline
      .extract({
        left: Math.round(x0),
        top: Math.round(y0),
        width: Math.max(1, Math.round(side)),
        height: Math.max(1, Math.round(side)),
      })
      .resize(FACE_THUMB_SIZE, FACE_THUMB_SIZE, { fit: "cover" })
      .jpeg({ quality: 80 })
      .toFile(outPath);
    return outPath;
  } catch (err) {
    console.error(`Face thumbnail failed for face ${faceId}:`, err?.message || err);
    return null;
  }
}

/**
 * Pre-names fresh faces from already-named lookalikes in the same event.
 * For each detected face, the nearest NAMED, live face at or above the
 * event's search threshold lends its personName (mutates the face objects
 * in place before insert). Faces with no confident named match stay null.
 * Best-effort and silent — never fails indexing.
 */
export async function inheritPersonNames({ eventId, faces }) {
  try {
    if (!Array.isArray(faces) || faces.length === 0) return;
    const namedCount = await prisma.face.count({
      where: { eventId, personName: { not: null }, deletedAt: null },
    });
    if (namedCount === 0) return;
    const event = await prisma.event.findUnique({ where: { id: eventId } });
    if (!event) return;
    const threshold = getEffectiveThreshold(event);
    for (const face of faces) {
      if (!face?.embedding || !Array.isArray(face.embedding)) continue;
      const vectorLiteral = toVectorLiteral(face.embedding);
      const hit = await prisma.$queryRaw`
        SELECT f."personName" AS name, (1 - (f.embedding <=> ${vectorLiteral}::vector)) AS sim
        FROM "Face" f
        INNER JOIN "Photo" p ON p.id = f."photoId"
        WHERE f."eventId" = ${eventId}
          AND f."personName" IS NOT NULL
          AND f."deletedAt" IS NULL
          AND p."approvalStatus" = 'approved'
          AND p."faceSearchVisible" = true
          AND p."archivedAt" IS NULL
        ORDER BY f.embedding <=> ${vectorLiteral}::vector ASC
        LIMIT 1
      `;
      const best = hit?.[0];
      if (best?.name && Number(best.sim) >= threshold) {
        face.personName = best.name;
      }
    }
  } catch (err) {
    console.error(`Person-name inherit failed for event ${eventId}:`, err?.message || err);
  }
}

export async function replacePhotoFaces({ photoId, eventId, faces, buffer }) {
  // Original dims once (not per face) — the denominator for every bbox.
  // Callers pass orientation-normalized bytes (see normalizeOrientation):
  // bboxes are detected in displayed space, so dims + extraction below
  // must be displayed-space too. Without bytes there are no thumbnails
  // (rows still write normally).
  let origWidth = null;
  let origHeight = null;
  if (buffer) {
    try {
      ({ width: origWidth, height: origHeight } = await originalDimensions(buffer));
    } catch {
      // dims stay null — thumbnails below simply skip
    }
  }
  await inheritPersonNames({ eventId, faces });
  await prisma.face.deleteMany({ where: { photoId } });
  await deletePhotoFacesDir(eventId, photoId);
  // Known-person inherit: new faces matching an already-NAMED face in
  // this event (at the event's own search threshold) arrive pre-named,
  // so fresh uploads of known people show names with no manual rename.
  // Runs BEFORE the old rows for this photo are replaced, so a re-index
  // keeps its own names too. Skipped entirely when the event has no
  // named faces (one cheap COUNT) — zero overhead for unnamed studios.
  await inheritPersonNames({ eventId, faces });
  for (const face of faces) {
    const faceId = randomUUID();
    const thumbnailPath = buffer && origWidth && origHeight
      ? await saveFaceThumbnail({ eventId, photoId, faceId, buffer, bbox: face.bbox, origWidth, origHeight })
      : null;
    await insertFace({
      id: faceId,
      photoId,
      eventId,
      bbox: face.bbox,
      embedding: face.embedding,
      detScore: face.det_score,
      thumbnailPath,
      // Bboxes are detected on the orientation-normalized buffer (see
      // indexExistingPhotoFaces / captureIngest), i.e. displayed space.
      bboxSpace: "displayed",
      // Pre-named by inheritPersonNames above when this face matches a
      // known person; otherwise null until the studio names it.
      personName: face.personName || null,
    });
  }
  await prisma.photo.update({ where: { id: photoId }, data: { faceCount: faces.length, faceIndexedAt: new Date() } });
  return faces.length;
}

export async function loadPhotoOriginalBuffer(photo) {
  if (photo.storagePath && existsSync(photo.storagePath)) {
    return fsp.readFile(photo.storagePath);
  }
  // Drive imports keep no local original — pull the bytes on demand. The
  // stored file id can go stale (replaced/restricted in Drive), so on any
  // failure fall back to an exact filename lookup in the event's connected
  // folder (same repair the file-serving route uses), then proceed purely
  // in memory — nothing is persisted, so nothing needs deleting after.
  if (photo.driveFileId) {
    try {
      return await downloadFile(photo.driveFileId);
    } catch {
      // fall through to the by-name lookup below
    }
  }
  try {
    const event = await prisma.event.findUnique({ where: { id: photo.eventId } });
    const folderId = event?.exportDriveFolderId || event?.driveFolderId;
    if (folderId && photo.filename) {
      const match = await findDriveFileByName(folderId, photo.filename);
      if (match) {
        const buffer = await downloadFile(match.id);
        if (match.id !== photo.driveFileId) {
          await prisma.photo.update({ where: { id: photo.id }, data: { driveFileId: match.id } }).catch(() => {});
        }
        return buffer;
      }
    }
  } catch {
    // folder unreachable — fall through to the throw below
  }
  throw new Error("This photo's original is no longer accessible for AI indexing.");
}

export async function indexExistingPhotoFaces(photo) {
  const raw = await loadPhotoOriginalBuffer(photo);
  // Detect on upright pixels so stored bboxes match displayed orientation
  // (the detector itself ignores EXIF). The normalized bytes also feed
  // thumbnail extraction below via replacePhotoFaces.
  const buffer = await normalizeOrientation(raw);
  const faces = await detectFacesForPhoto(buffer, photo.filename);
  return replacePhotoFaces({ photoId: photo.id, eventId: photo.eventId, faces, buffer });
}

/**
 * AI-Search removal path: the photo leaves Face Search but its file stays
 * in the manager. Face closeups are deleted from disk AT ONCE (rows keep
 * bbox + embedding, thumbnailPath nulled), and rows are stamped deletedAt
 * so the daily retention sweep can hard-purge embeddings past 15 days.
 * Idempotent — re-removing an already-removed photo is a no-op.
 */
export async function softDeletePhotoFaces({ eventId, photoId }) {
  await deletePhotoFacesDir(eventId, photoId).catch(() => {});
  await prisma.face.updateMany({
    where: { photoId, deletedAt: null },
    data: { deletedAt: new Date(), thumbnailPath: null },
  });
}

/**
 * Re-add path (within the 15-day hold): resurrects the photo's faces so
 * embeddings keep working without a costly re-detect. Closeups were
 * deleted on removal — they lazy-regenerate on first serve via the files
 * route backfill (bbox + space marker were retained).
 */
export async function restorePhotoFaces({ photoId }) {
  await prisma.face.updateMany({
    where: { photoId, deletedAt: { not: null } },
    data: { deletedAt: null },
  });
}

/**
 * Finds photos in an event whose faces best match a query embedding, using
 * pgvector cosine distance (`<=>`). Returns rows above `threshold`
 * similarity (1 - cosine distance), one row per matching photo, best
 * similarity per photo, sorted descending.
 */
export async function searchSimilarPhotos({ eventId, embedding, threshold }) {
  const vectorLiteral = toVectorLiteral(embedding);

  const rows = await prisma.$queryRaw`
    SELECT
      f."photoId" AS "photoId",
      MAX(1 - (f.embedding <=> ${vectorLiteral}::vector)) AS similarity
    FROM "Face" f
    INNER JOIN "Photo" p ON p.id = f."photoId"
    WHERE f."eventId" = ${eventId}
      AND p."faceSearchVisible" = true
      AND p."approvalStatus" = 'approved'
      AND p."archivedAt" IS NULL
    GROUP BY f."photoId"
    HAVING MAX(1 - (f.embedding <=> ${vectorLiteral}::vector)) >= ${threshold}
    ORDER BY similarity DESC
  `;

  return rows;
}

export { Prisma };
