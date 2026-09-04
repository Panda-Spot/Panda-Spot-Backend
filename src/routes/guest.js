import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { upload } from "../middleware/upload.js";
import { checkModeration, detectFaces, pickLargestFace } from "../lib/faceEngine.js";
import { searchSimilarPhotos } from "../lib/faces.js";
import { averageAndNormalize, insertGuestSearch, similarityForPhoto } from "../lib/guestSearches.js";
import { getEffectiveThreshold, adjustThresholdOnFeedback } from "../lib/threshold.js";
import { expandMatchesWithGroups } from "../lib/faceClustering.js";
import { zipFilenameForEvent, streamPhotosZip, buildPhotosZipToDisk, zipDownloadPath } from "../lib/zip.js";
import { sendZipReadyEmail } from "../lib/mailer.js";
import { ALLOWED_EXTENSIONS, IMAGE_EXTENSIONS } from "../lib/storage.js";
import { getStorageProvider } from "../lib/storageProvider.js";
import { generateThumbnail } from "../lib/thumbnails.js";
import { contentMatchesExtension, isVideoExtension } from "../lib/fileValidation.js";
import {
  guestSearchLimiter,
  guestDownloadLimiter,
  guestFeedbackLimiter,
  guestAlertLimiter,
  guestWhatsAppLinkLimiter,
  guestUploadLimiter,
  guestLikeLimiter,
  guestCommentLimiter,
} from "../lib/rateLimiters.js";
import { isExpired } from "../lib/expiry.js";
import { checkGalleryAccess, checkAccessKey, galleryAccessFlags, signGalleryToken } from "../lib/galleryAccess.js";
import {
  PRIVACY_CONSENT_VERSION,
  effectivePrivacyNotice,
  eraseGuestData,
  requireSelfieConsent,
  resolveGuestData,
  scrubSelfieBuffers,
} from "../lib/facePrivacy.js";
import { subscribeGuestAlert, unsubscribeGuestAlert, isValidEmail } from "../lib/guestAlerts.js";
import { sendWhatsAppMessage, isValidE164 } from "../lib/whatsapp.js";
import { eventStorageUsedBytes, effectiveStorageLimitBytes, effectivePhotoRetentionDays } from "../lib/planLimits.js";
import { publishLiveEvent, subscribeLiveEvents } from "../lib/liveEvents.js";
import { REACTION_TYPES, isValidReactionType } from "../lib/reactions.js";

const router = Router();

const PUBLIC_SERVER_URL = process.env.PUBLIC_SERVER_URL || "http://localhost:4000";

/** Returns { reactionsByPhoto: Map<photoId, {heart: 2, ...}>, myReactionByPhoto: Map<photoId, reactionType> }
 * for a set of photo ids — myReactionByPhoto is empty if guestClientId is falsy. */
async function getReactionInfo(photoIds, guestClientId) {
  if (photoIds.length === 0) return { reactionsByPhoto: new Map(), myReactionByPhoto: new Map() };

  const grouped = await prisma.photoLike.groupBy({
    by: ["photoId", "reactionType"],
    where: { photoId: { in: photoIds } },
    _count: true,
  });
  const reactionsByPhoto = new Map();
  for (const row of grouped) {
    const counts = reactionsByPhoto.get(row.photoId) || {};
    counts[row.reactionType] = row._count;
    reactionsByPhoto.set(row.photoId, counts);
  }

  let myReactionByPhoto = new Map();
  if (guestClientId) {
    const mine = await prisma.photoLike.findMany({
      where: { photoId: { in: photoIds }, guestClientId },
      select: { photoId: true, reactionType: true },
    });
    myReactionByPhoto = new Map(mine.map((m) => [m.photoId, m.reactionType]));
  }

  return { reactionsByPhoto, myReactionByPhoto };
}

function reactionShape(photoId, reactionsByPhoto, myReactionByPhoto) {
  return {
    reactions: reactionsByPhoto.get(photoId) || {},
    my_reaction: myReactionByPhoto.get(photoId) || null,
  };
}

/** True once an event's own guest-upload window has closed — independent
 * of the main 90-day guest-access window (isExpired), since an owner can
 * set a shorter/longer window specifically for uploads. Falls back to the
 * main expiresAt when no custom window is set. */
function guestUploadWindowClosed(event) {
  if (event.guestUploadWindowDays == null || !event.guestUploadEnabledAt) {
    return isExpired(event);
  }
  const closesAt = new Date(
    event.guestUploadEnabledAt.getTime() + event.guestUploadWindowDays * 24 * 60 * 60 * 1000
  );
  return new Date() > closesAt;
}

function photoResponseShape(event, photo) {
  return {
    photo_id: photo.id,
    filename: photo.filename,
    createdAt: photo.createdAt,
    url: `/files/events/${event.id}/photos/${photo.id}`,
    thumbnail_url: `/files/events/${event.id}/photos/${photo.id}/thumb`,
  };
}

