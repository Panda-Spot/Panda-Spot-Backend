import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import sharp from "sharp";
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import { detectFaces } from "./faceEngine.js";
import { downloadFile, findDriveFileByName } from "./googleDrive.js";
import { deletePhotoFacesDir, ensurePhotoFacesDir, existsSync, faceThumbPath } from "./storage.js";
import { originalDimensions } from "./thumbnails.js";

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
export async function insertFace({ id, photoId, eventId, bbox, embedding, detScore, thumbnailPath }) {
  const faceId = id || randomUUID();
  const vectorLiteral = toVectorLiteral(embedding);
  const bboxJson = JSON.stringify(bbox);

  await prisma.$executeRaw`
    INSERT INTO "Face" (id, "photoId", "eventId", bbox, embedding, "detScore", "thumbnailPath", "createdAt")
    VALUES (${faceId}, ${photoId}, ${eventId}, ${bboxJson}::jsonb, ${vectorLiteral}::vector, ${detScore}, ${thumbnailPath}, now())
  `;

  return faceId;
}

export async function detectFacesForPhoto(buffer, filename) {
  const detection = await detectFaces(buffer, filename);
  return detection.faces || [];
}

/**
 * Extracts one padded-square face closeup (192px JPEG) from the full image
 * buffer and saves it under the face's id. Bbox is original-image pixels
 * in displayed (rotated) orientation. Best-effort per face — returns the
 * absolute path or null, never throws (one bad box must not fail indexing).
 */
export async function saveFaceThumbnail({ eventId, photoId, faceId, buffer, bbox, origWidth, origHeight }) {
  try {
    const [x1, y1, x2, y2] = (Array.isArray(bbox) ? bbox : []).map(Number);
    if (![x1, y1, x2, y2].every(Number.isFinite) || !origWidth || !origHeight) return null;
    const left = Math.max(0, Math.min(x1 / origWidth, 1));
    const top = Math.max(0, Math.min(y1 / origHeight, 1));
    const right = Math.max(0, Math.min(x2 / origWidth, 1));
    const bottom = Math.max(0, Math.min(y2 / origHeight, 1));
    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    const half = Math.max(right - left, bottom - top) * 0.85;
    let sqLeft = Math.max(0, cx - half);
    let sqTop = Math.max(0, cy - half);
    let sqSize = half * 2;
    if (sqLeft + sqSize > 1) sqLeft = Math.max(0, 1 - sqSize);
    if (sqTop + sqSize > 1) sqTop = Math.max(0, 1 - sqSize);
    sqSize = Math.min(sqSize, 1 - sqLeft, 1 - sqTop);
    if (!(sqSize > 0)) return null;
    const outPath = faceThumbPath(eventId, photoId, faceId);
    await fsp.mkdir(new URL(".", `file://${outPath}/`).pathname.replace(/\/$/, ""), { recursive: true }).catch(() => {});
    const { width: rw, height: rh } = await originalDimensions(buffer);
    if (!rw || !rh) return null;
    await sharp(buffer)
      .rotate()
      .extract({
        left: Math.round(sqLeft * rw),
        top: Math.round(sqTop * rh),
        width: Math.max(1, Math.round(sqSize * rw)),
        height: Math.max(1, Math.round(sqSize * rh)),
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

export async function replacePhotoFaces({ photoId, eventId, faces, buffer }) {
  // Original dims once (not per face) — the denominator for every bbox.
  // Callers pass the image bytes they already hold; without bytes there
  // are no thumbnails (rows still write normally).
  let origWidth = null;
  let origHeight = null;
  if (buffer) {
    try {
      ({ width: origWidth, height: origHeight } = await originalDimensions(buffer));
    } catch {
      // dims stay null — thumbnails below simply skip
    }
  }
  await prisma.face.deleteMany({ where: { photoId } });
  await deletePhotoFacesDir(eventId, photoId);
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
  const buffer = await loadPhotoOriginalBuffer(photo);
  const faces = await detectFacesForPhoto(buffer, photo.filename);
  return replacePhotoFaces({ photoId: photo.id, eventId: photo.eventId, faces, buffer });
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
