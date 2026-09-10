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
 * event and invalidated whenever the event's faces change. The key is the
 * face COUNT plus the newest row's createdAt: re-indexing a photo deletes
 * and recreates its Face rows (same count, fresh timestamps AND fresh ids),
 * so count alone would serve dead face ids — whose thumbnail URLs 404 and
 * render as black tiles. Bounded to the 10 most recently used events so
 * one giant wedding can't grow memory forever.
 */
const groupCache = new Map(); // eventId -> { faceKey, threshold, result }
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

// Searchable faces for one event, best detection first. Shared by
// grouping, merge suggestions, and (via getFaceGroups) guest recall.
async function fetchSearchableFaces(eventId) {
  return prisma.$queryRaw`
    SELECT f.id AS "faceId", f."photoId" AS "photoId",
           f.embedding::text AS embedding,
           f.bbox AS bbox, f."detScore" AS "detScore",
           f."thumbnailPath" AS "thumbnailPath",
           f."personName" AS "personName",
           p.filename AS filename, p.width AS width, p.height AS height
    FROM "Face" f
    INNER JOIN "Photo" p ON p.id = f."photoId"
    WHERE f."eventId" = ${eventId}
      AND p."approvalStatus" = 'approved'
      AND p."faceSearchVisible" = true
      AND p."archivedAt" IS NULL
    ORDER BY f."detScore" DESC
  `;
}

// Greedy single-pass clustering over ArcFace embeddings (already
// L2-normalized, so cosine similarity is a dot product). Faces arrive
// ordered by detection score (best first); each face joins the most
// similar group whose centroid scores >= the event's effective search
// threshold, else starts a new group. Centroids update incrementally.
// Using the *search* threshold as the join cutoff is deliberate: faces
// we'd return for the same selfie end up in the same group.
// Each group: { members: [...], centroid: Float32Array }
function clusterMembers(sourceRows, threshold) {
  const clustered = [];
  for (const row of sourceRows) {
    const vec = parseEmbedding(row.embedding);
    const bbox = normalizeBbox(row.bbox);
    if (!vec || !bbox) continue;
    let best = null;
    let bestSim = -Infinity;
    for (const g of clustered) {
      const sim = dotSimilarity(vec, g.centroid);
      if (sim > bestSim) {
        bestSim = sim;
        best = g;
      }
    }
    if (best && bestSim >= threshold) {
      best.members.push({ faceId: row.faceId, photoId: row.photoId, filename: row.filename, width: row.width, height: row.height, thumbnailPath: row.thumbnailPath, personName: row.personName || null, bbox, detScore: Number(row.detScore) || 0 });
      // Incremental centroid mean.
      const n = best.members.length;
      const c = best.centroid;
      for (let i = 0; i < c.length; i += 1) {
        c[i] += (vec[i] - c[i]) / n;
      }
    } else {
      clustered.push({
        members: [{ faceId: row.faceId, photoId: row.photoId, filename: row.filename, width: row.width, height: row.height, thumbnailPath: row.thumbnailPath, personName: row.personName || null, bbox, detScore: Number(row.detScore) || 0 }],
        centroid: Float32Array.from(vec),
      });
    }
  }
  return clustered;
}