router.get("/:slug", async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({
      where: { guestSlug: req.params.slug },
      include: { owner: true, subGalleries: { orderBy: { createdAt: "asc" } } },
    });
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    res.json({
      id: event.id,
      name: event.name,
      studio_name: event.owner?.studioName ?? null,
      logo_url: event.owner?.logoPath ? `/files/branding/${event.owner.id}/logo` : null,
      brand_color: event.owner?.brandColor ?? null,
      expired: isExpired(event),
      // MERGE (Studio-Verse): lets the guest frontend show the right UI —
      // a studio can run either, both, or (temporarily) neither on this
      // event. See MERGE_PLAN.md D6.
      face_search_enabled: event.faceSearchEnabled,
      photo_selection_enabled: event.photoSelectionEnabled,
      guest_upload_enabled: event.guestUploadEnabled,
      // Phase 2 (consent-first Face Search): the guest page renders the
      // consent checkbox + privacy notice from these; old events default
      // to consent-free search, so nothing already live changes.
      require_face_search_consent: event.requireFaceSearchConsent,
      privacy_notice_text: effectivePrivacyNotice(event),
      selfie_retention_mode: event.selfieRetentionMode,
      allow_guest_data_delete_request: event.allowGuestDataDeleteRequest,
      // When present, the frontend shows a picker instead of the search
      // form directly — a parent with sub-galleries is a pure menu, not a
      // searchable gallery of its own (see routes/events.js's create route).
      sub_galleries: event.subGalleries.map((s) => ({ name: s.name, slug: s.guestSlug })),
      // Phase 3 (gallery access upgrade): branded prompt/login/expired
      // screens render from these + the studio branding above. Old events
      // are accessMode "public", so nothing already live changes.
      ...galleryAccessFlags(event),
    });
  } catch (err) {
    next(err);
  }
});

// Phase 3: trade the studio's private access key for a gallery unlock
// token (12h JWT, sent back as x-gallery-key / ?gallery_key= on later
// calls). Public by necessity — this IS the locked door. Brute-force
// throttled by bcrypt cost plus the search limiter.
router.post("/:slug/unlock", guestSearchLimiter, async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { guestSlug: req.params.slug } });
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    if ((event.accessMode || "public") !== "private_key") {
      return res.status(400).json({ error: "This gallery doesn't need an access key." });
    }
    const { access_key: key } = req.body || {};
    if (!(await checkAccessKey(event, key))) {
      return res.status(401).json({ error: "That access key didn't match — check with your photographer.", code: "locked" });
    }
    res.json({ gallery_token: signGalleryToken({ eventId: event.id, slug: event.guestSlug }), expires_in: Number(process.env.GALLERY_TOKEN_TTL_SECONDS || 12 * 60 * 60) });
  } catch (err) {
    next(err);
  }
});

// Phase 3 gate: every guest JSON route below this line requires gallery
// access (private_key → unlock token, client_login/invite_only → closed
// with a login prompt). Expired/archived events fall through so each
// route's own 410 stays authoritative.
router.use("/:slug", async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { guestSlug: req.params.slug } });
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    if (isExpired(event)) return next();
    const denied = checkGalleryAccess(event, req);
    if (denied) return res.status(denied.status).json(denied.body);
    next();
  } catch (err) {
    next(err);
  }
});

