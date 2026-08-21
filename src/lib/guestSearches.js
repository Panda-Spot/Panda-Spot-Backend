import { randomUUID } from "node:crypto";
import { prisma } from "./prisma.js";

/**
 * Converts a plain JS number array into the pgvector text literal format,
 * e.g. [0.1, 0.2, 0.3] -> "[0.1,0.2,0.3]". Mirrors lib/faces.js's helper —
 * duplicated here rather than shared since both files raw-insert into
 * different Unsupported(vector) columns and are simple enough not to be
 * worth a shared module.
 */
function toVectorLiteral(embedding) {
  return `[${embedding.join(",")}]`;
}

/**
 * Averages 1-3 embeddings element-wise, then renormalizes the result to
 * unit length. ArcFace embeddings are unit vectors and cosine similarity
 * via pgvector's `<=>` assumes that, so a naive un-renormalized average
 * would subtly bias downstream similarity scores.
 */
export function averageAndNormalize(embeddings) {
  if (!embeddings || embeddings.length === 0) {
    throw new Error("averageAndNormalize requires at least one embedding");
  }
  const dim = embeddings[0].length;
  const sum = new Array(dim).fill(0);
  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) {
      sum[i] += emb[i];
    }
  }
  const mean = sum.map((v) => v / embeddings.length);
  let normSq = 0;
  for (const v of mean) normSq += v * v;
  const norm = Math.sqrt(normSq);
  if (norm === 0) return mean;
  return mean.map((v) => v / norm);
}

/**
 * Inserts a GuestSearch row. The `embedding` column is `vector(512)`, an
 * Unsupported type in Prisma Client, so this goes through $executeRaw same
 * as insertFace() in lib/faces.js.
 */
export async function insertGuestSearch({ eventId, embedding, facesDetected, matchCount, guestClientId }) {
  const id = randomUUID();
  const vectorLiteral = toVectorLiteral(embedding);

  await prisma.$executeRaw`
    INSERT INTO "GuestSearch" (id, "eventId", embedding, "facesDetected", "matchCount", "guestClientId", "createdAt")
    VALUES (${id}, ${eventId}, ${vectorLiteral}::vector, ${facesDetected}, ${matchCount}, ${guestClientId ?? null}, now())
  `;

  return id;
}

/**
 * Recomputes the cosine similarity between one specific photo's face(s) and
 * a previously stored GuestSearch embedding — used by the feedback route to
 * store a real similarity value on the MatchFeedback row instead of a
 * placeholder. Returns the best (max) similarity across that photo's faces,
 * or null if the photo has no Face rows in this event.
 */
export async function similarityForPhoto({ searchId, photoId }) {
  const rows = await prisma.$queryRaw`
    SELECT MAX(1 - (f.embedding <=> gs.embedding)) AS similarity
    FROM "Face" f, "GuestSearch" gs
    WHERE gs.id = ${searchId} AND f."photoId" = ${photoId}
  `;
  if (!rows || rows.length === 0 || rows[0].similarity === null) return null;
  return Number(rows[0].similarity);
}