export async function getFaceGroups(eventId, threshold) {
  // Count + newest-row timestamp + VISIBLE-face count: any add, delete,
  // re-index, archive, or membership flip changes the key, so cached
  // groups always reflect exactly the live AI-Search members — never
  // deleted/removed photos. (Clustering itself below is untouched.)
  const keyRows = await prisma.$queryRaw`SELECT COUNT(*)::int AS count, MAX(f."createdAt") AS newest,
    COUNT(*) FILTER (WHERE p."approvalStatus" = 'approved' AND p."faceSearchVisible" = true AND p."archivedAt" IS NULL)::int AS visible
    FROM "Face" f LEFT JOIN "Photo" p ON p.id = f."photoId" WHERE f."eventId" = ${eventId}`;
  const faceKey = `${keyRows?.[0]?.count ?? 0}|${keyRows?.[0]?.newest ? new Date(keyRows[0].newest).getTime() : 0}|${keyRows?.[0]?.visible ?? 0}`;
  const faceCount = Number(keyRows?.[0]?.count ?? 0);
  if (faceCount === 0) {
    const empty = { groups: [], face_count: 0, group_count: 0, threshold };
    remember(eventId, { faceKey, threshold, result: empty });
    return empty;
  }

  const cached = groupCache.get(eventId);
  if (cached && cached.faceKey === faceKey && cached.threshold === threshold) {
    return cached.result;
  }

  const rows = await fetchSearchableFaces(eventId);

  const groups = clusterMembers(rows, threshold);

  groups.sort((a, b) => b.members.length - a.members.length);
  // Display merge: groups sharing one studio-assigned person name
  // present as a single person (members concatenated, best face first).
  // Clustering above is untouched — this only affects studio display,
  // and gives "same person" merges somewhere to land.
  const displayGroups = mergeNamedGroups(groups);
  const result = {
    groups: displayGroups.map((g, index) => buildGroupSummary(g, index, eventId)),
    face_count: rows.length,
    group_count: displayGroups.length,
    threshold,
  };
  remember(eventId, { faceKey, threshold, result });
  return result;
}

// Concatenates groups carrying the same non-null studio person name.
// Best-detection face first within each merged group (rows arrive in
// detScore order, so a stable sort by detScore restores it).
function mergeNamedGroups(groups) {
  const named = new Map();
  const out = [];
  for (const g of groups) {
    const name = groupPersonName(g);
    if (!name) {
      out.push(g);
      continue;
    }
    if (!named.has(name)) {
      named.set(name, g);
      out.push(g);
    } else {
      const target = named.get(name);
      target.members.push(...g.members);
    }
  }
  for (const g of named.values()) {
    g.members.sort((a, b) => (b.detScore || 0) - (a.detScore || 0));
  }
  out.sort((a, b) => b.members.length - a.members.length);
  return out;
}

// Majority vote across named members; null keeps "Person N".
function groupPersonName(g) {
  const votes = {};
  for (const m of g.members) {
    if (m.personName) votes[m.personName] = (votes[m.personName] || 0) + 1;
  }
  let personName = null;
  let bestVotes = 0;
  for (const [name, n] of Object.entries(votes)) {
    if (n > bestVotes) { bestVotes = n; personName = name; }
  }
  return personName;
}

function buildGroupSummary(g, index, eventId) {
      const photoIds = [...new Set(g.members.map((m) => m.photoId))];
      const rep = g.members[0];
      const nameByPhotoId = {};
      const dimsByPhotoId = {};
      const repThumbByPhotoId = {};
      for (const m of g.members) {
        if (m.filename && !nameByPhotoId[m.photoId]) nameByPhotoId[m.photoId] = m.filename;
        if (m.width && m.height && !dimsByPhotoId[m.photoId]) dimsByPhotoId[m.photoId] = { width: Number(m.width), height: Number(m.height) };
      }
      // Representative thumbnail: prefer the rep face's own stored thumb;
      // fall back to any member face id of the same photo (the files route
      // lazy-generates on first serve for legacy rows).
      const repThumbFace = g.members.find((m) => m.photoId === rep.photoId && m.thumbnailPath)
        || g.members.find((m) => m.photoId === rep.photoId)
        || {};
      // Studio-only person label: majority vote across named members so
      // the name survives regrouping; null keeps the "Person N" fallback.
      const personName = groupPersonName(g);
      return {
        group_index: index,
        face_count: g.members.length,
        photo_ids: photoIds,
        person_name: personName,
        // Member face ids so the studio can rename the whole group in
        // one PATCH /faces/name call (data only — grouping untouched).
        face_ids: g.members.map((m) => m.faceId),
        // Per-photo filenames + dims so click-through opens the viewer with
        // real names and exact crop math (previously the client faked
        // `${photoId}.jpg` and measured wrong files).
        photos: photoIds.map((pid) => ({ photo_id: pid, filename: nameByPhotoId[pid] || `${pid}.jpg`, ...(dimsByPhotoId[pid] || {}) })),
        representative: {
          face_id: rep.faceId,
          photo_id: rep.photoId,
          filename: rep.filename || `${rep.photoId}.jpg`,
          ...(rep.width && rep.height ? { width: Number(rep.width), height: Number(rep.height) } : {}),
          // Direct closeup URL (lazy-generates server-side for legacy rows).
          thumbnail_url: repThumbFace.faceId ? `/files/events/${eventId}/faces/${repThumbFace.faceId}` : null,
          bbox: rep.bbox,
          det_score: rep.detScore,
        },
      };
}