router.post("/:slug/search", guestSearchLimiter, upload.array("selfies", 3), async (req, res, next) => {
  // Declared outside try so the finally can scrub selfie buffers even on
  // early validation returns — memory-only uploads, zeroed, never stored.
  let uploadedSelfies = [];
  try {
    const event = await prisma.event.findUnique({
      where: { guestSlug: req.params.slug },
      include: { owner: { select: { studioName: true } } },
    });
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    if (isExpired(event)) {
      return res.status(410).json({ error: "This event's guest access has closed." });
    }
    // MERGE (Studio-Verse): the studio has this feature off — see
    // MERGE_PLAN.md D6. Independent of Photo Selection's own state.
    if (!event.faceSearchEnabled) {
      return res.status(403).json({ error: "Face Search isn't turned on for this event." });
    }
    // Phase 2 (consent-first): block until the guest accepts; acceptances
    // are audit-logged with the notice text/version they saw.
    let consentId = null;
    try {
      consentId = await requireSelfieConsent(event, {
        consented: req.body?.face_search_consent,
        guestClientId: req.body?.guest_client_id || null,
        req,
      });
    } catch (err) {
      return res.status(err.status || 403).json({ error: err.message, code: err.code || "consent_required" });
    }

    const files = req.files || [];
    uploadedSelfies = files;
    if (files.length === 0) {
      return res.status(400).json({ error: "No selfies uploaded (expected multipart field 'selfies')" });
    }

    let facesDetected = 0;
    const embeddings = [];

    for (const file of files) {
      const ext = path.extname(file.originalname).toLowerCase();
      // Skip just this one selfie if it's not a real image (extension +
      // content-sniffed magic bytes) — 1-3 are submitted, one bad file
      // shouldn't torpedo the others.
      // Guest selfies are stills for face matching — video never matches.
      if (!IMAGE_EXTENSIONS.has(ext) || !contentMatchesExtension(file.buffer, ext)) {
        continue;
      }

      let detection;
      try {
        detection = await detectFaces(file.buffer, file.originalname);
      } catch (err) {
        return next(err);
      }

      const faces = detection.faces || [];
      facesDetected += faces.length;

      if (faces.length > 0) {
        const queryFace = pickLargestFace(faces);
        embeddings.push(queryFace.embedding);
      }
    }

    if (embeddings.length === 0) {
      return res.status(422).json({ error: "No face detected in the uploaded photo. Try a clearer, front-facing photo." });
    }

    const queryEmbedding = averageAndNormalize(embeddings);
    const threshold = getEffectiveThreshold(event);

    const rows = await searchSimilarPhotos({
      eventId: event.id,
      embedding: queryEmbedding,
      threshold,
    });

    // Phase 22 group-assisted recall: confident direct matches also pull
    // in same-person sibling photos the raw query missed. Siblings carry
    // the seed's similarity and a match_via_group flag, and still pass
    // every photo filter below — recall goes up, nothing hidden leaks.
    const groupExtra = await expandMatchesWithGroups(
      event.id,
      threshold,
      rows.map((r) => ({ photoId: r.photoId, similarity: Number(r.similarity) }))
    );
    const seenPhotoIds = new Set(rows.map((r) => r.photoId));
    const allRows = [
      ...rows,
      ...groupExtra.filter((g) => {
        if (seenPhotoIds.has(g.photoId)) return false;
        seenPhotoIds.add(g.photoId);
        return true;
      }),
    ];

    const guestClientId = req.body?.guest_client_id || null;

    let matches = [];
    if (allRows.length > 0) {
      const photos = await prisma.photo.findMany({
        // Pending guest uploads are never searchable — they only become
        // visible/matchable once the owner approves them.
        where: { id: { in: allRows.map((r) => r.photoId) }, approvalStatus: "approved", faceSearchVisible: true, archivedAt: null },
      });
      const photoById = new Map(photos.map((p) => [p.id, p]));

      const { reactionsByPhoto, myReactionByPhoto } = await getReactionInfo(
        photos.map((p) => p.id),
        guestClientId
      );

      matches = allRows
        .map((r) => {
          const photo = photoById.get(r.photoId);
          if (!photo) return null;
          return {
            photo_id: photo.id,
            filename: photo.filename,
            similarity: Math.round(Number(r.similarity) * 10000) / 10000,
            match_via_group: !!r.matchViaGroup,
            url: `/files/events/${event.id}/photos/${photo.id}`,
            thumbnail_url: `/files/events/${event.id}/photos/${photo.id}/thumb`,
            ...reactionShape(photo.id, reactionsByPhoto, myReactionByPhoto),
          };
        })
        .filter(Boolean)
        .sort((a, b) => b.similarity - a.similarity);
    }

    const searchId = await insertGuestSearch({
      eventId: event.id,
      embedding: queryEmbedding,
      facesDetected,
      matchCount: matches.length,
      guestClientId,
    });

    res.json({
      search_id: searchId,
      faces_detected_in_selfie: facesDetected,
      consent_id: consentId,
      matches,
    });
  } catch (err) {
    next(err);
  } finally {
    scrubSelfieBuffers(uploadedSelfies);
  }
});

