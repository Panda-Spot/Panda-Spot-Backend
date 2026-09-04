import { prisma } from "./prisma.js";
import { getEffectiveThreshold } from "./threshold.js";

/**
 * Auto face-grouping (Phase 22): clusters an event's searchable faces into
 * per-person groups so guest search can check unique faces instead of every
 * raw embedding, and the studio gets a "Faces" browse view.
 *
 * Method: greedy single-pass clustering over ArcFace embeddings (already
 * L2-normalized, so cosine similarity is a dot product). Faces arrive
 * ordered by detection score (best first); each face joins the most
 * similar group whose centroid scores >= the event's effective search
 * threshold, else starts a new group. Centroids update incrementally.
 * Using the *search* threshold as the join cutoff is deliberate: faces
 * we'd return for the same selfie end up in the same group.
 *
 * No schema change and no persistence: results are cached in memory per
 * event and invalidated whenever the event's face count changes (new
 * uploads/indexing naturally bust the cache). Bounded to the 10 most
 * recently used events so one giant wedding can't grow memory forever.
 */
const groupCache = new Map(); // eventId -> { faceCount, threshold, result }
const MAX_CACHED_EVENTS = 10;

function parseEmbedding(text) {
  if (Array.isArray(text)) return Float32Array.from(text, Number);
  const clean = String(text || "").trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!clean) return null;
  const parts = clean.split(",");
  const vec = new Float32Array(parts.length);
  for (let i = 0; i < parts.length; i += 1) {
    const v = Number(parts[i]);
    if (!Number.isFinite(v)) return null;
    vec[i] = v;
  }
  return vec.length > 0 ? vec : null;
}

function dotSimilarity(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function normalizeBbox(bbox) {
  if (!Array.isArray(bbox) || bbox.length < 4) return null;
  const nums = bbox.slice(0, 4).map(Number);
  if (nums.some((v) => !Number.isFinite(v))) return null;
  return nums;
}

function remember(eventId, entry) {
  groupCache.delete(eventId);
  groupCache.set(eventId, entry);
  while (groupCache.size > MAX_CACHED_EVENTS) {
    const oldest = groupCache.keys().next();
    if (oldest.done) break;
    groupCache.delete(oldest.value);
  }
}

export function resolveClusteringThreshold(event) {
  return getEffectiveThreshold(event);
}

export async function getFaceGroups(eventId, threshold) {
  const faceCount = await prisma.face.count({ where: { eventId } });
  if (faceCount === 0) {
    const empty = { groups: [], face_count: 0, group_count: 0, threshold };
    remember(eventId, { faceCount, threshold, result: empty });
    return empty;
  }

  const cached = groupCache.get(eventId);
  if (cached && cached.faceCount === faceCount && cached.threshold === threshold) {
    return cached.result;
  }

  const rows = await prisma.$queryRaw`
    SELECT f.id AS "faceId", f."photoId" AS "photoId",
           f.embedding::text AS embedding,
           f.bbox AS bbox, f."detScore" AS "detScore"
    FROM "Face" f
    INNER JOIN "Photo" p ON p.id = f."photoId"
    WHERE f."eventId" = ${eventId}
      AND p."approvalStatus" = 'approved'
      AND p."faceSearchVisible" = true
      AND p."archivedAt" IS NULL
    ORDER BY f."detScore" DESC
  `;

  // Each group: { members: [{faceId, photoId, bbox, detScore}], centroid: Float32Array, membersCount }
  const groups = [];
  for (const row of rows) {
    const vec = parseEmbedding(row.embedding);
    const bbox = normalizeBbox(row.bbox);
    if (!vec || !bbox) continue;
    let best = null;
    let bestSim = -Infinity;
    for (const g of groups) {
      const sim = dotSimilarity(vec, g.centroid);
      if (sim > bestSim) {
        bestSim = sim;
        best = g;
      }
    }
    if (best && bestSim >= threshold) {
      best.members.push({ faceId: row.faceId, photoId: row.photoId, bbox, detScore: Number(row.detScore) || 0 });
      // Incremental centroid mean.
      const n = best.members.length;
      const c = best.centroid;
      for (let i = 0; i < c.length; i += 1) {
        c[i] += (vec[i] - c[i]) / n;
      }
    } else {
      groups.push({
        members: [{ faceId: row.faceId, photoId: row.photoId, bbox, detScore: Number(row.detScore) || 0 }],
        centroid: Float32Array.from(vec),
      });
    }
  }

  groups.sort((a, b) => b.members.length - a.members.length);
  const result = {
    groups: groups.map((g, index) => {
      const photoIds = [...new Set(g.members.map((m) => m.photoId))];
      const rep = g.members[0];
      return {
        group_index: index,
        face_count: g.members.length,
        photo_ids: photoIds,
        representative: { photo_id: rep.photoId, bbox: rep.bbox, det_score: rep.detScore },
      };
    }),
    face_count: rows.length,
    group_count: groups.length,
    threshold,
  };
  remember(eventId, { faceCount, threshold, result });
  return result;
}

/** For tests/diagnostics: how many events currently hold cached groups. */
export function faceGroupCacheSize() {
  return groupCache.size;
}

// Seeds above the search threshold PLUS this margin may pull in their
// group siblings — a borderline match must never amplify into more
// borderline matches. Tunable; documented on the endpoint using it.
export const GROUP_SEED_MARGIN = 0.05;
export const MAX_GROUP_SIBLINGS = 50;

/**
 * Group-assisted recall for guest search (Phase 22): given direct vector
 * matches, also return same-group sibling photos the raw embedding query
 * missed (angle, lighting, partial occlusion). Only confident seeds
 * (similarity >= threshold + margin) expand, siblings inherit the seed's
 * similarity and are flagged matchViaGroup, and the caller's normal photo
 * filters (approved/visible/unarchived) still apply downstream — so this
 * can only ADD photos the studio already made searchable, never leak
 * hidden ones. Capped per call.
 */
export async function expandMatchesWithGroups(eventId, threshold, seeds) {
  const confident = (seeds || []).filter(
    (s) => s && s.photoId && Number(s.similarity) >= threshold + GROUP_SEED_MARGIN
  );
  if (confident.length === 0) return [];

  const { groups } = await getFaceGroups(eventId, threshold);
  if (groups.length === 0) return [];

  const photoToGroups = new Map(); // photoId -> [group, ...]
  for (const g of groups) {
    for (const pid of g.photo_ids) {
      if (!photoToGroups.has(pid)) photoToGroups.set(pid, []);
      photoToGroups.get(pid).push(g);
    }
  }

  const matched = new Set(confident.map((s) => s.photoId));
  const out = [];
  for (const seed of confident) {
    const seedSim = Number(seed.similarity);
    for (const g of photoToGroups.get(seed.photoId) || []) {
      for (const pid of g.photo_ids) {
        if (matched.has(pid)) continue;
        matched.add(pid);
        out.push({ photoId: pid, similarity: seedSim, matchViaGroup: true });
        if (out.length >= MAX_GROUP_SIBLINGS) return out;
      }
    }
  }
  return out;
}
