import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import { detectFaces } from "./faceEngine.js";
import { downloadFile } from "./googleDrive.js";
import { existsSync } from "./storage.js";

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
export async function insertFace({ photoId, eventId, bbox, embedding, detScore }) {
  const id = randomUUID();
  const vectorLiteral = toVectorLiteral(embedding);
  const bboxJson = JSON.stringify(bbox);

  await prisma.$executeRaw`
    INSERT INTO "Face" (id, "photoId", "eventId", bbox, embedding, "detScore", "createdAt")
    VALUES (${id}, ${photoId}, ${eventId}, ${bboxJson}::jsonb, ${vectorLiteral}::vector, ${detScore}, now())
  `;

  return id;
}

export async function detectFacesForPhoto(buffer, filename) {
  const detection = await detectFaces(buffer, filename);
  return detection.faces || [];
}

export async function replacePhotoFaces({ photoId, eventId, faces }) {
  await prisma.face.deleteMany({ where: { photoId } });
  for (const face of faces) {
    await insertFace({
      photoId,
      eventId,
      bbox: face.bbox,
      embedding: face.embedding,
      detScore: face.det_score,
    });
  }
  await prisma.photo.update({ where: { id: photoId }, data: { faceCount: faces.length, faceIndexedAt: new Date() } });
  return faces.length;
}

export async function loadPhotoOriginalBuffer(photo) {
  if (photo.storagePath && existsSync(photo.storagePath)) {
    return fsp.readFile(photo.storagePath);
  }
  if (photo.driveFileId) {
    return downloadFile(photo.driveFileId);
  }
  throw new Error("This photo's original is no longer accessible for AI indexing.");
}

export async function indexExistingPhotoFaces(photo) {
  const buffer = await loadPhotoOriginalBuffer(photo);
  const faces = await detectFacesForPhoto(buffer, photo.filename);
  return replacePhotoFaces({ photoId: photo.id, eventId: photo.eventId, faces });
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
    GROUP BY f."photoId"
    HAVING MAX(1 - (f.embedding <=> ${vectorLiteral}::vector)) >= ${threshold}
    ORDER BY similarity DESC
  `;

  return rows;
}

export { Prisma };