// Group search — one selfie PER PERSON (not multiple angles of the same
// person, see /:slug/search above), so a group of friends/family can find
// every photo containing ANY of them in one pass instead of each searching
// separately. Each uploaded selfie is searched independently; results are
// merged by photo, keeping the best similarity and how many of the group
// matched that photo.
router.post("/:slug/search/group", guestSearchLimiter, upload.array("selfies", 8), async (req, res, next) => {
  let uploadedSelfies = [];
  try {
    const event = await prisma.event.findUnique({
      where: { guestSlug: req.params.slug },
      include: { owner: { select: { studioName: true } } },
    });
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    if (isExpired(event)) {
      return res.status(410).json({ error: "This event's guest access has closed." });
    }
    if (!event.faceSearchEnabled) {
      return res.status(403).json({ error: "Face Search isn't turned on for this event." });
    }
    // Phase 2 (consent-first): same gate as solo search — one checkbox
    // covers the whole group sitting around the same phone.
    let consentId = null;
    try {
      consentId = await requireSelfieConsent(event, {
        consented: req.body?.face_search_consent,
        guestClientId: req.body?.guest_client_id || null,
        req,
      });
    } catch (err) {
      return res.status(err.status || 403).json({ error: err.message, code: err.code || "consent_required" });
    }

    const files = req.files || [];
    uploadedSelfies = files;
    if (files.length < 2) {
      return res.status(400).json({ error: "Group search needs at least 2 selfies — one per person" });
    }

    const threshold = getEffectiveThreshold(event);

    // best: Map<photoId, { similarity, peopleMatched }>
    const best = new Map();
    let peopleDetected = 0;

    for (const file of files) {
      const ext = path.extname(file.originalname).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(ext) || !contentMatchesExtension(file.buffer, ext)) continue;

      let detection;
      try {
        detection = await detectFaces(file.buffer, file.originalname);
      } catch (err) {
        return next(err);
      }
      const faces = detection.faces || [];
      if (faces.length === 0) continue;

      peopleDetected += 1;
      const embedding = pickLargestFace(faces).embedding;
      const rows = await searchSimilarPhotos({ eventId: event.id, embedding, threshold });

      // Phase 22 group-assisted recall, per person: confident matches also
      // pull in same-person siblings (flagged, same merge semantics).
      const groupExtra = await expandMatchesWithGroups(
        event.id,
        threshold,
        rows.map((r) => ({ photoId: r.photoId, similarity: Number(r.similarity) }))
      );
      const seenExtra = new Set(rows.map((r) => r.photoId));
      const personRows = [
        ...rows.map((r) => ({ photoId: r.photoId, similarity: Number(r.similarity), matchViaGroup: false })),
        ...groupExtra.filter((g) => {
          if (seenExtra.has(g.photoId)) return false;
          seenExtra.add(g.photoId);
          return true;
        }),
      ];

      for (const r of personRows) {
        const existing = best.get(r.photoId);
        const similarity = Number(r.similarity);
        if (!existing) {
          best.set(r.photoId, { similarity, peopleMatched: 1, matchViaGroup: !!r.matchViaGroup });
        } else {
          best.set(r.photoId, {
            similarity: Math.max(existing.similarity, similarity),
            peopleMatched: existing.peopleMatched + 1,
            // A direct vector hit outranks a group pull for the flag.
            matchViaGroup: existing.matchViaGroup && !!r.matchViaGroup,
          });
        }
      }
    }

    if (peopleDetected === 0) {
      return res.status(422).json({ error: "No face detected in any of the uploaded selfies." });
    }

    const photoIds = [...best.keys()];
    const photos = await prisma.photo.findMany({
      where: { id: { in: photoIds }, approvalStatus: "approved", faceSearchVisible: true, archivedAt: null },
    });
    const guestClientId = req.body?.guest_client_id || null;
    const { reactionsByPhoto, myReactionByPhoto } = await getReactionInfo(
      photos.map((p) => p.id),
      guestClientId
    );

    const matches = photos
      .map((photo) => {
        const info = best.get(photo.id);
        if (!info) return null;
        return {
          photo_id: photo.id,
          filename: photo.filename,
          similarity: Math.round(info.similarity * 10000) / 10000,
          people_matched: info.peopleMatched,
          match_via_group: !!info.matchViaGroup,
          url: `/files/events/${event.id}/photos/${photo.id}`,
          thumbnail_url: `/files/events/${event.id}/photos/${photo.id}/thumb`,
          ...reactionShape(photo.id, reactionsByPhoto, myReactionByPhoto),
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.people_matched - a.people_matched || b.similarity - a.similarity);

    res.json({
      people_detected: peopleDetected,
      consent_id: consentId,
      matches,
    });
  } catch (err) {
    next(err);
  } finally {
    scrubSelfieBuffers(uploadedSelfies);
  }
});

// Phase 2 (guest data rights): file an export/delete request for your own
// Face Search footprint with nothing but your guest id + an optional
// contact. Deletion requests need the studio's opt-in flag; exports of
// your own data are always allowed. Idempotent per (guest, type) while
// one is still pending.
router.post("/:slug/data-request", guestFeedbackLimiter, async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { guestSlug: req.params.slug } });
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    const { guest_client_id: guestClientId, contact, type } = req.body || {};
    if (!guestClientId || typeof guestClientId !== "string") {
      return res.status(400).json({ error: "guest_client_id is required" });
    }
    if (type !== "export" && type !== "delete") {
      return res.status(400).json({ error: 'type must be "export" or "delete"' });
    }
    if (type === "delete" && !event.allowGuestDataDeleteRequest) {
      return res.status(403).json({
        error: "Deletion requests are turned off for this event — please contact the studio directly.",
      });
    }
    if (contact != null && (typeof contact !== "string" || contact.length > 200)) {
      return res.status(400).json({ error: "contact must be a short string" });
    }
    const existing = await prisma.guestDataRequest.findFirst({
      where: { eventId: event.id, guestClientId, type, status: "pending" },
    });
    if (existing) {
      return res.json({ request_id: existing.id, type: existing.type, status: existing.status });
    }
    const created = await prisma.guestDataRequest.create({
      data: { eventId: event.id, guestClientId, contact: contact?.trim() || null, type },
    });
    res.status(201).json({ request_id: created.id, type: created.type, status: created.status });
  } catch (err) {
    next(err);
  }
});

