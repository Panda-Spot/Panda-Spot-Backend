import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";

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
    WHERE f."eventId" = ${eventId}
    GROUP BY f."photoId"
    HAVING MAX(1 - (f.embedding <=> ${vectorLiteral}::vector)) >= ${threshold}
    ORDER BY similarity DESC
  `;

  return rows;
}

export { Prisma };
