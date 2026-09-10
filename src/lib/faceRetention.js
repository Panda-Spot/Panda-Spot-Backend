import { prisma } from "./prisma.js";

// Face-embedding retention: photos removed from AI Search keep their Face
// rows (embeddings) for 15 days in case they rejoin — closeups are already
// gone (deleted at removal time), thumbnails lazy-regenerate on view.
// Once a day this hard-deletes rows whose 15-day hold expired, then resets
// the parent photos' counters so a later re-add runs a fresh index instead
// of believing stale face data exists. Grouping/search never see these
// rows (they join the photo's faceSearchVisible flag), so this only
// affects storage hygiene — never who matches whom.
const HOLD_DAYS = 15;

export async function runFaceRetentionSweep() {
  const cutoff = new Date(Date.now() - HOLD_DAYS * 24 * 60 * 60 * 1000);
  const stale = await prisma.face.findMany({
    where: { deletedAt: { lt: cutoff } },
    select: { photoId: true },
  });
  if (stale.length === 0) return { purgedFaces: 0, photosReset: 0 };
  const photoIds = [...new Set(stale.map((f) => f.photoId))];

  const { count: purgedFaces } = await prisma.face.deleteMany({
    where: { deletedAt: { lt: cutoff } },
  });

  // Photos left with no faces at all go back to "never indexed" so a
  // re-add re-detects instead of trusting the old counters.
  let photosReset = 0;
  for (const photoId of photoIds) {
    try {
      const remaining = await prisma.face.count({ where: { photoId } });
      if (remaining === 0) {
        await prisma.photo.update({
          where: { id: photoId },
          data: { faceCount: 0, faceIndexedAt: null },
        });
        photosReset += 1;
      }
    } catch (err) {
      console.error(`Face retention reset failed for photo ${photoId}:`, err?.message || err);
    }
  }
  if (purgedFaces > 0) {
    console.log(`Face retention sweep: purged ${purgedFaces} expired embedding(s) across ${photosReset} photo(s).`);
  }
  return { purgedFaces, photosReset };
}

export function startFaceRetentionScheduler() {
  const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily check per the retention policy
  setInterval(() => {
    runFaceRetentionSweep().catch((err) => console.error("Face retention sweep failed:", err));
  }, CHECK_INTERVAL_MS);
}