// Your own requests' statuses — so the page can show "pending review" vs
// "completed" without the guest asking the studio.
router.get("/:slug/data-request/status", async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { guestSlug: req.params.slug } });
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    const guestClientId = req.query.guest_client_id;
    if (!guestClientId || typeof guestClientId !== "string") {
      return res.status(400).json({ error: "guest_client_id is required" });
    }
    const requests = await prisma.guestDataRequest.findMany({
      where: { eventId: event.id, guestClientId },
      orderBy: { createdAt: "desc" },
    });
    res.json(
      requests.map((r) => ({
        request_id: r.id,
        type: r.type,
        status: r.status,
        created_at: r.createdAt,
        resolved_at: r.resolvedAt,
      }))
    );
  } catch (err) {
    next(err);
  }
});

// Guest-contributed photos — opt-in per event (Event.guestUploadEnabled),
// reachable via a distinct upload link/QR from the studio, separate from the
// search link. Runs the same face-detect/thumbnail/storage-cap pipeline as
// an owner upload, but every photo lands as approvalStatus: "pending" and
// is invisible to search/live-gallery until the owner approves it — this
// is a public, unauthenticated write endpoint, so nothing it creates is
// trusted until a human on the studio side has looked at it. Runs
// synchronously (no job/SSE plumbing) since guest batches are small — file
// count is capped below to bound request duration.
router.post("/:slug/upload", guestUploadLimiter, upload.array("files", 10), async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { guestSlug: req.params.slug } });
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    if (isExpired(event)) {
      return res.status(410).json({ error: "This event's guest access has closed." });
    }
    if (!event.guestUploadEnabled) {
      return res.status(403).json({ error: "Guest uploads aren't turned on for this event." });
    }
    if (guestUploadWindowClosed(event)) {
      return res.status(410).json({ error: "The guest upload window for this event has closed." });
    }

    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({ error: "No files uploaded (expected multipart field 'files')" });
    }

    const guestClientId = req.body?.guest_client_id || null;
    const owner = await prisma.user.findUnique({ where: { id: event.ownerId } });
    let usedBytes = await eventStorageUsedBytes(prisma, event.id);
    const storageLimitBytes = effectiveStorageLimitBytes(owner);

    const skipped = [];
    let uploaded = 0;

    for (const file of files) {
      const ext = path.extname(file.originalname).toLowerCase();

      if (!ALLOWED_EXTENSIONS.has(ext)) {
        skipped.push(`${file.originalname} (unsupported file type)`);
        continue;
      }
      if (!contentMatchesExtension(file.buffer, ext)) {
        skipped.push(`${file.originalname} (file content doesn't match its extension)`);
        continue;
      }
      if (usedBytes + file.buffer.length > storageLimitBytes) {
        skipped.push(`${file.originalname} (event storage limit reached)`);
        continue;
      }

      const photoId = randomUUID();
      const storedFilename = `${photoId}${ext}`;
      const storagePath = await getStorageProvider().writeOriginal(event.id, storedFilename, file.buffer);
      // Videos skip thumbnailing (no frame extraction — players render the
      // first frame natively) and moderation (an image heuristic); both
      // helpers would just burn CPU and resolve uselessly on video bytes.
      const isVideo = isVideoExtension(ext);
      const thumbnailPath = isVideo ? null : await generateThumbnail(file.buffer, event.id, photoId);
      // Best-effort only, guest uploads exclusively — see checkModeration's
      // own doc comment for exactly what this does and doesn't catch.
      const moderationFlagged = isVideo ? false : await checkModeration(file.buffer, file.originalname);

      const photo = await prisma.photo.create({
        data: {
          id: photoId,
          eventId: event.id,
          filename: file.originalname,
          storagePath,
          thumbnailPath,
          faceCount: 0,
          fileSize: file.buffer.length,
          source: "guest",
          approvalStatus: "pending",
          // Videos are browsed by clients, never face-matched by guests —
          // false keeps every guest face-search surface filtering them out.
          faceSearchVisible: isVideo ? false : event.faceSearchEnabled,
          moderationFlagged,
          uploadedByGuestClientId: guestClientId,
          originalExpiresAt: new Date(Date.now() + effectivePhotoRetentionDays(owner) * 24 * 60 * 60 * 1000),
        },
      });

      usedBytes += file.buffer.length;
      uploaded += 1;
      // Deliberately no publishLiveEvent/checkAndNotifyForNewPhotos here —
      // this photo doesn't exist yet as far as search or the live gallery
      // are concerned until an owner approves it (see events.js's approve
      // route).
    }

    res.json({ ok: true, uploaded, skipped });
  } catch (err) {
    next(err);
  }
});

// Public, read-only gallery of this event's approved photos — powers the
// live slideshow/carousel view (thumbnails only, same as everywhere else
// guest-facing). Most recent first, capped so a very long-running event
// doesn't hand back an unbounded response.
router.get("/:slug/gallery", async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { guestSlug: req.params.slug } });
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    if (isExpired(event)) {
      return res.status(410).json({ error: "This event's guest access has closed." });
    }

    const photos = await prisma.photo.findMany({
      where: { eventId: event.id, approvalStatus: "approved", faceSearchVisible: true, archivedAt: null },
      orderBy: { createdAt: "desc" },
      take: 300,
    });

    res.json({ photos: photos.map((p) => photoResponseShape(event, p)) });
  } catch (err) {
    next(err);
  }
});

