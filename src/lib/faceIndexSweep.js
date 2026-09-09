import { prisma } from "./prisma.js";
import { indexExistingPhotoFaces } from "./faces.js";
import { consumeAiPhotoCredits } from "./subscriptionAccess.js";

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"]);

/**
 * Self-healing sweep for photos that are members of AI Search
 * (faceSearchVisible) but were never indexed (faceIndexedAt null): killed
 * background jobs (deploys/restarts murder in-memory jobs), face-engine
 * downtime, timeouts, or credit hiccups all strand photos in "Indexing…"
 * forever with no retry path. This picks up a bounded batch every tick —
 * the same indexExistingPhotoFaces path as a manual Add (thumbnails +
 * Face rows + stamp), so anything it fixes is indistinguishable from a
 * fresh index. Videos are browsed, never indexed. Events with Face Search
 * itself off are skipped (membership hidden anyway — no credit spend).
 */
export async function sweepUnindexedFaces(limit = 20) {
  const candidates = await prisma.photo.findMany({
    where: {
      approvalStatus: "approved",
      faceSearchVisible: true,
      archivedAt: null,
      faceIndexedAt: null,
      event: { faceSearchEnabled: true },
    },
    select: { id: true, eventId: true, filename: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  let indexed = 0;
  const skipped = [];
  for (const c of candidates) {
    const ext = (c.filename || "").slice(((c.filename || "").lastIndexOf(".") >>> 0) + 1).toLowerCase();
    if (VIDEO_EXTENSIONS.has(`.${ext}`)) continue;
    try {
      const photo = await prisma.photo.findUnique({ where: { id: c.id } });
      if (!photo) continue;
      await indexExistingPhotoFaces(photo);
      const owner = await prisma.event.findUnique({ where: { id: photo.eventId }, select: { ownerId: true } });
      if (owner) await consumeAiPhotoCredits(owner.ownerId).catch(() => {});
      indexed += 1;
    } catch (err) {
      skipped.push(`${c.filename} (${err?.isFaceEngineError ? err.message : "could not index"})`);
    }
  }
  if (indexed > 0 || skipped.length > 0) {
    console.log(`Face index sweep: indexed ${indexed}, skipped ${skipped.length}.`);
  }
  return { indexed, skipped };
}

export function startFaceIndexSweepScheduler(intervalMs = 5 * 60 * 1000) {
  setInterval(() => {
    sweepUnindexedFaces().catch((err) => console.error("Face index sweep failed:", err));
  }, intervalMs);
}