/** For tests/diagnostics: how many events currently hold cached groups. */
export function faceGroupCacheSize() {
  return groupCache.size;
}

// Lookalike window below the join threshold: group pairs this similar
// didn't merge on their own but are close enough that a human should
// confirm same vs different person. Tunable.
export const MERGE_SUGGEST_MARGIN = 0.12;
export const MAX_MERGE_SUGGESTIONS = 20;

/**
 * Same/different-person review queue (Google Photos concept): pairs of
 * freshly-clustered groups whose centroids score just BELOW the join
 * threshold. Clustering is untouched — this only reads the same groups.
 * Pairs already sharing one studio name, or dismissed by the studio
 * (FaceMergeDismissal by representative face ids), are skipped.
 */
export async function getMergeSuggestions(eventId, threshold) {
  const rows = await fetchSearchableFaces(eventId);
  const groups = clusterMembers(rows, threshold);
  if (groups.length < 2) return { suggestions: [], threshold };

  let dismissed = [];
  try {
    dismissed = await prisma.faceMergeDismissal.findMany({
      where: { eventId },
      select: { faceA: true, faceB: true },
    });
  } catch {
    dismissed = [];
  }
  return buildMergeSuggestions(eventId, threshold, groups, dismissed);
}

function buildMergeSuggestions(eventId, threshold, groups, dismissed) {
  const liveFaceIds = new Set();
  for (const g of groups) for (const m of g.members) liveFaceIds.add(m.faceId);
  const dismissedKeys = new Set();
  for (const d of dismissed || []) {
    if (!d?.faceA || !d?.faceB) continue;
    if (!liveFaceIds.has(d.faceA) || !liveFaceIds.has(d.faceB)) continue;
    dismissedKeys.add([d.faceA, d.faceB].sort().join(":"));
  }
  const scored = [];
  for (let i = 0; i < groups.length; i += 1) {
    for (let j = i + 1; j < groups.length; j += 1) {
      const sim = dotSimilarity(groups[i].centroid, groups[j].centroid);
      if (!(sim >= threshold - MERGE_SUGGEST_MARGIN && sim < threshold)) continue;
      const nameA = groupPersonName(groups[i]);
      const nameB = groupPersonName(groups[j]);
      if (nameA && nameA === nameB) continue;
      const repA = groups[i].members[0]?.faceId;
      const repB = groups[j].members[0]?.faceId;
      if (!repA || !repB) continue;
      const key = [repA, repB].sort().join(":");
      if (dismissedKeys.has(key)) continue;
      scored.push({ i, j, sim, key });
    }
  }
  scored.sort((a, b) => b.sim - a.sim);
  return {
    threshold,
    suggestions: scored.slice(0, MAX_MERGE_SUGGESTIONS).map((s) => ({
      id: s.key,
      similarity: Math.round(s.sim * 1000) / 1000,
      group_a: buildGroupSummary(groups[s.i], 0, eventId),
      group_b: buildGroupSummary(groups[s.j], 1, eventId),
    })),
  };
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