// Public SSE feed of "a new photo just landed" for this event — same
// underlying bus as the owner-side stream (events.js's /:id/live/stream),
// just scoped by guestSlug instead of requiring auth, so the slideshow
// view can update itself without polling. A guest upload only reaches this
// once approved (see events.js's approve route), never at upload time.
router.get("/:slug/live/stream", async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { guestSlug: req.params.slug } });
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const onEvent = (payload) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);
    const unsubscribe = subscribeLiveEvents(event.id, onEvent);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  } catch (err) {
    next(err);
  }
});

// Toggles a guest's like on a photo — one row per (photo, guest), so
// calling this twice with the same guest_client_id likes then unlikes.
// Public like counts are an explicit product decision (not a private
// per-guest favorites list) — see the Photo model's comment.
// Sets/switches/removes a guest's reaction on a photo: tapping a new
// reaction type creates or switches to it, tapping the SAME type again
// removes it. Public reaction counts are an explicit product decision
// (not a private per-guest favorites list) — see the PhotoLike model.
router.post("/:slug/photos/:photoId/react", guestLikeLimiter, async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { guestSlug: req.params.slug } });
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    if (isExpired(event)) {
      return res.status(410).json({ error: "This event's guest access has closed." });
    }

    const { guest_client_id: guestClientId, reaction } = req.body || {};
    if (!guestClientId) {
      return res.status(400).json({ error: "guest_client_id is required" });
    }
    if (!isValidReactionType(reaction)) {
      return res.status(400).json({ error: `reaction must be one of: ${REACTION_TYPES.join(", ")}` });
    }

    const photo = await prisma.photo.findFirst({
      where: { id: req.params.photoId, eventId: event.id, approvalStatus: "approved", faceSearchVisible: true, archivedAt: null },
    });
    if (!photo) {
      return res.status(404).json({ error: "Photo not found" });
    }

    const existing = await prisma.photoLike.findUnique({
      where: { photoId_guestClientId: { photoId: photo.id, guestClientId } },
    });

    let myReaction;
    if (existing && existing.reactionType === reaction) {
      await prisma.photoLike.delete({ where: { id: existing.id } });
      myReaction = null;
    } else if (existing) {
      await prisma.photoLike.update({ where: { id: existing.id }, data: { reactionType: reaction } });
      myReaction = reaction;
    } else {
      await prisma.photoLike.create({
        data: { id: randomUUID(), photoId: photo.id, eventId: event.id, guestClientId, reactionType: reaction },
      });
      myReaction = reaction;
    }

    const grouped = await prisma.photoLike.groupBy({
      by: ["reactionType"],
      where: { photoId: photo.id },
      _count: true,
    });
    const reactions = {};
    for (const row of grouped) reactions[row.reactionType] = row._count;

    res.json({ reactions, my_reaction: myReaction });
  } catch (err) {
    next(err);
  }
});

// "Everything I reacted to" — a guest's own reaction history within this
// event, so they can revisit photos they hearted/etc. without re-searching.
router.get("/:slug/my-reactions", async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { guestSlug: req.params.slug } });
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    const guestClientId = req.query.guest_client_id;
    if (!guestClientId) {
      return res.status(400).json({ error: "guest_client_id is required" });
    }

    const myLikes = await prisma.photoLike.findMany({
      where: { eventId: event.id, guestClientId },
      orderBy: { createdAt: "desc" },
    });
    if (myLikes.length === 0) return res.json({ photos: [] });

    const photos = await prisma.photo.findMany({
      where: { id: { in: myLikes.map((l) => l.photoId) }, approvalStatus: "approved", faceSearchVisible: true, archivedAt: null },
    });
    const photoById = new Map(photos.map((p) => [p.id, p]));

    const result = myLikes
      .map((l) => {
        const photo = photoById.get(l.photoId);
        if (!photo) return null;
        return { ...photoResponseShape(event, photo), my_reaction: l.reactionType };
      })
      .filter(Boolean);

    res.json({ photos: result });
  } catch (err) {
    next(err);
  }
});

// Public comment thread on a photo — visible to every guest browsing the
// event (an explicit product decision), moderated by the owner deleting
// individual comments (see events.js).
router.get("/:slug/photos/:photoId/comments", async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { guestSlug: req.params.slug } });
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    const photo = await prisma.photo.findFirst({
      where: { id: req.params.photoId, eventId: event.id, approvalStatus: "approved", faceSearchVisible: true, archivedAt: null },
    });
    if (!photo) {
      return res.status(404).json({ error: "Photo not found" });
    }

    const comments = await prisma.photoComment.findMany({
      where: { photoId: photo.id },
      orderBy: { createdAt: "asc" },
    });

    res.json({
      comments: comments.map((c) => ({
        id: c.id,
        guest_name: c.guestName || "Guest",
        text: c.text,
        created_at: c.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/:slug/photos/:photoId/comments", guestCommentLimiter, async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { guestSlug: req.params.slug } });
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    if (isExpired(event)) {
      return res.status(410).json({ error: "This event's guest access has closed." });
    }

    const { guest_client_id: guestClientId, guest_name: guestName, text } = req.body || {};
    if (!guestClientId) {
      return res.status(400).json({ error: "guest_client_id is required" });
    }
    if (!text || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "A comment can't be empty" });
    }
    if (text.length > 500) {
      return res.status(400).json({ error: "Comments are limited to 500 characters" });
    }

    const photo = await prisma.photo.findFirst({
      where: { id: req.params.photoId, eventId: event.id, approvalStatus: "approved", faceSearchVisible: true, archivedAt: null },
    });
    if (!photo) {
      return res.status(404).json({ error: "Photo not found" });
    }

    const comment = await prisma.photoComment.create({
      data: {
        id: randomUUID(),
        photoId: photo.id,
        eventId: event.id,
        guestClientId,
        guestName: guestName && typeof guestName === "string" ? guestName.slice(0, 60) : null,
        text: text.trim(),
      },
    });

    res.status(201).json({
      id: comment.id,
      guest_name: comment.guestName || "Guest",
      text: comment.text,
      created_at: comment.createdAt,
    });
  } catch (err) {
    next(err);
  }
});

// Opts a guest in to being notified (email or WhatsApp) if more photos of
// them show up later in this event — the natural follow-up to a search once
// photos can keep arriving live via Shoots. `guest_client_id` is the same
// anonymous id already used for search/feedback (src/guestId.js on the
// frontend) — like the rest of this API's guest identity model, it's an
// unguessable id acting as its own bearer token, not paired with any login.
router.post("/:slug/alerts/subscribe", guestAlertLimiter, async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { guestSlug: req.params.slug } });
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    if (isExpired(event)) {
      return res.status(410).json({ error: "This event's guest access has closed." });
    }

    const { guest_client_id: guestClientId, channel, contact } = req.body || {};
    if (!guestClientId) {
      return res.status(400).json({ error: "guest_client_id is required" });
    }
    if (channel !== "email" && channel !== "whatsapp") {
      return res.status(400).json({ error: "channel must be 'email' or 'whatsapp'" });
    }
    if (channel === "email" && !isValidEmail(contact)) {
      return res.status(400).json({ error: "A valid email address is required" });
    }
    if (channel === "whatsapp" && !isValidE164(contact)) {
      return res.status(400).json({ error: "A valid phone number in international format (e.g. +919876543210) is required" });
    }

    await subscribeGuestAlert({ eventId: event.id, guestClientId, channel, contact });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/:slug/alerts/unsubscribe", guestAlertLimiter, async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { guestSlug: req.params.slug } });
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    const { guest_client_id: guestClientId } = req.body || {};
    if (!guestClientId) {
      return res.status(400).json({ error: "guest_client_id is required" });
    }

    await unsubscribeGuestAlert({ eventId: event.id, guestClientId });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// One-off "text me this gallery link on WhatsApp" — distinct from the alert
// subscription above (this just sends the link once, right now; no ongoing
// notifications). Uses the same lib/whatsapp.js wrapper.
router.post("/:slug/whatsapp/send-link", guestWhatsAppLinkLimiter, async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { guestSlug: req.params.slug } });
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    if (isExpired(event)) {
      return res.status(410).json({ error: "This event's guest access has closed." });
    }

    const { phone } = req.body || {};
    if (!isValidE164(phone)) {
      return res.status(400).json({ error: "A valid phone number in international format (e.g. +919876543210) is required" });
    }

    const galleryUrl = `${process.env.PUBLIC_WEB_URL || "http://localhost:5173"}/e/${event.guestSlug}`;
    await sendWhatsAppMessage(phone, `Here's your PandaSpot gallery for "${event.name}": ${galleryUrl}`);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/:slug/feedback", guestFeedbackLimiter, async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { guestSlug: req.params.slug } });
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    if (isExpired(event)) {
      return res.status(410).json({ error: "This event's guest access has closed." });
    }

    const { search_id, photo_id } = req.body || {};
    if (!search_id || !photo_id) {
      return res.status(400).json({ error: "search_id and photo_id are required" });
    }

    const search = await prisma.guestSearch.findUnique({ where: { id: search_id } });
    if (!search || search.eventId !== event.id) {
      return res.status(404).json({ error: "Search not found" });
    }

    const newThreshold = await adjustThresholdOnFeedback(prisma, event);

    let similarity = await similarityForPhoto({ searchId: search.id, photoId: photo_id });
    if (similarity === null) similarity = 0;

    await prisma.matchFeedback.create({
      data: {
        id: randomUUID(),
        searchId: search.id,
        photoId: photo_id,
        similarity,
      },
    });

    res.json({ ok: true, new_threshold: newThreshold });
  } catch (err) {
    next(err);
  }
});

router.post("/:slug/download", guestDownloadLimiter, async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { guestSlug: req.params.slug } });
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    if (isExpired(event)) {
      return res.status(410).json({ error: "This event's guest access has closed." });
    }
    // MERGE (Studio-Verse allow_download, Phase 18E): the studio opted this
    // event out of downloads — view/search still work, zips don't.
    if (!event.allowDownload) {
      return res.status(403).json({ error: "Downloads are disabled for this event by the studio." });
    }

    const photoIds = req.body?.photo_ids;
    if (!Array.isArray(photoIds) || photoIds.length === 0) {
      return res.status(400).json({ error: "photo_ids (non-empty array) is required" });
    }

    // Only zip photos that actually belong to this event — a guest can only
    // ever have gotten a photo_id from this event's own search results, but
    // we don't trust the client-supplied list further than that.
    const photos = await prisma.photo.findMany({
      where: { id: { in: photoIds }, eventId: event.id, approvalStatus: "approved", faceSearchVisible: true, archivedAt: null },
    });
    if (photos.length === 0) {
      return res.status(404).json({ error: "None of the requested photos belong to this event" });
    }

    const zipFilename = zipFilenameForEvent(event);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipFilename}"`);

    await streamPhotosZip(photos, res);
  } catch (err) {
    next(err);
  }
});

router.post("/:slug/download/email", guestDownloadLimiter, async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { guestSlug: req.params.slug } });
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    if (isExpired(event)) {
      return res.status(410).json({ error: "This event's guest access has closed." });
    }
    // MERGE (Studio-Verse allow_download, Phase 18E): the studio opted this
    // event out of downloads — view/search still work, zips don't.
    if (!event.allowDownload) {
      return res.status(403).json({ error: "Downloads are disabled for this event by the studio." });
    }

    const { photo_ids: photoIds, email } = req.body || {};
    if (!Array.isArray(photoIds) || photoIds.length === 0) {
      return res.status(400).json({ error: "photo_ids (non-empty array) is required" });
    }
    // Loose format check — mainly to reject garbage/injection attempts at
    // the boundary before it ever reaches nodemailer, not full RFC validation.
    if (!email || typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "A valid email address is required" });
    }

    const zipDownload = await prisma.zipDownload.create({
      data: {
        id: randomUUID(),
        eventId: event.id,
        photoIds,
        email,
        status: "pending",
      },
    });

    res.json({ ok: true });

    // Fire and forget — build the zip asynchronously and email the link
    // once ready, same "don't block the request" pattern as the upload
    // job queue (lib/jobQueue.js).
    (async () => {
      try {
        const photos = await prisma.photo.findMany({
          where: { id: { in: photoIds }, eventId: event.id, approvalStatus: "approved", faceSearchVisible: true, archivedAt: null },
        });
        if (photos.length === 0) {
          throw new Error("None of the requested photos belong to this event");
        }

        const filePath = await buildPhotosZipToDisk(photos, zipDownload.id);

        await prisma.zipDownload.update({
          where: { id: zipDownload.id },
          data: { status: "ready", filePath, readyAt: new Date() },
        });

        const downloadUrl = `${PUBLIC_SERVER_URL}/e/${event.guestSlug}/downloads/${zipDownload.id}`;
        await sendZipReadyEmail(email, downloadUrl);
      } catch (err) {
        console.error(`Failed to build/email zip for ZipDownload ${zipDownload.id}:`, err);
        await prisma.zipDownload
          .update({
            where: { id: zipDownload.id },
            data: { status: "failed", errorMessage: err.message || "Unknown error" },
          })
          .catch((updateErr) => console.error("Failed to record ZipDownload failure:", updateErr));
      }
    })();
  } catch (err) {
    next(err);
  }
});

router.get("/:slug/downloads/:downloadId", async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({ where: { guestSlug: req.params.slug } });
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }
    if (isExpired(event)) {
      return res.status(410).json({ error: "This event's guest access has closed." });
    }

    const zipDownload = await prisma.zipDownload.findUnique({ where: { id: req.params.downloadId } });
    if (!zipDownload || zipDownload.eventId !== event.id) {
      return res.status(404).json({ error: "Download not found" });
    }

    // MERGE (Studio-Verse allow_download, Phase 18E): gated at serve time
    // too, so opting out also stops pre-built zips — same as Studio-Verse's
    // per-request mediaServe check.
    if (!event.allowDownload) {
      return res.status(403).json({ error: "Downloads are disabled for this event by the studio." });
    }

    if (zipDownload.status !== "ready") {
      return res.status(409).json({ error: "Your download isn't ready yet — check back in a moment." });
    }

    const filePath = zipDownload.filePath || zipDownloadPath(zipDownload.id);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Zip file missing on disk" });
    }

    const zipFilename = zipFilenameForEvent(event);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipFilename}"`);
    res.sendFile(filePath);
  } catch (err) {
    next(err);
  }
});

export default router;
