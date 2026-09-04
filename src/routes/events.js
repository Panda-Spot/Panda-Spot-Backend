import { Router, raw } from "express";
import bcrypt from "bcryptjs";
import { randomUUID, randomBytes } from "node:crypto";
import path from "node:path";
import fsp from "node:fs/promises";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";
import {
  ALLOWED_EXTENSIONS,
  IMAGE_EXTENSIONS,
  appendUploadPart,
  deleteFileIfExists,
  deleteUploadPart,
  saveEventCover,
  saveEventSponsorLogo,
  uploadPartPath,
  uploadPartSize,
} from "../lib/storage.js";
import { getStorageProvider } from "../lib/storageProvider.js";
import { detectFacesForPhoto, indexExistingPhotoFaces, replacePhotoFaces } from "../lib/faces.js";
import { createJob, emitJobEvent, getJob } from "../lib/jobQueue.js";
import { loadAccessibleEvent } from "../lib/access.js";
import { ACCESS_MODES, setAccessKey } from "../lib/galleryAccess.js";
import { sendCollaboratorInviteEmail, sendClientInviteEmail } from "../lib/mailer.js";
import { contentMatchesExtension, isVideoExtension, isVideoFilename } from "../lib/fileValidation.js";
import { getEffectiveThreshold } from "../lib/threshold.js";
import { getFaceGroups } from "../lib/faceClustering.js";
import { uploadLimiter, driveImportLimiter, shootsCredentialLimiter } from "../lib/rateLimiters.js";
import { generateShootsCredentials } from "../lib/ftpShoots.js";
import { publishLiveEvent, subscribeLiveEvents } from "../lib/liveEvents.js";
import { generateThumbnail } from "../lib/thumbnails.js";
import { extractFolderId, listImageFiles, testFolderAccess } from "../lib/googleDrive.js";
import { processDriveImportJob, processDriveSyncJob } from "../lib/driveSync.js";
import { countOwnedEvents, eventStorageUsedBytes, effectiveEventLimit, effectiveStorageLimitBytes, effectivePhotoRetentionDays } from "../lib/planLimits.js";
import { computeExpiresAt } from "../lib/expiry.js";
import { bucketByDay } from "../lib/dailyBuckets.js";
import { checkAndNotifyForNewPhotos } from "../lib/guestAlerts.js";
import { isDriveBackupConfigured, isDriveBackupBetaUser } from "../lib/driveBackupAuth.js";
import { reclaimEventDriveBackups } from "../lib/driveBackupRetention.js";
import { deleteEventCascade } from "../lib/eventLifecycle.js";
import { streamPhotosZip, zipFilenameForEvent } from "../lib/zip.js";
import { uploadToDriveFolder, MIME_BY_EXT } from "../lib/driveBackup.js";
import { assertQuotaAvailable, consumeAiPhotoCredits, consumeQuota } from "../lib/subscriptionAccess.js";

const PUBLIC_WEB_URL = process.env.PUBLIC_WEB_URL || "http://localhost:5173";
// Loose format check — mirrors guest.js's /e/:slug/download/email regex.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const router = Router();

router.use(requireAuth);

function guestLinkPath(slug) {
  return `/e/${slug}`;
}

async function generateUniqueSlug() {
  // A handful of URL-safe random chars; collision chance is negligible at
  // this length, but we check anyway since it costs one cheap query.
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = randomBytes(6).toString("base64url");
    const existing = await prisma.event.findUnique({ where: { guestSlug: slug } });
    if (!existing) return slug;
  }
  throw new Error("Could not generate a unique guest slug, please retry");
}

router.post("/", async (req, res, next) => {
  try {
    const { name } = req.body || {};
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name is required" });
    }

    const owner = await prisma.user.findUnique({ where: { id: req.user.id } });
    const ownedCount = await countOwnedEvents(prisma, req.user.id);
    const eventLimit = effectiveEventLimit(owner);
    if (ownedCount >= eventLimit) {
      return res.status(403).json({
        error: `You've reached your plan's limit of ${eventLimit} events. Upgrade coming soon.`,
      });
    }

    const guestSlug = await generateUniqueSlug();
    const event = await prisma.event.create({
      data: { name: name.trim(), ownerId: req.user.id, guestSlug, expiresAt: computeExpiresAt() },
    });

    res.status(201).json({ ...event, guestLink: guestLinkPath(event.guestSlug) });
  } catch (err) {
    next(err);
  }
});

router.get("/", async (req, res, next) => {
  try {
    // MERGE (Studio-Verse archive, Phase 18E): ?status=active (default) |
    // archived | all. Defaulting to active keeps archived events out of
    // every existing caller's way; nothing already stored changes, since
    // archivedAt is null on every pre-existing row.
    const status = req.query.status ?? "active";
    if (!["active", "archived", "all"].includes(status)) {
      return res.status(400).json({ error: 'status must be "active", "archived", or "all"' });
    }
    const archivedFilter =
      status === "active" ? { archivedAt: null } : status === "archived" ? { archivedAt: { not: null } } : {};

    // Union of events owned by this user and events they collaborate on,
    // each tagged with their role on that event.
    // Sub-galleries are real Events but aren't shown as their own top-level
    // dashboard entries — a guest reaches them via the parent's picker (see
    // GET /:id's sub_galleries), and the owner manages them from the
    // parent's detail page too.
    const owned = await prisma.event.findMany({
      where: { ownerId: req.user.id, parentEventId: null, ...archivedFilter },
      include: { _count: { select: { photos: true } } },
    });
    const collabRows = await prisma.eventCollaborator.findMany({
      where: { userId: req.user.id },
      include: { event: { include: { _count: { select: { photos: true } } } } },
    });

    const all = [
      ...owned.map((e) => ({ ...e, role: "owner" })),
      ...collabRows.map((c) => ({ ...c.event, role: "collaborator" })),
    ].filter((e) =>
      status === "all" ? true : status === "active" ? !e.archivedAt : !!e.archivedAt
    );
    all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json(
      all.map((e) => ({
        id: e.id,
        name: e.name,
        guestSlug: e.guestSlug,
        guestLink: guestLinkPath(e.guestSlug),
        createdAt: e.createdAt,
        expires_at: e.expiresAt,
        archived_at: e.archivedAt,
        cover_url: e.coverPhotoPath ? `/files/events/${e.id}/cover` : null,
        photo_count: e._count.photos,
        role: e.role,
      }))
    );
  } catch (err) {
    next(err);
  }
});

// MERGE (Studio-Verse dashboard analytics, Phase 18H): studio-scoped
// aggregates for the Dashboard charts — totals, per-month buckets, top
// events, active/archived split. Owned + collaborated events, all time
// unless a bucket says otherwise. Read-only; powers the Media Uploads
// area chart and the status donut the Dashboard deliberately left out
// until this endpoint existed.
router.get("/analytics/summary", async (req, res, next) => {
  try {
    const owned = await prisma.event.findMany({
      where: { ownerId: req.user.id },
      select: { id: true, name: true, createdAt: true, archivedAt: true },
    });
    const collabRows = await prisma.eventCollaborator.findMany({
      where: { userId: req.user.id },
      select: { event: { select: { id: true, name: true, createdAt: true, archivedAt: true } } },
    });
    const seen = new Map();
    for (const e of [...owned, ...collabRows.map((c) => c.event)]) {
      if (e && !seen.has(e.id)) seen.set(e.id, e);
    }
    const events = [...seen.values()];
    const ids = events.map((e) => e.id);

    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
    sixMonthsAgo.setDate(1);
    sixMonthsAgo.setHours(0, 0, 0, 0);

    const [photoCount, clientCount, clientFavCount, pickCount, recentPhotos, topGroups] = await Promise.all([
      ids.length ? prisma.photo.count({ where: { eventId: { in: ids } } }) : 0,
      ids.length ? prisma.eventUserMapping.count({ where: { eventId: { in: ids } } }) : 0,
      ids.length ? prisma.clientFavourite.count({ where: { photo: { eventId: { in: ids } } } }) : 0,
      ids.length
        ? prisma.studioFavourite.count({ where: { userId: req.user.id, photo: { eventId: { in: ids } } } })
        : 0,
      ids.length
        ? prisma.photo.findMany({
            where: { eventId: { in: ids }, createdAt: { gte: sixMonthsAgo } },
            select: { createdAt: true },
          })
        : [],
      ids.length
        ? prisma.photo.groupBy({
            by: ["eventId"],
            where: { eventId: { in: ids } },
            _count: { eventId: true },
            orderBy: { _count: { eventId: "desc" } },
            take: 5,
          })
        : [],
    ]);

    const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      months.push(monthKey(d));
    }
    const eventsByMonth = months.map((month) => ({
      month,
      count: events.filter((e) => monthKey(new Date(e.createdAt)) === month).length,
    }));
    const mediaByMonth = months.map((month) => ({
      month,
      count: recentPhotos.filter((p) => monthKey(new Date(p.createdAt)) === month).length,
    }));

    const nameById = Object.fromEntries(events.map((e) => [e.id, e.name]));
    const archived = events.filter((e) => e.archivedAt).length;

    res.json({
      totals: {
        events: events.length,
        photos: photoCount,
        clients: clientCount,
        favourites: clientFavCount + pickCount,
      },
      events_by_month: eventsByMonth,
      media_by_month: mediaByMonth,
      top_events: topGroups.map((g) => ({
        event_id: g.eventId,
        event_name: nameById[g.eventId] ?? "(deleted event)",
        media_count: g._count.eventId,
      })),
      event_status: { active: events.length - archived, archived },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event, role } = accessible;

    const photoCount = await prisma.photo.count({ where: { eventId: event.id } });
    const aiIndexedPhotoCount = await prisma.photo.count({
      where: { eventId: event.id, faceIndexedAt: { not: null } },
    });
    const faceSearchSearchablePhotoCount = await prisma.photo.count({
      where: {
        eventId: event.id,
        approvalStatus: "approved",
        faceSearchVisible: true,
        faceIndexedAt: { not: null },
        archivedAt: null,
      },
    });
    const storageUsedBytes = await eventStorageUsedBytes(prisma, event.id);
    const owner = await prisma.user.findUnique({ where: { id: event.ownerId } });
    const pendingGuestUploadCount = await prisma.photo.count({
      where: { eventId: event.id, approvalStatus: "pending" },
    });
    const subGalleries = await prisma.event.findMany({
      where: { parentEventId: event.id },
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { photos: true } } },
    });

    res.json({
      id: event.id,
      name: event.name,
      guestSlug: event.guestSlug,
      guestLink: guestLinkPath(event.guestSlug),
      createdAt: event.createdAt,
      expires_at: event.expiresAt,
      photo_count: photoCount,
      ai_indexed_photo_count: aiIndexedPhotoCount,
      face_search_searchable_photo_count: faceSearchSearchablePhotoCount,
      storage_used_bytes: storageUsedBytes,
      storage_limit_bytes: effectiveStorageLimitBytes(owner),
      role,
      drive_folder_url: event.driveFolderUrl,
      drive_sync_enabled: event.driveSyncEnabled,
      last_drive_sync_at: event.lastDriveSyncAt,
      shoots_connected: !!event.ftpUsername,
      // Advanced/beta: mirroring Shoots captures into the connected Drive
      // folder via the platform's single Drive account — see
      // lib/driveBackup.js. drive_backup_available reflects whether that
      // platform-wide account is configured at all (isDriveBackupConfigured()),
      // not anything per-photographer.
      drive_backup_enabled: event.driveBackupEnabled,
      drive_backup_available: isDriveBackupConfigured(),
      started: !!event.startedAt,
      face_search_enabled: event.faceSearchEnabled,
      photo_selection_enabled: event.photoSelectionEnabled,
      published_at: event.publishedAt,
      archived_at: event.archivedAt,
      allow_download: event.allowDownload,
      // Phase 8 (live TV wall): on-air settings source of truth.
      tv_mode: event.tvMode,
      tv_transition_ms: event.tvTransitionMs,
      tv_show_qr: event.tvShowQr,
      sponsor_name: event.sponsorName,
      sponsor_logo_url: event.sponsorLogoPath ? `/files/events/${event.id}/sponsor-logo` : null,
      // Phase 3 (gallery access upgrade): settings panel source of truth
      // (key itself never leaves the server — only whether one is set).
      access_mode: event.accessMode,
      access_key_set: !!event.accessKeyHash,
      expires_at: event.expiresAt,
      expiry_preset: event.expiryPreset,
      // Phase 2 (consent-first Face Search): privacy settings for the
      // studio privacy card.
      require_face_search_consent: event.requireFaceSearchConsent,
      privacy_notice_text: event.privacyNoticeText,
      selfie_retention_mode: event.selfieRetentionMode,
      guest_data_retention_days: event.guestDataRetentionDays,
      allow_guest_data_delete_request: event.allowGuestDataDeleteRequest,
      cover_url: event.coverPhotoPath ? `/files/events/${event.id}/cover` : null,
      event_date: event.eventDate,
      event_venue: event.eventVenue,
      description: event.description,
      guest_upload_enabled: event.guestUploadEnabled,
      guest_upload_window_days: event.guestUploadWindowDays,
      pending_guest_upload_count: pendingGuestUploadCount,
      guest_upload_link: `${PUBLIC_WEB_URL}/e/${event.guestSlug}/upload`,
      slideshow_link: `${PUBLIC_WEB_URL}/e/${event.guestSlug}/slideshow`,
      is_sub_gallery: !!event.parentEventId,
      sub_galleries: subGalleries.map((s) => ({
        id: s.id,
        name: s.name,
        guest_slug: s.guestSlug,
        photo_count: s._count.photos,
      })),
    });
  } catch (err) {
    next(err);
  }
});

async function loadOwnedEvent(req, res) {
  const event = await prisma.event.findFirst({
    where: { id: req.params.id, ownerId: req.user.id },
  });
  if (!event) {
    res.status(404).json({ error: "Event not found" });
    return null;
  }
  return event;
}

// Owner-only — a freshly-created event has no upload/import/PandaShoots UI
// at all until this is called, so there's never any ambiguity about when a
// photo's retention clock (Photo.originalExpiresAt) began. One-way: no
// "unstart" action exists.
router.post("/:id/start", async (req, res, next) => {
  try {
    const event = await loadOwnedEvent(req, res);
    if (!event) return;
    if (event.startedAt) {
      return res.json({ started: true, started_at: event.startedAt });
    }
    const updated = await prisma.event.update({ where: { id: event.id }, data: { startedAt: new Date() } });
    res.json({ started: true, started_at: updated.startedAt });
  } catch (err) {
    next(err);
  }
});

// Creates a sub-gallery (e.g. "Ceremony"/"Reception") under this event —
// a fully real Event of its own, just reached by guests via the parent's
// picker (see guest.js's GET /:slug) instead of its own advertised QR. One
// level of nesting only: rejects if this event is itself already a
// sub-gallery. Auto-started (skips the normal manual "Start Event" step)
// since creating one here is already an intentional, ready-to-use action —
// the parent being started already implies the studio is mid-event.
router.post("/:id/sub-galleries", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    if (event.parentEventId) {
      return res.status(400).json({ error: "Sub-galleries can't themselves have sub-galleries." });
    }
    const { name } = req.body || {};
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name is required" });
    }

    const guestSlug = await generateUniqueSlug();
    const subGallery = await prisma.event.create({
      data: {
        name: name.trim(),
        ownerId: event.ownerId,
        parentEventId: event.id,
        guestSlug,
        expiresAt: event.expiresAt,
        startedAt: new Date(),
      },
    });

    res.status(201).json({
      id: subGallery.id,
      name: subGallery.name,
      guest_slug: subGallery.guestSlug,
      photo_count: 0,
    });
  } catch (err) {
    next(err);
  }
});

// Opt-in toggle for guests uploading their own photos back into this event
// via a dedicated link/QR (distinct from the search link). Owner or
// collaborator, same access level as every other ingestion toggle on this
// page. Requires the event to already be started, same as every other
// photo-ingestion entry point.
router.post("/:id/guest-uploads/toggle", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    if (!event.startedAt) {
      return res.status(400).json({ error: "Start this event before turning on guest uploads." });
    }

    const { enabled } = req.body || {};
    const updated = await prisma.event.update({
      where: { id: event.id },
      data: {
        guestUploadEnabled: !!enabled,
        // Stamped the moment it's turned on — the anchor for
        // guestUploadWindowDays. Left alone on future re-toggles so
        // turning it off/on doesn't quietly reset an owner-set window.
        guestUploadEnabledAt: enabled && !event.guestUploadEnabledAt ? new Date() : undefined,
      },
    });
    res.json({ guest_upload_enabled: updated.guestUploadEnabled });
  } catch (err) {
    next(err);
  }
});

// Owner or collaborator — sets/clears how many days guests can keep
// uploading, independent of the event's main 90-day guest-access window.
// Null resets to "same as everyone else" (isExpired/expiresAt).
router.post("/:id/guest-uploads/window", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const { window_days: windowDays } = req.body || {};
    if (windowDays != null && (!Number.isInteger(windowDays) || windowDays < 1)) {
      return res.status(400).json({ error: "window_days must be a positive integer, or null to reset" });
    }

    const updated = await prisma.event.update({
      where: { id: event.id },
      data: { guestUploadWindowDays: windowDays ?? null },
    });
    res.json({ guest_upload_window_days: updated.guestUploadWindowDays });
  } catch (err) {
    next(err);
  }
});

// MERGE (Studio-Verse): the central "one event, two independent feature
// toggles" requirement (see MERGE_PLAN.md D6) — a studio can run Face
// Search and/or Photo Selection on the same event, at the same time.
// Owner or collaborator, matching every other event-settings toggle here.
// Both can be true; both can be false (an event with neither is just a
// plain gallery for now, which is a valid state, not an error).
router.post("/:id/features/toggle", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const { feature, enabled } = req.body || {};
    if (feature !== "faceSearch" && feature !== "photoSelection") {
      return res.status(400).json({ error: 'feature must be "faceSearch" or "photoSelection"' });
    }

    const data = feature === "faceSearch" ? { faceSearchEnabled: !!enabled } : { photoSelectionEnabled: !!enabled };
    const updated = await prisma.event.update({ where: { id: event.id }, data });
    res.json({
      face_search_enabled: updated.faceSearchEnabled,
      photo_selection_enabled: updated.photoSelectionEnabled,
    });
  } catch (err) {
    next(err);
  }
});

// MERGE (Studio-Verse EventDetail depth, Phase 18E): edit the event's own
// display metadata — name plus the optional date/venue/description that
// Studio-Verse events carry. Owner or collaborator. Null clears an
// optional field; name (when given) must stay non-blank.
router.patch("/:id", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const { name, event_date: eventDate, event_venue: eventVenue, description } = req.body || {};
    const {
      require_face_search_consent: requireConsent,
      privacy_notice_text: privacyNotice,
      selfie_retention_mode: selfieRetention,
      guest_data_retention_days: retentionDays,
      allow_guest_data_delete_request: allowDeleteRequest,
      access_mode: accessMode,
      access_key: accessKey,
      expires_at: expiresAt,
      expiry_preset: expiryPreset,
      tv_mode: tvMode,
      tv_transition_ms: tvTransitionMs,
      tv_show_qr: tvShowQr,
      sponsor_name: sponsorName,
    } = req.body || {};
    const data = {};
    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) {
        return res.status(400).json({ error: "name must be a non-empty string" });
      }
      data.name = name.trim();
    }
    if (eventDate !== undefined) {
      if (eventDate === null || eventDate === "") {
        data.eventDate = null;
      } else {
        const d = new Date(eventDate);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({ error: "event_date must be a valid date, or null to clear" });
        }
        data.eventDate = d;
      }
    }
    if (eventVenue !== undefined) {
      if (eventVenue !== null && typeof eventVenue !== "string") {
        return res.status(400).json({ error: "event_venue must be a string, or null to clear" });
      }
      data.eventVenue = eventVenue?.trim() ? eventVenue.trim() : null;
    }
    if (description !== undefined) {
      if (description !== null && typeof description !== "string") {
        return res.status(400).json({ error: "description must be a string, or null to clear" });
      }
      data.description = description?.trim() ? description.trim() : null;
    }
    // Phase 2 (consent-first Face Search): privacy settings live on the
    // same studio PATCH as the display metadata — owner or collaborator.
    if (requireConsent !== undefined) {
      if (typeof requireConsent !== "boolean") {
        return res.status(400).json({ error: "require_face_search_consent must be a boolean" });
      }
      data.requireFaceSearchConsent = requireConsent;
    }
    if (privacyNotice !== undefined) {
      if (privacyNotice !== null && typeof privacyNotice !== "string") {
        return res.status(400).json({ error: "privacy_notice_text must be a string, or null to clear" });
      }
      if (privacyNotice && privacyNotice.length > 2000) {
        return res.status(400).json({ error: "privacy_notice_text is limited to 2000 characters" });
      }
      data.privacyNoticeText = privacyNotice?.trim() ? privacyNotice.trim() : null;
    }
    if (selfieRetention !== undefined) {
      if (selfieRetention !== "process_only" && selfieRetention !== "retain") {
        return res.status(400).json({ error: 'selfie_retention_mode must be "process_only" or "retain"' });
      }
      data.selfieRetentionMode = selfieRetention;
    }
    if (retentionDays !== undefined) {
      if (retentionDays !== null && (!Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > 3650)) {
        return res.status(400).json({ error: "guest_data_retention_days must be an integer 0-3650, or null to clear" });
      }
      data.guestDataRetentionDays = retentionDays;
    }
    if (allowDeleteRequest !== undefined) {
      if (typeof allowDeleteRequest !== "boolean") {
        return res.status(400).json({ error: "allow_guest_data_delete_request must be a boolean" });
      }
      data.allowGuestDataDeleteRequest = allowDeleteRequest;
    }
    // Phase 3 (gallery access upgrade): mode + key + expiry presets on
    // the same studio PATCH — owner or collaborator.
    if (accessMode !== undefined) {
      if (!ACCESS_MODES.includes(accessMode)) {
        return res.status(400).json({ error: `access_mode must be one of ${ACCESS_MODES.join(", ")}` });
      }
      data.accessMode = accessMode;
    }
    if (expiryPreset !== undefined) {
      if (!["7_days", "30_days", "90_days", "custom"].includes(expiryPreset)) {
        return res.status(400).json({ error: 'expiry_preset must be "7_days", "30_days", "90_days" or "custom"' });
      }
      data.expiryPreset = expiryPreset;
    }
    if (expiresAt !== undefined) {
      const d = new Date(expiresAt);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({ error: "expires_at must be a valid date" });
      }
      data.expiresAt = d;
    }
    // Phase 8 (live TV wall): on-air settings on the same studio PATCH.
    if (tvMode !== undefined) {
      if (tvMode !== "all" && tvMode !== "highlights") {
        return res.status(400).json({ error: 'tv_mode must be "all" or "highlights"' });
      }
      data.tvMode = tvMode;
    }
    if (tvTransitionMs !== undefined) {
      if (!Number.isInteger(tvTransitionMs) || tvTransitionMs < 2000 || tvTransitionMs > 30000) {
        return res.status(400).json({ error: "tv_transition_ms must be an integer 2000-30000" });
      }
      data.tvTransitionMs = tvTransitionMs;
    }
    if (tvShowQr !== undefined) {
      if (typeof tvShowQr !== "boolean") {
        return res.status(400).json({ error: "tv_show_qr must be a boolean" });
      }
      data.tvShowQr = tvShowQr;
    }
    if (sponsorName !== undefined) {
      if (sponsorName !== null && typeof sponsorName !== "string") {
        return res.status(400).json({ error: "sponsor_name must be a string, or null to clear" });
      }
      if (sponsorName && sponsorName.length > 120) {
        return res.status(400).json({ error: "sponsor_name is limited to 120 characters" });
      }
      data.sponsorName = sponsorName?.trim() ? sponsorName.trim() : null;
    }

    // Private key lifecycle: a plaintext access_key sets a fresh bcrypt
    // hash, null/"" clears it (back to a keyless gallery). Locking an
    // event without any key — new or stored — is rejected.
    let keyHash = event.accessKeyHash;
    if (accessKey !== undefined) {
      if (accessKey === null || accessKey === "") {
        await prisma.event.update({ where: { id: event.id }, data: { accessKeyHash: null } });
        keyHash = null;
      } else {
        try {
          await setAccessKey(event.id, accessKey);
          keyHash = true;
        } catch (err) {
          return res.status(err.status || 400).json({ error: err.message });
        }
      }
    }
    const finalMode = data.accessMode ?? event.accessMode ?? "public";
    if (finalMode === "private_key" && !keyHash) {
      return res.status(400).json({ error: "Set an access key before switching to private-key mode." });
    }

    const updated = await prisma.event.update({ where: { id: event.id }, data });
    res.json({
      id: updated.id,
      name: updated.name,
      event_date: updated.eventDate,
      event_venue: updated.eventVenue,
      description: updated.description,
      require_face_search_consent: updated.requireFaceSearchConsent,
      privacy_notice_text: updated.privacyNoticeText,
      selfie_retention_mode: updated.selfieRetentionMode,
      guest_data_retention_days: updated.guestDataRetentionDays,
      allow_guest_data_delete_request: updated.allowGuestDataDeleteRequest,
      access_mode: updated.accessMode,
      access_key_set: !!updated.accessKeyHash,
      expires_at: updated.expiresAt,
      expiry_preset: updated.expiryPreset,
      tv_mode: updated.tvMode,
      tv_transition_ms: updated.tvTransitionMs,
      tv_show_qr: updated.tvShowQr,
      sponsor_name: updated.sponsorName,
      sponsor_logo_url: updated.sponsorLogoPath ? `/files/events/${event.id}/sponsor-logo` : null,
    });
  } catch (err) {
    next(err);
  }
});

// MERGE (Studio-Verse): publish stamps publishedAt — the studio declaring
// uploads finished. One-way (no unpublish), exactly like Studio-Verse:
// for a Photo Selection event this is the "gallery is ready" marker the
// client UI reflects. Owner or collaborator.
router.post("/:id/publish", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const updated = await prisma.event.update({
      where: { id: event.id },
      data: { publishedAt: event.publishedAt ?? new Date() },
    });
    res.json({ published_at: updated.publishedAt });
  } catch (err) {
    next(err);
  }
});

// MERGE (Studio-Verse archive/restore, Phase 18E): soft archive hides the
// event from guests (lib/expiry.js) and Photo Selection clients
// (routes/client.js) without deleting anything; restore reverses it.
// Permanent deletion stays the separate owner-only DELETE /:id.
router.post("/:id/archive", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const updated = await prisma.event.update({
      where: { id: event.id },
      data: { archivedAt: event.archivedAt ?? new Date() },
    });
    res.json({ archived_at: updated.archivedAt });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/restore", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const updated = await prisma.event.update({
      where: { id: event.id },
      data: { archivedAt: null },
    });
    res.json({ archived_at: updated.archivedAt });
  } catch (err) {
    next(err);
  }
});

// MERGE (Studio-Verse): per-event download opt-out — when false, guests
// (routes/guest.js) can't download zips and clients see a view-only
// gallery; the studio's own download below always works. Owner or
// collaborator, like every other event-settings toggle here.
router.post("/:id/allow-download", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const { allow_download: allowDownload } = req.body || {};
    if (typeof allowDownload !== "boolean") {
      return res.status(400).json({ error: "allow_download must be a boolean" });
    }

    const updated = await prisma.event.update({ where: { id: event.id }, data: { allowDownload } });
    res.json({ allow_download: updated.allowDownload });
  } catch (err) {
    next(err);
  }
});

// MERGE (Studio-Verse cover crop, Phase 18E): upload/replace the event's
// cover photo. The 16:9 crop happens client-side (react-easy-crop) before
// upload; the server stores the bytes as-is after the same
// extension + content-sniff validation logos go through. One cover per
// event — replacing deletes the old file. Served at
// GET /files/events/:eventId/cover (UUID trust model, like all of files.js).
router.post("/:id/cover", upload.single("cover"), async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    if (!req.file) {
      return res.status(400).json({ error: "No cover file uploaded (expected multipart field 'cover')" });
    }
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) {
      return res.status(400).json({ error: "Unsupported cover file type" });
    }
    if (!contentMatchesExtension(req.file.buffer, ext)) {
      return res.status(400).json({ error: "File content doesn't match its extension" });
    }

    const coverPath = await saveEventCover(event.id, req.file.originalname, req.file.buffer);
    const updated = await prisma.event.update({ where: { id: event.id }, data: { coverPhotoPath: coverPath } });
    res.json({ cover_url: updated.coverPhotoPath ? `/files/events/${event.id}/cover` : null });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id/cover", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    if (event.coverPhotoPath) {
      await deleteFileIfExists(event.coverPhotoPath);
      await prisma.event.update({ where: { id: event.id }, data: { coverPhotoPath: null } });
    }
    res.json({ cover_url: null });
  } catch (err) {
    next(err);
  }
});

// Phase 8 (live TV wall): sponsor logo overlay upload — same single-file
// pattern as the event cover. Served at GET /files/events/:eventId/sponsor-logo.
router.post("/:id/sponsor-logo", upload.single("logo"), async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    if (!req.file) {
      return res.status(400).json({ error: "No logo file uploaded (expected multipart field 'logo')" });
    }
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) {
      return res.status(400).json({ error: "Unsupported logo file type" });
    }
    if (!contentMatchesExtension(req.file.buffer, ext)) {
      return res.status(400).json({ error: "File content doesn't match its extension" });
    }

    const logoPath = await saveEventSponsorLogo(event.id, req.file.originalname, req.file.buffer);
    await prisma.event.update({ where: { id: event.id }, data: { sponsorLogoPath: logoPath } });
    res.json({ sponsor_logo_url: `/files/events/${event.id}/sponsor-logo` });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id/sponsor-logo", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    if (event.sponsorLogoPath) {
      await deleteFileIfExists(event.sponsorLogoPath);
      await prisma.event.update({ where: { id: event.id }, data: { sponsorLogoPath: null } });
    }
    res.json({ sponsor_logo_url: null });
  } catch (err) {
    next(err);
  }
});

// Phase 8: studio-star a photo for the TV wall's highlights mode.
// Moderation-adjacent but independent — pending photos stay invisible
// everywhere until approved, highlighted or not.
router.patch("/:id/photos/:photoId/highlight", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const { highlighted } = req.body || {};
    if (typeof highlighted !== "boolean") {
      return res.status(400).json({ error: "highlighted must be a boolean" });
    }
    const photo = await prisma.photo.findFirst({
      where: { id: req.params.photoId, eventId: event.id },
    });
    if (!photo) return res.status(404).json({ error: "Photo not found" });
    const updated = await prisma.photo.update({
      where: { id: photo.id },
      data: { highlighted },
    });
    res.json({ photo_id: updated.id, highlighted: updated.highlighted });
  } catch (err) {
    next(err);
  }
});

// MERGE (Studio-Verse studio zip, Phase 18E): the studio's own full-event
// download — every approved photo, regardless of gallery membership.
// Unlike the guest zip (routes/guest.js), this ignores allowDownload (a
// studio can always take its own photos home) and needs no photo_ids.
router.get("/:id/download-zip", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const photos = await prisma.photo.findMany({
      where: { eventId: event.id, approvalStatus: "approved", archivedAt: null },
      orderBy: { createdAt: "asc" },
    });
    if (photos.length === 0) {
      return res.status(404).json({ error: "This event has no approved photos to download" });
    }

    const zipFilename = zipFilenameForEvent(event);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipFilename}"`);

    await streamPhotosZip(photos, res);
  } catch (err) {
    next(err);
  }
});

// The studio's curated picks as one zip — same streaming as the full
// gallery zip above, scoped to StudioFavourite rows (Studio-Verse's
// download-studio-zip, adapted: picks are per acting studio user here).
router.get("/:id/studio-picks/download-zip", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const picks = await prisma.studioFavourite.findMany({
      where: {
        userId: req.user.id,
        photo: { eventId: event.id, approvalStatus: "approved", archivedAt: null },
      },
      include: { photo: true },
      orderBy: { createdAt: "asc" },
    });
    const photos = picks.map((s) => s.photo);
    if (photos.length === 0) {
      return res.status(404).json({ error: "You have no studio picks to download yet" });
    }

    const zipFilename = zipFilenameForEvent(event);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipFilename}"`);

    await streamPhotosZip(photos, res);
  } catch (err) {
    next(err);
  }
});

// MERGE (Studio-Verse large upload, Phase 18H): resumable chunked upload
// for files too big for one multipart POST — the local-disk equivalent of
// Studio-Verse's S3-multipart flow (initiate → parts → complete/abort)
// with its MediaUploadStage tracker. Differences are all storage-layer,
// never behavior: parts accumulate in storage/uploads/parts/ instead of an
// S3 multipart session, and the cap is 500MB (not 5GB) since an assembled
// file is briefly held in memory when it rejoins the regular async upload
// job below — the face-detection/thumbnailing/quota/storage pipeline is
// then byte-for-byte the same as a normal upload, so a large file ends up
// a fully normal Photo row. Clients send 8MB chunks (per-chunk cap 16MB)
// and resume by asking the stage how many bytes already arrived.
const MAX_LARGE_UPLOAD_BYTES = 500 * 1024 * 1024;
const LARGE_CHUNK_BYTES = 8 * 1024 * 1024;
const LARGE_PART_LIMIT = "16mb";

async function loadUploadStage(event, stageId, res) {
  const stage = await prisma.mediaUploadStage.findFirst({
    where: { id: stageId, eventId: event.id },
  });
  if (!stage) {
    res.status(404).json({ error: "Upload session not found" });
    return null;
  }
  return stage;
}

router.post("/:id/uploads/large/initiate", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    if (!event.startedAt) {
      return res.status(400).json({ error: "Start this event before uploading photos." });
    }

    const { filename, file_size: fileSize, content_type: contentType } = req.body || {};
    if (!filename || typeof filename !== "string") {
      return res.status(400).json({ error: "filename is required" });
    }
    const size = Number(fileSize);
    if (!Number.isFinite(size) || size <= 0) {
      return res.status(400).json({ error: "file_size must be a positive number" });
    }
    if (size > MAX_LARGE_UPLOAD_BYTES) {
      return res.status(413).json({ error: "File too large. Maximum allowed is 500MB per file." });
    }
    const ext = path.extname(filename).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return res.status(415).json({ error: "Unsupported file type. Only images are accepted." });
    }

    try {
      await assertQuotaAvailable(event.ownerId);
    } catch (quotaErr) {
      return res.status(quotaErr.statusCode || 403).json({ error: quotaErr.message });
    }

    const stage = await prisma.mediaUploadStage.create({
      data: {
        eventId: event.id,
        filename,
        mimeType: typeof contentType === "string" && contentType ? contentType : "application/octet-stream",
        totalBytes: Math.floor(size),
        status: "Uploading",
      },
    });
    res.status(201).json({
      stage_id: stage.id,
      received_bytes: 0,
      chunk_bytes: LARGE_CHUNK_BYTES,
    });
  } catch (err) {
    next(err);
  }
});

router.put(
  "/:id/uploads/large/part",
  raw({ type: "application/octet-stream", limit: LARGE_PART_LIMIT }),
  async (req, res, next) => {
    try {
      const accessible = await loadAccessibleEvent(req, res);
      if (!accessible) return;
      const { event } = accessible;

      const { stage_id: stageId, offset } = req.query || {};
      const stage = await loadUploadStage(event, stageId, res);
      if (!stage) return;
      if (stage.status !== "Uploading") {
        return res.status(409).json({ error: `This upload session is ${stage.status.toLowerCase()}` });
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: "Missing chunk body." });
      }
      const at = Number(offset);
      if (!Number.isInteger(at) || at < 0) {
        return res.status(400).json({ error: "offset must be a non-negative integer" });
      }
      if (at + req.body.length > stage.totalBytes) {
        return res.status(400).json({ error: "Chunk overruns the declared file size." });
      }

      try {
        const received = await appendUploadPart(stage.id, at, req.body);
        await prisma.mediaUploadStage.update({
          where: { id: stage.id },
          data: { receivedBytes: received },
        });
        res.json({ received_bytes: received, total_bytes: stage.totalBytes });
      } catch (partErr) {
        if (partErr.status) return res.status(partErr.status).json({ error: partErr.message });
        throw partErr;
      }
    } catch (err) {
      next(err);
    }
  }
);

router.get("/:id/uploads/large/:stageId", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const stage = await loadUploadStage(event, req.params.stageId, res);
    if (!stage) return;
    const onDisk = await uploadPartSize(stage.id);
    res.json({
      stage_id: stage.id,
      filename: stage.filename,
      total_bytes: stage.totalBytes,
      received_bytes: Math.max(stage.receivedBytes, onDisk),
      status: stage.status,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/uploads/large/complete", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const { stage_id: stageId } = req.body || {};
    const stage = await loadUploadStage(event, stageId, res);
    if (!stage) return;
    if (stage.status !== "Uploading") {
      return res.status(409).json({ error: `This upload session is ${stage.status.toLowerCase()}` });
    }

    const onDisk = await uploadPartSize(stage.id);
    if (onDisk !== stage.totalBytes) {
      return res.status(400).json({
        error: `Upload incomplete: received ${onDisk} of ${stage.totalBytes} bytes.`,
      });
    }

    const buffer = await fsp.readFile(uploadPartPath(stage.id));
    if (!contentMatchesExtension(buffer, path.extname(stage.filename).toLowerCase())) {
      return res.status(415).json({ error: "File content doesn't match its extension" });
    }

    await prisma.mediaUploadStage.update({ where: { id: stage.id }, data: { status: "Completed" } });
    await deleteUploadPart(stage.id);

    const { id: jobId } = createJob();
    res.status(202).json({ job_id: jobId });

    processUploadJob(jobId, event, [{ originalname: stage.filename, buffer }]).catch((err) => {
      console.error(`Unhandled error in large-upload job ${jobId}:`, err);
    });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/uploads/large/abort", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const { stage_id: stageId } = req.body || {};
    const stage = await loadUploadStage(event, stageId, res);
    if (!stage) return;

    await deleteUploadPart(stage.id);
    await prisma.mediaUploadStage.update({ where: { id: stage.id }, data: { status: "Aborted" } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Owner-only — deleting the whole event (guest link, every photo, every
// collaborator) is a much bigger action than removing one bad photo.
// Deletes in FK dependency order (children before the Event row itself),
// then removes the event's entire photo/thumbnail directory from disk in
// one shot, plus any pre-built zip files from the email-download flow.
router.delete("/:id", async (req, res, next) => {
  try {
    const event = await loadOwnedEvent(req, res);
    if (!event) return;

    await deleteEventCascade(event);

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Processes uploaded files sequentially against face-engine (a single
// process — calls to it must not be parallelized), emitting a `progress`
// SSE event after each file and a terminal `done`/`error` event at the end.
// Fire-and-forget from the route handler; errors are caught here so they
// can't become an unhandled rejection that crashes the process.
async function processUploadJob(jobId, event, files) {
  const total = files.length;
  const skipped = [];
  let completed = 0;
  let facesFoundSoFar = 0;
  const startedAt = Date.now();
  let usedBytes = await eventStorageUsedBytes(prisma, event.id);
  const owner = await prisma.user.findUnique({ where: { id: event.ownerId } });
  const storageLimitBytes = effectiveStorageLimitBytes(owner);
  let subscription = null;
  const newPhotoIds = [];

  try {
    subscription = await assertQuotaAvailable(event.ownerId);
    for (const file of files) {
      const ext = path.extname(file.originalname).toLowerCase();
      let addedPhoto = null;

      if (!ALLOWED_EXTENSIONS.has(ext)) {
        skipped.push(`${file.originalname} (unsupported file type)`);
      } else if (!contentMatchesExtension(file.buffer, ext)) {
        skipped.push(`${file.originalname} (file content doesn't match its extension)`);
      } else if (subscription && subscription.photoQuotaUsed + newPhotoIds.length >= subscription.photoQuotaTotal) {
        skipped.push(`${file.originalname} (photo quota reached)`);
      } else if (usedBytes + file.buffer.length > storageLimitBytes) {
        skipped.push(`${file.originalname} (event storage limit reached)`);
      } else if (isVideoExtension(ext)) {
        // Video branch (Phase 20): stored, thumbnailed-by-fallback, and
        // delivered exactly like a photo, but never face-indexed — there
        // are no Face rows to match, so selfie search simply never returns
        // it, while client galleries, favourites, zips, and counts treat
        // it as a normal gallery item. faceSearchVisible stays false so
        // guest-facing face-search surfaces (gallery/slideshow/downloads)
        // exclude it by their existing filters.
        const photoId = randomUUID();
        const storedFilename = `${photoId}${ext}`;
        const storagePath = await getStorageProvider().writeOriginal(event.id, storedFilename, file.buffer);

        const photo = await prisma.photo.create({
          data: {
            id: photoId,
            eventId: event.id,
            filename: file.originalname,
            storagePath,
            thumbnailPath: null,
            faceCount: 0,
            fileSize: file.buffer.length,
            source: "upload",
            faceSearchVisible: false,
            originalExpiresAt: new Date(Date.now() + effectivePhotoRetentionDays(owner) * 24 * 60 * 60 * 1000),
          },
        });

        usedBytes += file.buffer.length;
        newPhotoIds.push(photo.id);
        await consumeQuota(event.ownerId);
        addedPhoto = {
          photo_id: photo.id,
          filename: photo.filename,
          face_count: 0,
          createdAt: photo.createdAt,
          url: `/files/events/${event.id}/photos/${photo.id}`,
          thumbnail_url: `/files/events/${event.id}/photos/${photo.id}/thumb`,
          source: photo.source,
        };
        publishLiveEvent(event.id, { type: "photo_added", ...addedPhoto });
      } else {
        let faces = [];
        try {
          if (event.faceSearchEnabled) {
            faces = await detectFacesForPhoto(file.buffer, file.originalname);
          }
        } catch (err) {
          skipped.push(`${file.originalname} (${err.isFaceEngineError ? err.message : "could not process image"})`);
          faces = null;
        }

        if (faces) {
          const photoId = randomUUID();
          const storedFilename = `${photoId}${ext}`;
          const storagePath = await getStorageProvider().writeOriginal(event.id, storedFilename, file.buffer);
          const thumbnailPath = await generateThumbnail(file.buffer, event.id, photoId);

          const photo = await prisma.photo.create({
            data: {
              id: photoId,
              eventId: event.id,
              filename: file.originalname,
              storagePath,
              thumbnailPath,
              faceCount: faces.length,
              fileSize: file.buffer.length,
              source: "upload",
              faceSearchVisible: event.faceSearchEnabled,
              originalExpiresAt: new Date(Date.now() + effectivePhotoRetentionDays(owner) * 24 * 60 * 60 * 1000),
            },
          });

          if (event.faceSearchEnabled) {
            await replacePhotoFaces({ photoId: photo.id, eventId: event.id, faces });
            await consumeAiPhotoCredits(event.ownerId);
          }

          facesFoundSoFar += faces.length;
          usedBytes += file.buffer.length;
          newPhotoIds.push(photo.id);
          await consumeQuota(event.ownerId);
          addedPhoto = {
            photo_id: photo.id,
            filename: photo.filename,
            face_count: photo.faceCount,
            createdAt: photo.createdAt,
            url: `/files/events/${event.id}/photos/${photo.id}`,
            thumbnail_url: `/files/events/${event.id}/photos/${photo.id}/thumb`,
            source: photo.source,
          };
          // So the public slideshow (guest.js's /:slug/live/stream) reflects
          // every source landing during a live event, not just Shoots.
          publishLiveEvent(event.id, { type: "photo_added", ...addedPhoto });
        }
      }

      completed += 1;

      const elapsedSeconds = (Date.now() - startedAt) / 1000;
      const photosPerSecond = elapsedSeconds > 0 ? completed / elapsedSeconds : 0;
      const etaSeconds =
        photosPerSecond > 0 ? Math.round((total - completed) / photosPerSecond) : null;

      emitJobEvent(jobId, {
        type: "progress",
        job_id: jobId,
        total,
        completed,
        current_file: file.originalname,
        photos_per_second: Math.round(photosPerSecond * 100) / 100,
        eta_seconds: etaSeconds,
        faces_found_so_far: facesFoundSoFar,
        skipped_so_far: skipped,
        photo: addedPhoto,
      });
    }

    checkAndNotifyForNewPhotos(event, newPhotoIds).catch((err) =>
      console.error(`Guest alert check failed for upload job ${jobId}:`, err)
    );

    emitJobEvent(jobId, {
      type: "done",
      job_id: jobId,
      photos_processed: total - skipped.length,
      faces_found: facesFoundSoFar,
      skipped,
    });
  } catch (err) {
    console.error(`Upload job ${jobId} failed:`, err);
    emitJobEvent(jobId, {
      type: "error",
      job_id: jobId,
      message: err.message || "Unknown error while processing uploads",
    });
  }
}

router.post("/:id/photos", uploadLimiter, upload.array("files"), async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    if (!event.startedAt) {
      return res.status(400).json({ error: "Start this event before uploading photos." });
    }

    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({ error: "No files uploaded (expected multipart field 'files')" });
    }

    const { id: jobId } = createJob();
    res.status(202).json({ job_id: jobId });

    processUploadJob(jobId, event, files).catch((err) => {
      console.error(`Unhandled error in upload job ${jobId}:`, err);
    });
  } catch (err) {
    next(err);
  }
});

// Server-Sent Events stream of progress for one upload job. Auth + owner-or-
// collaborator scoping same as other event routes — a job's id isn't secret,
// but only someone with access to the event should be able to watch its
// progress.
router.get("/:id/uploads/:jobId/stream", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;

    const job = getJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: "Upload job not found" });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    // If the job already finished before the client connected, just send
    // the last event and close so the client isn't stuck waiting forever.
    if (job.state.done) {
      res.write(`data: ${JSON.stringify(job.state.lastEvent)}\n\n`);
      return res.end();
    }

    const onEvent = (jobEvent) => {
      res.write(`data: ${JSON.stringify(jobEvent)}\n\n`);
      if (jobEvent.type === "done" || jobEvent.type === "error") {
        cleanup();
        res.end();
      }
    };

    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, 15000);

    function cleanup() {
      clearInterval(heartbeat);
      job.emitter.off("event", onEvent);
    }

    job.emitter.on("event", onEvent);
    req.on("close", cleanup);
  } catch (err) {
    next(err);
  }
});

// Owner or collaborator — same access model as direct photo upload. Lists
// the folder up front and fails fast (400) on a bad link/unconfigured key/
// inaccessible folder before ever creating a job. Requires `confirm: true`
// in the body — connecting scans and imports every photo currently in the
// folder, so the frontend shows a warning modal before ever sending this,
// and the server enforces that same confirmation independently. Once
// listing succeeds, the folder is saved on the event (auto-sync on by
// default) and the actual downloads+face-detection happen in a background
// job, mirroring POST /:id/photos.
// Read-only pre-check for the "Connect folder" form — resolves the pasted
// link to a folder, confirms it's actually reachable, and reports the
// "anyone with the link" access level so the photographer can catch a
// wrong link or an over/under-shared folder before committing to a full
// import. Doesn't require the event to be started (nothing is ingested).
router.post("/:id/drive/test-connection", driveImportLimiter, async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;

    const { folder_url } = req.body || {};
    let folderId;
    try {
      folderId = extractFolderId(folder_url);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    try {
      const { folderName, role } = await testFolderAccess(folderId);
      res.json({ accessible: true, folder_name: folderName, permission: role });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  } catch (err) {
    next(err);
  }
});

router.post("/:id/drive/connect", driveImportLimiter, async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    if (!event.startedAt) {
      return res.status(400).json({ error: "Start this event before importing photos." });
    }

    const { folder_url, confirm } = req.body || {};
    if (!confirm) {
      return res.status(400).json({ error: "Connecting a Drive folder requires confirming the import first." });
    }

    let folderId;
    try {
      folderId = extractFolderId(folder_url);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    let files;
    try {
      files = await listImageFiles(folderId);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    await prisma.event.update({
      where: { id: event.id },
      data: { driveFolderId: folderId, driveFolderUrl: folder_url, driveSyncEnabled: true },
    });

    const { id: jobId } = createJob();
    res.status(202).json({ job_id: jobId, files_found: files.length });

    processDriveImportJob(jobId, event, files).catch((err) => {
      console.error(`Unhandled error in drive connect job ${jobId}:`, err);
    });
  } catch (err) {
    next(err);
  }
});

// Manual "Sync now" — requires an already-connected folder. Diffs the
// folder's current contents against what's already imported: new files get
// downloaded and processed, and photos whose Drive file was deleted get
// removed. Streams progress over the same SSE route as upload/connect. This
// is the same sync logic the daily scheduler runs automatically — see
// lib/driveSync.js's runDueAutoSyncs.
router.post("/:id/drive/sync", driveImportLimiter, async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    if (!event.startedAt) {
      return res.status(400).json({ error: "Start this event before syncing photos." });
    }
    if (!event.driveFolderId) {
      return res.status(400).json({ error: "No Google Drive folder is connected for this event yet." });
    }

    let files;
    try {
      files = await listImageFiles(event.driveFolderId);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const { id: jobId } = createJob();
    res.status(202).json({ job_id: jobId });

    processDriveSyncJob(jobId, event, files).catch((err) => {
      console.error(`Unhandled error in drive sync job ${jobId}:`, err);
    });
  } catch (err) {
    next(err);
  }
});

// Toggles the daily automatic sync on/off for an already-connected folder.
// The folder stays connected either way — this only controls whether
// lib/driveSync.js's daily scheduler includes this event; the manual "Sync
// now" button above always works regardless of this flag.
router.post("/:id/drive/auto-sync", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    if (!event.driveFolderId) {
      return res.status(400).json({ error: "No Google Drive folder is connected for this event yet." });
    }

    const { enabled } = req.body || {};
    await prisma.event.update({ where: { id: event.id }, data: { driveSyncEnabled: !!enabled } });
    res.json({ drive_sync_enabled: !!enabled });
  } catch (err) {
    next(err);
  }
});

const SHOOTS_HOST = process.env.FTP_PUBLIC_HOST || "your-server-address";
const SHOOTS_PORT = process.env.FTP_PORT || 2121;

function shootsCredentialsResponse(event) {
  return {
    ftp_host: SHOOTS_HOST,
    ftp_port: Number(SHOOTS_PORT),
    ftp_username: event.ftpUsername,
    ftp_password: event.ftpPassword,
  };
}

// Owner or collaborator — same access model as photo upload. Returns the
// event's current Shoots (camera-to-cloud FTP) credentials if already set up,
// or `{ connected: false }` otherwise. Credentials are stored as plaintext
// (see schema.prisma's Event.ftpPassword note) precisely so they can be
// read back here whenever the photographer needs to re-enter them into a
// camera, without a one-time-reveal dance.
router.get("/:id/shoots/credentials", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    if (!event.ftpUsername) {
      return res.json({ connected: false });
    }
    res.json({ connected: true, ...shootsCredentialsResponse(event) });
  } catch (err) {
    next(err);
  }
});

// Generates fresh Shoots credentials (first setup, or "Regenerate" — the old
// username/password stop working immediately since they're simply
// overwritten). A camera's FTP transfer settings would need re-entering
// after a regenerate.
router.post("/:id/shoots/credentials", shootsCredentialLimiter, async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    if (!event.startedAt) {
      return res.status(400).json({ error: "Start this event before setting up camera upload." });
    }

    // The shortened, human-typeable username alphabet (see
    // generateShootsCredentials) makes a unique-constraint collision far
    // less astronomically unlikely than a long hex string — still rare,
    // but worth a few retries instead of surfacing a 500 to the owner.
    let updated;
    for (let attempt = 0; attempt < 5; attempt++) {
      const { username, password } = generateShootsCredentials();
      try {
        updated = await prisma.event.update({
          where: { id: event.id },
          data: { ftpUsername: username, ftpPassword: password },
        });
        break;
      } catch (err) {
        const isUsernameCollision = err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
        if (!isUsernameCollision || attempt === 4) throw err;
      }
    }

    res.json({ connected: true, ...shootsCredentialsResponse(updated) });
  } catch (err) {
    next(err);
  }
});

// Revokes Shoots access entirely — the camera's stored credentials stop
// working immediately. Doesn't touch any photos already ingested.
router.delete("/:id/shoots/credentials", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    await prisma.event.update({
      where: { id: event.id },
      data: { ftpUsername: null, ftpPassword: null },
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Server-Sent Events stream of "a new photo just arrived via Shoots" — lets
// an open event page update its gallery live during a shoot, instead of the
// photographer needing to refresh. Owner-or-collaborator gated like every
// other event route; purely additive (the gallery still loads fine without
// ever opening this stream).
router.get("/:id/live/stream", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

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

// Advanced/beta — toggles mirroring Shoots captures into this event's
// connected Drive folder. Requires both a connected Drive folder
// (driveFolderId) and the owner having connected Drive backup for their
// account (see /auth/google/drive-backup/connect) — 400s with a clear
// reason otherwise rather than silently accepting a flag that can't do
// anything yet.
router.post("/:id/drive-backup/toggle", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    if (!event.driveFolderId) {
      return res.status(400).json({ error: "No Google Drive folder is connected for this event yet." });
    }
    if (!isDriveBackupConfigured()) {
      return res.status(400).json({ error: "Drive backup isn't set up on this PandaSpot instance yet." });
    }
    const owner = await prisma.user.findUnique({ where: { id: event.ownerId } });
    if (!isDriveBackupBetaUser(owner?.email)) {
      return res.status(403).json({ error: "Drive backup is a beta feature — this account isn't on the beta list yet." });
    }

    const { enabled } = req.body || {};
    await prisma.event.update({ where: { id: event.id }, data: { driveBackupEnabled: !!enabled } });
    res.json({ drive_backup_enabled: !!enabled });
  } catch (err) {
    next(err);
  }
});

// Manual "I've made my copies — free up space" — an explicit owner
// confirmation is a stronger signal than a timer, so this reclaims every
// eligible photo in the event right now (pulls the Drive copy back to the
// VPS as a safety net, then deletes it from Drive), regardless of the
// automatic 2-day sweep's age check (see lib/driveBackupRetention.js). The
// photo itself isn't fully purged by this — the normal 7-day-from-capture
// purge still applies afterward, so there's still a window to just
// download it directly from PandaSpot if needed.
router.post("/:id/drive-backup/reclaim-now", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const result = await reclaimEventDriveBackups(event.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Uploads every already-local photo not yet backed up (direct uploads, or
// PandaShoots captures from before backup was turned on) to the connected
// Drive folder — the "catch up" action for photos that predate flipping
// the toggle on. Drive-imported photos (storagePath null — nothing local
// to upload, already in that same Drive folder) are never touched here, so
// there's no risk of re-uploading a duplicate. Same SSE progress shape as
// every other job on this page (see lib/jobQueue.js). Once backed up, each
// photo follows the exact same 2-day-reclaim/7-day-purge clock as a
// PandaShoots-to-Drive capture (lib/driveBackupRetention.js) — the local
// original is NOT deleted immediately, but it is no longer permanent.
router.post("/:id/drive-backup/backup-existing", driveImportLimiter, async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    if (!event.driveFolderId) {
      return res.status(400).json({ error: "No Google Drive folder is connected for this event yet." });
    }
    if (!isDriveBackupConfigured()) {
      return res.status(400).json({ error: "Drive backup isn't set up on this PandaSpot instance yet." });
    }
    const owner = await prisma.user.findUnique({ where: { id: event.ownerId } });
    if (!isDriveBackupBetaUser(owner?.email)) {
      return res.status(403).json({ error: "Drive backup is a beta feature — this account isn't on the beta list yet." });
    }

    const { source } = req.body || {};
    if (source != null && source !== "upload" && source !== "shoots") {
      return res.status(400).json({ error: "source must be 'upload', 'shoots', or omitted for all sources." });
    }

    const photos = await prisma.photo.findMany({
      where: {
        eventId: event.id,
        storagePath: { not: null },
        platformDriveBackup: false,
        ...(source ? { source } : {}),
      },
    });

    const { id: jobId } = createJob();
    res.status(202).json({ job_id: jobId, files_found: photos.length });

    processBackupExistingJob(jobId, event, photos).catch((err) => {
      console.error(`Unhandled error in backup-existing job ${jobId}:`, err);
    });
  } catch (err) {
    next(err);
  }
});

async function processBackupExistingJob(jobId, event, photos) {
  const total = photos.length;
  const skipped = [];
  let completed = 0;
  const startedAt = Date.now();

  try {
    for (const photo of photos) {
      try {
        const buffer = await fsp.readFile(photo.storagePath);
        const ext = path.extname(photo.storagePath).toLowerCase();
        const driveFile = await uploadToDriveFolder({
          folderId: event.driveFolderId,
          filename: photo.filename,
          mimeType: MIME_BY_EXT[ext] || "application/octet-stream",
          buffer,
        });
        await prisma.photo.update({
          where: { id: photo.id },
          data: { driveFileId: driveFile.id, platformDriveBackup: true, driveBackupStartedAt: new Date() },
        });
      } catch (err) {
        skipped.push(`${photo.filename} (${err.message})`);
      }

      completed += 1;
      const elapsedSeconds = (Date.now() - startedAt) / 1000;
      const photosPerSecond = elapsedSeconds > 0 ? completed / elapsedSeconds : 0;
      emitJobEvent(jobId, {
        type: "progress",
        job_id: jobId,
        total,
        completed,
        current_file: photo.filename,
        photos_per_second: Math.round(photosPerSecond * 100) / 100,
        eta_seconds: photosPerSecond > 0 ? Math.round((total - completed) / photosPerSecond) : null,
        faces_found_so_far: 0,
        skipped_so_far: skipped,
      });
    }

    emitJobEvent(jobId, {
      type: "done",
      job_id: jobId,
      photos_processed: total - skipped.length,
      faces_found: 0,
      skipped,
    });
  } catch (err) {
    console.error(`Backup-existing job ${jobId} failed:`, err);
    emitJobEvent(jobId, {
      type: "error",
      job_id: jobId,
      message: err.message || "Unknown error while backing up existing photos",
    });
  }
}

router.get("/:id/photos", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    // Studio sees everything by default through ?status=all, but the
    // gallery defaults to active-only (matching the Dashboard event
    // filter vocabulary) — archived photos stay manageable without
    // cluttering the working view.
    const status = req.query.status ?? "active";
    if (!["active", "archived", "all"].includes(status)) {
      return res.status(400).json({ error: 'status must be "active", "archived", or "all"' });
    }
    const archivedFilter =
      status === "active" ? { archivedAt: null } : status === "archived" ? { archivedAt: { not: null } } : {};

    const photos = await prisma.photo.findMany({
      where: { eventId: event.id, ...archivedFilter },
      orderBy: { createdAt: "desc" },
    });

    res.json(
      photos.map((p) => ({
        photo_id: p.id,
        filename: p.filename,
        face_count: p.faceCount,
        createdAt: p.createdAt,
        url: `/files/events/${event.id}/photos/${p.id}`,
        thumbnail_url: `/files/events/${event.id}/photos/${p.id}/thumb`,
        source: p.source,
        approval_status: p.approvalStatus,
        archived_at: p.archivedAt,
        moderation_flagged: p.moderationFlagged,
        face_search_visible: p.faceSearchVisible,
        photo_selection_visible: p.photoSelectionVisible,
        highlighted: p.highlighted,
        face_indexed_at: p.faceIndexedAt,
      }))
    );
  } catch (err) {
    next(err);
  }
});

// Auto face-groups for one event (Phase 22 Faces sub-tab + group-
// assisted guest search): greedy per-person clusters over the event's
// searchable face embeddings at the event's own search threshold.
// Computed on demand and cached per event (busted by face-count change);
// no schema change, no stored state to go stale.
router.get("/:id/face-groups", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const threshold = getEffectiveThreshold(event);
    const result = await getFaceGroups(event.id, threshold);
    res.json({
      event_id: event.id,
      threshold,
      face_count: result.face_count,
      group_count: result.group_count,
      groups: result.groups,
    });
  } catch (err) {
    next(err);
  }
});

// Face boxes for one photo (Phase 22 viewer + groups): bbox is stored in
// original-image pixels (face-engine runs on the full upload), so the
// frontend converts to percentages against the loaded image's natural
// size. Embeddings are deliberately never exposed. Ordered by detection
// score, best face first.
router.get("/:id/photos/:photoId/faces", async (req, res, next) => {  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const photo = await prisma.photo.findFirst({
      where: { id: req.params.photoId, eventId: event.id },
      select: { id: true },
    });
    if (!photo) {
      return res.status(404).json({ error: "Photo not found" });
    }

    const faces = await prisma.face.findMany({
      where: { photoId: photo.id },
      select: { id: true, bbox: true, detScore: true },
      orderBy: { detScore: "desc" },
    });
    res.json({
      photo_id: photo.id,
      faces: faces.map((f) => ({ id: f.id, bbox: f.bbox, det_score: f.detScore })),
    });
  } catch (err) {
    next(err);
  }
});

// Soft per-photo archive/restore (mirrors the event-level pair): hides the
// photo from guests, clients, zips, and counts without deleting anything.
router.post("/:id/photos/:photoId/archive", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const photo = await prisma.photo.findFirst({
      where: { id: req.params.photoId, eventId: event.id },
    });
    if (!photo) {
      return res.status(404).json({ error: "Photo not found" });
    }

    const updated = await prisma.photo.update({
      where: { id: photo.id },
      data: { archivedAt: photo.archivedAt ?? new Date() },
    });
    res.json({ photo_id: updated.id, archived_at: updated.archivedAt });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/photos/:photoId/restore", async (req, res, next) => {  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const photo = await prisma.photo.findFirst({
      where: { id: req.params.photoId, eventId: event.id },
    });
    if (!photo) {
      return res.status(404).json({ error: "Photo not found" });
    }

    const updated = await prisma.photo.update({
      where: { id: photo.id },
      data: { archivedAt: null },
    });
    res.json({ photo_id: updated.id, archived_at: updated.archivedAt });
  } catch (err) {
    next(err);
  }
});

// Bulk zero-copy membership (Phase 21): set face_search_visible and/or
// photo_selection_visible across an explicit id list or a server-side
// selection ({ source?, status?, approval? }), so "select all" never needs
// to ship hundreds of ids. Still flags-only — files are never duplicated
// or moved. Adding to Face Search enqueues a background face-index job
// for unindexed images (same SSE progress shape as uploads).
router.post("/:id/photos/bulk-features", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const { photo_ids: photoIds, all, face_search_visible: faceSearchVisible, photo_selection_visible: photoSelectionVisible } = req.body || {};
    const data = {};
    if (faceSearchVisible != null) data.faceSearchVisible = !!faceSearchVisible;
    if (photoSelectionVisible != null) data.photoSelectionVisible = !!photoSelectionVisible;
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: "No feature membership change provided." });
    }

    let targets = [];
    const skipped = [];
    if (Array.isArray(photoIds)) {
      if (photoIds.length === 0) {
        return res.status(400).json({ error: "photo_ids is empty — pass ids or an `all` selector." });
      }
      if (photoIds.length > 5000) {
        return res.status(400).json({ error: "photo_ids is limited to 5000 per call — use `all` for more." });
      }
      const rows = await prisma.photo.findMany({
        where: { id: { in: photoIds }, eventId: event.id },
        select: { id: true },
      });
      const found = new Set(rows.map((r) => r.id));
      targets = [...found];
      for (const id of photoIds) {
        if (!found.has(id)) skipped.push(`${id} (not in this event)`);
      }
    } else if (all && typeof all === "object") {
      const status = all.status ?? "all";
      if (!["active", "archived", "all"].includes(status)) {
        return res.status(400).json({ error: 'all.status must be "active", "archived", or "all"' });
      }
      const approval = all.approval ?? "approved";
      if (!["approved", "pending", "all"].includes(approval)) {
        return res.status(400).json({ error: 'all.approval must be "approved", "pending", or "all"' });
      }
      const where = { eventId: event.id };
      if (status === "active") where.archivedAt = null;
      else if (status === "archived") where.archivedAt = { not: null };
      if (approval === "approved") where.approvalStatus = "approved";
      else if (approval === "pending") where.approvalStatus = "pending";
      if (all.source) where.source = all.source;
      const rows = await prisma.photo.findMany({ where, select: { id: true } });
      targets = rows.map((r) => r.id);
    } else {
      return res.status(400).json({ error: "Provide photo_ids[] or an `all` selector." });
    }

    if (targets.length > 0) {
      await prisma.photo.updateMany({ where: { id: { in: targets } }, data });
    }

    // Newly added-to-AI images that were never indexed need faces before
    // selfie search can return them — index in the background so a big
    // "select all" never blocks the response.
    let jobId = null;
    if (data.faceSearchVisible && event.faceSearchEnabled) {
      const candidates = await prisma.photo.findMany({
        where: {
          id: { in: targets },
          approvalStatus: "approved",
          faceSearchVisible: true,
          faceIndexedAt: null,
        },
        select: { id: true, filename: true },
      });
      const imageIds = candidates.filter((c) => !isVideoFilename(c.filename)).map((c) => c.id);
      const skippedVideos = candidates.length - imageIds.length;
      for (let i = 0; i < skippedVideos; i += 1) skipped.push("(video — browsed, never face-indexed)");
      if (imageIds.length > 0) {
        const job = createJob();
        jobId = job.id;
        processMembershipIndexJob(jobId, event, imageIds).catch((err) => {
          console.error(`Unhandled error in membership index job ${jobId}:`, err);
        });
      }
    }

    res.status(202).json({ updated: targets.length, skipped, job_id: jobId });
  } catch (err) {
    next(err);
  }
});

async function processMembershipIndexJob(jobId, event, photoIds) {
  const total = photoIds.length;
  const skipped = [];
  let facesFoundSoFar = 0;
  const startedAt = Date.now();

  try {
    let completed = 0;
    for (const photoId of photoIds) {
      const photo = await prisma.photo.findFirst({ where: { id: photoId, eventId: event.id } });
      if (!photo) {
        skipped.push(`${photoId} (deleted during indexing)`);
      } else {
        try {
          const count = await indexExistingPhotoFaces(photo);
          await consumeAiPhotoCredits(event.ownerId);
          facesFoundSoFar += count;
        } catch (err) {
          skipped.push(`${photo.filename} (${err.isFaceEngineError ? err.message : "could not index"})`);
        }
      }
      completed += 1;
      const elapsedSeconds = (Date.now() - startedAt) / 1000;
      const photosPerSecond = elapsedSeconds > 0 ? completed / elapsedSeconds : 0;
      emitJobEvent(jobId, {
        type: "progress",
        job_id: jobId,
        total,
        completed,
        current_file: photo?.filename,
        photos_per_second: Math.round(photosPerSecond * 100) / 100,
        eta_seconds: photosPerSecond > 0 ? Math.round((total - completed) / photosPerSecond) : null,
        faces_found_so_far: facesFoundSoFar,
        skipped_so_far: skipped,
        photo: null,
      });
    }

    checkAndNotifyForNewPhotos(event, photoIds).catch((err) =>
      console.error(`Guest alert check failed for membership index job ${jobId}:`, err)
    );

    emitJobEvent(jobId, {
      type: "done",
      job_id: jobId,
      photos_processed: total - skipped.length,
      faces_found: facesFoundSoFar,
      skipped,
    });
  } catch (err) {
    console.error(`Membership index job ${jobId} failed:`, err);
    emitJobEvent(jobId, {
      type: "error",
      job_id: jobId,
      message: err.message || "Unknown error while indexing photos",
    });
  }
}

// Zero-copy photo membership for the unified Event. The same stored photo can
// be available to Face Search, Photo Selection, both, or neither; this updates
// only DB flags and never duplicates/moves the underlying file.
router.patch("/:id/photos/:photoId/features", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const photo = await prisma.photo.findFirst({
      where: { id: req.params.photoId, eventId: event.id },
    });
    if (!photo) {
      return res.status(404).json({ error: "Photo not found" });
    }

    const { face_search_visible: faceSearchVisible, photo_selection_visible: photoSelectionVisible } = req.body || {};
    const data = {};
    if (faceSearchVisible != null) data.faceSearchVisible = !!faceSearchVisible;
    if (photoSelectionVisible != null) data.photoSelectionVisible = !!photoSelectionVisible;
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: "No feature membership change provided." });
    }

    let indexedFaceCount = null;
    // Videos are never face-indexed (no frames are extracted anywhere) —
    // the flag change below still applies, it just never matches a search.
    if (data.faceSearchVisible && !photo.faceIndexedAt && !isVideoFilename(photo.filename)) {
      try {
        indexedFaceCount = await indexExistingPhotoFaces(photo);
        await consumeAiPhotoCredits(event.ownerId);
      } catch (err) {
        return res.status(400).json({ error: err.isFaceEngineError ? err.message : err.message || "Could not index this photo for Face Search." });
      }
    }

    const updated = await prisma.photo.update({
      where: { id: photo.id },
      data,
    });

    res.json({
      photo_id: updated.id,
      face_count: indexedFaceCount ?? updated.faceCount,
      face_indexed_at: updated.faceIndexedAt,
      face_search_visible: updated.faceSearchVisible,
      photo_selection_visible: updated.photoSelectionVisible,
    });
  } catch (err) {
    next(err);
  }
});

// Approves a pending guest upload — makes it searchable and pushes it live
// to anyone watching the slideshow, the same as any other photo landing.
// Rejecting one isn't a separate status: the owner just uses the existing
// DELETE route below, since a rejected guest photo was never really "in"
// the gallery to begin with.
router.post("/:id/photos/:photoId/approve", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const photo = await prisma.photo.findFirst({
      where: { id: req.params.photoId, eventId: event.id },
    });
    if (!photo) {
      return res.status(404).json({ error: "Photo not found" });
    }
    if (photo.approvalStatus === "approved") {
      return res.json({ ok: true, already_approved: true });
    }

    try {
      await assertQuotaAvailable(event.ownerId);
    } catch (err) {
      return res.status(403).json({ error: err.message || "Photo quota unavailable" });
    }

    let indexedFaceCount = null;
    if (event.faceSearchEnabled && photo.faceSearchVisible && !photo.faceIndexedAt) {
      try {
        indexedFaceCount = await indexExistingPhotoFaces(photo);
        await consumeAiPhotoCredits(event.ownerId);
      } catch (err) {
        return res.status(400).json({ error: err.isFaceEngineError ? err.message : err.message || "Could not index this photo for Face Search." });
      }
    }

    const updated = await prisma.photo.update({
      where: { id: photo.id },
      data: { approvalStatus: "approved" },
    });
    await consumeQuota(event.ownerId);

    publishLiveEvent(event.id, {
      type: "photo_added",
      photo_id: updated.id,
      filename: updated.filename,
      face_count: indexedFaceCount ?? updated.faceCount,
      createdAt: updated.createdAt,
      url: `/files/events/${event.id}/photos/${updated.id}`,
      thumbnail_url: `/files/events/${event.id}/photos/${updated.id}/thumb`,
    });
    checkAndNotifyForNewPhotos(event, [updated.id]).catch((err) =>
      console.error(`Guest alert check failed for approved guest upload ${updated.id}:`, err)
    );

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Owner or collaborator — deletes one comment, e.g. for moderation. No
// "hide" state — a deleted comment is just gone, same philosophy as photo
// deletion elsewhere on this page.
router.delete("/:id/photos/:photoId/comments/:commentId", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const comment = await prisma.photoComment.findFirst({
      where: { id: req.params.commentId, photoId: req.params.photoId, eventId: event.id },
    });
    if (!comment) {
      return res.status(404).json({ error: "Comment not found" });
    }

    await prisma.photoComment.delete({ where: { id: comment.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Owner or collaborator — mirrors upload permissions, since removing a bad
// shot is a natural part of managing an event's photos.
router.delete("/:id/photos/:photoId", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const photo = await prisma.photo.findFirst({
      where: { id: req.params.photoId, eventId: event.id },
    });
    if (!photo) {
      return res.status(404).json({ error: "Photo not found" });
    }

    // Face rows have a real FK to Photo (RESTRICT) — must go first.
    await prisma.face.deleteMany({ where: { photoId: photo.id } });
    await prisma.photo.delete({ where: { id: photo.id } });

    await getStorageProvider().deleteOriginal(photo.storagePath);
    await deleteFileIfExists(photo.thumbnailPath);

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.get("/:id/analytics", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const totalSearches = await prisma.guestSearch.count({ where: { eventId: event.id } });

    const uniqueGuestsRows = await prisma.guestSearch.findMany({
      where: { eventId: event.id, guestClientId: { not: null } },
      distinct: ["guestClientId"],
      select: { guestClientId: true },
    });
    const uniqueGuests = uniqueGuestsRows.length;

    const matchedSearches = await prisma.guestSearch.count({
      where: { eventId: event.id, matchCount: { gt: 0 } },
    });
    const matchRate = totalSearches > 0 ? matchedSearches / totalSearches : 0;

    const feedbackCount = await prisma.matchFeedback.count({
      where: { search: { eventId: event.id } },
    });

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const recentSearches = await prisma.guestSearch.findMany({
      where: { eventId: event.id, createdAt: { gte: thirtyDaysAgo } },
      select: { createdAt: true, matchCount: true },
    });
    const dailySearches = bucketByDay(recentSearches.map((s) => s.createdAt));
    const dailyMatches = bucketByDay(
      recentSearches.filter((s) => s.matchCount > 0).map((s) => s.createdAt)
    );

    res.json({
      total_searches: totalSearches,
      unique_guests: uniqueGuests,
      match_rate: matchRate,
      feedback_count: feedbackCount,
      daily_searches: dailySearches,
      daily_matches: dailyMatches,
    });
  } catch (err) {
    next(err);
  }
});

// --- Collaborator management (owner-only — collaborators must not be able
// to manage other collaborators, so these use loadOwnedEvent, not
// loadAccessibleEvent). ---

router.post("/:id/collaborators", async (req, res, next) => {
  try {
    const event = await loadOwnedEvent(req, res);
    if (!event) return;

    const { email } = req.body || {};
    if (!email || typeof email !== "string" || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: "A valid email address is required" });
    }
    const normalizedEmail = email.toLowerCase();

    const owner = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (owner && owner.email.toLowerCase() === normalizedEmail) {
      return res.status(400).json({ error: "You can't invite yourself" });
    }

    const existingUser = await prisma.user.findUnique({ where: { email: normalizedEmail } });

    if (existingUser) {
      await prisma.eventCollaborator.upsert({
        where: { eventId_userId: { eventId: event.id, userId: existingUser.id } },
        create: { eventId: event.id, userId: existingUser.id },
        update: {},
      });
      return res.json({ status: "added", email: normalizedEmail });
    }

    // No account yet — reuse an existing not-yet-accepted invite for this
    // event+email if there is one, instead of creating a duplicate row.
    let invite = await prisma.eventInvite.findFirst({
      where: {
        eventId: event.id,
        acceptedAt: null,
        email: { equals: normalizedEmail, mode: "insensitive" },
      },
    });

    if (!invite) {
      const token = randomBytes(24).toString("base64url");
      invite = await prisma.eventInvite.create({
        data: { eventId: event.id, email: normalizedEmail, token },
      });
    }

    const inviteUrl = `${PUBLIC_WEB_URL}/invites/${invite.token}`;
    await sendCollaboratorInviteEmail(normalizedEmail, event.name, inviteUrl);

    res.json({ status: "invited", email: normalizedEmail });
  } catch (err) {
    next(err);
  }
});

router.get("/:id/collaborators", async (req, res, next) => {
  try {
    const event = await loadOwnedEvent(req, res);
    if (!event) return;

    const collabRows = await prisma.eventCollaborator.findMany({
      where: { eventId: event.id },
      include: { user: true },
    });
    const pendingInviteRows = await prisma.eventInvite.findMany({
      where: { eventId: event.id, acceptedAt: null },
    });

    res.json({
      collaborators: collabRows.map((c) => ({
        user_id: c.user.id,
        email: c.user.email,
        name: c.user.name,
      })),
      pending_invites: pendingInviteRows.map((i) => ({
        invite_id: i.id,
        email: i.email,
        invited_at: i.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id/collaborators/:userId", async (req, res, next) => {
  try {
    const event = await loadOwnedEvent(req, res);
    if (!event) return;

    const collab = await prisma.eventCollaborator.findUnique({
      where: { eventId_userId: { eventId: event.id, userId: req.params.userId } },
    });
    if (!collab) {
      return res.status(404).json({ error: "Collaborator not found" });
    }

    await prisma.eventCollaborator.delete({ where: { id: collab.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.delete("/:id/invites/:inviteId", async (req, res, next) => {
  try {
    const event = await loadOwnedEvent(req, res);
    if (!event) return;

    const invite = await prisma.eventInvite.findUnique({ where: { id: req.params.inviteId } });
    if (!invite || invite.eventId !== event.id || invite.acceptedAt) {
      return res.status(404).json({ error: "Invite not found" });
    }

    await prisma.eventInvite.delete({ where: { id: invite.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// --- Photo Selection client management (MERGE: Studio-Verse) — owner or
// collaborator (matching everything else on this event), unlike
// collaborator management above which is owner-only. Inviting a client is
// a routine per-event task any second shooter should be able to do, not a
// sensitive access-control action like adding another collaborator. ---

const GENERATED_PASSWORD_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

function generateTempPassword() {
  let out = "";
  for (let i = 0; i < 12; i += 1) {
    out += GENERATED_PASSWORD_CHARS[Math.floor(Math.random() * GENERATED_PASSWORD_CHARS.length)];
  }
  return out;
}

// MERGE (Studio-Verse QuickAdd, Phase 19): provision a client account
// directly — for studios onboarding clients without an email round trip
// (in-person, on paper). Unlike /clients/invite (which emails a link the
// client redeems), this creates the USER row + grant immediately and
// returns a one-time password for the studio to relay. Mirrors the admin
// create-studio flow: generated passwords are shown once, and
// studio-provisioned accounts start email-verified.
router.post("/:id/clients/create", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const { email, name, password, favourite_cap: favouriteCap } = req.body || {};
    if (!email || typeof email !== "string" || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: "A valid email address is required" });
    }
    if (favouriteCap != null && (!Number.isInteger(favouriteCap) || favouriteCap < 1)) {
      return res.status(400).json({ error: "favourite_cap must be a positive integer, or omitted for no cap" });
    }
    if (password != null && (typeof password !== "string" || password.length < 8)) {
      return res.status(400).json({ error: "password must be at least 8 characters" });
    }
    const normalizedEmail = email.toLowerCase();

    const existingUser = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existingUser) {
      if (existingUser.role !== "USER") {
        return res.status(409).json({ error: "This email already has a different kind of PandaSpot account" });
      }
      await prisma.eventUserMapping.upsert({
        where: { eventId_userId: { eventId: event.id, userId: existingUser.id } },
        create: { eventId: event.id, userId: existingUser.id, favouriteCap: favouriteCap ?? null },
        update: {},
      });
      return res.json({ status: "added", email: normalizedEmail, generated_password: null });
    }

    const generated = !password;
    const plainPassword = password || generateTempPassword();
    const created = await prisma.user.create({
      data: {
        email: normalizedEmail,
        name: (name || "").trim() || normalizedEmail.split("@")[0],
        passwordHash: await bcrypt.hash(plainPassword, 10),
        role: "USER",
        emailVerifiedAt: new Date(),
      },
    });
    await prisma.eventUserMapping.create({
      data: { eventId: event.id, userId: created.id, favouriteCap: favouriteCap ?? null },
    });
    res.status(201).json({
      status: "created",
      email: normalizedEmail,
      generated_password: generated ? plainPassword : null,
    });
  } catch (err) {
    next(err);
  }
});

// MERGE (Studio-Verse duplicate check, Phase 21): advisory-only lookup
// before inviting/provisioning — tells the studio whether this email
// already has an account and whether it's already on this event, so
// typos and double-invites get caught in the UI, not after sending mail.
router.get("/:id/clients/check", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const email = (req.query.email || "").trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: "A valid ?email= query address is required" });
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (!existingUser) {
      return res.json({ exists: false, already_in_event: false });
    }
    const mapping = await prisma.eventUserMapping.findUnique({
      where: { eventId_userId: { eventId: event.id, userId: existingUser.id } },
    });
    res.json({
      exists: true,
      already_in_event: !!mapping,
      name: existingUser.name,
      role: existingUser.role,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/clients/invite", async (req, res, next) => {  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const { email, favourite_cap: favouriteCap } = req.body || {};
    if (!email || typeof email !== "string" || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: "A valid email address is required" });
    }
    if (favouriteCap != null && (!Number.isInteger(favouriteCap) || favouriteCap < 1)) {
      return res.status(400).json({ error: "favourite_cap must be a positive integer, or omitted for no cap" });
    }
    const normalizedEmail = email.toLowerCase();

    const existingUser = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existingUser && existingUser.role === "USER") {
      await prisma.eventUserMapping.upsert({
        where: { eventId_userId: { eventId: event.id, userId: existingUser.id } },
        create: { eventId: event.id, userId: existingUser.id, favouriteCap: favouriteCap ?? null },
        update: {},
      });
      return res.json({ status: "added", email: normalizedEmail });
    }
    if (existingUser && existingUser.role !== "USER") {
      return res.status(409).json({ error: "This email already has a different kind of PandaSpot account" });
    }

    let invite = await prisma.clientInvite.findFirst({
      where: { eventId: event.id, acceptedAt: null, email: { equals: normalizedEmail, mode: "insensitive" } },
    });
    if (!invite) {
      const token = randomBytes(24).toString("base64url");
      invite = await prisma.clientInvite.create({
        data: { eventId: event.id, email: normalizedEmail, token, favouriteCap: favouriteCap ?? null },
      });
    }

    const inviteUrl = `${PUBLIC_WEB_URL}/client-invites/${invite.token}`;
    await sendClientInviteEmail(normalizedEmail, event.name, inviteUrl);

    res.json({ status: "invited", email: normalizedEmail });
  } catch (err) {
    next(err);
  }
});

router.get("/:id/clients", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const mappings = await prisma.eventUserMapping.findMany({
      where: { eventId: event.id },
      include: { user: true },
    });
    const pendingInviteRows = await prisma.clientInvite.findMany({
      where: { eventId: event.id, acceptedAt: null },
    });
    const favouriteCounts = await prisma.clientFavourite.groupBy({
      by: ["userId"],
      where: { photo: { eventId: event.id, photoSelectionVisible: true, archivedAt: null } },
      _count: { userId: true },
    });
    const countByUser = Object.fromEntries(favouriteCounts.map((c) => [c.userId, c._count.userId]));

    res.json({
      clients: mappings.map((m) => ({
        user_id: m.user.id,
        email: m.user.email,
        name: m.user.name,
        favourite_cap: m.favouriteCap,
        favourite_count: countByUser[m.user.id] || 0,
        submitted_at: m.submittedAt,
        access_expires: m.accessExpires,
        revoked_at: m.revokedAt,
      })),
      pending_invites: pendingInviteRows.map((i) => ({
        invite_id: i.id,
        email: i.email,
        invited_at: i.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id/clients/:userId", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const mapping = await prisma.eventUserMapping.findUnique({
      where: { eventId_userId: { eventId: event.id, userId: req.params.userId } },
    });
    if (!mapping) {
      return res.status(404).json({ error: "Client not found" });
    }

    await prisma.eventUserMapping.delete({ where: { id: mapping.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// MERGE (Studio-Verse Access Board, Phase 18E): edit one client's grant —
// favourite cap and/or access expiry. Null clears either field. Owner or
// collaborator, like every other event-settings action here.
router.patch("/:id/clients/:userId", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const mapping = await prisma.eventUserMapping.findUnique({
      where: { eventId_userId: { eventId: event.id, userId: req.params.userId } },
    });
    if (!mapping) {
      return res.status(404).json({ error: "Client not found" });
    }

    const { favourite_cap: favouriteCap, access_expires: accessExpires } = req.body || {};
    const data = {};
    if (favouriteCap !== undefined) {
      if (favouriteCap !== null && (!Number.isInteger(favouriteCap) || favouriteCap < 1)) {
        return res.status(400).json({ error: "favourite_cap must be a positive integer, or null for no cap" });
      }
      data.favouriteCap = favouriteCap;
    }
    if (accessExpires !== undefined) {
      if (accessExpires === null || accessExpires === "") {
        data.accessExpires = null;
      } else {
        const d = new Date(accessExpires);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({ error: "access_expires must be a valid date, or null to clear" });
        }
        data.accessExpires = d;
      }
    }
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: "No grant change provided." });
    }

    const updated = await prisma.eventUserMapping.update({ where: { id: mapping.id }, data });
    res.json({
      user_id: updated.userId,
      favourite_cap: updated.favouriteCap,
      access_expires: updated.accessExpires,
      submitted_at: updated.submittedAt,
      revoked_at: updated.revokedAt,
    });
  } catch (err) {
    next(err);
  }
});

// MERGE (Studio-Verse submit-on-behalf, Phase 18E): the studio force-locks
// a client's selection (submit) or re-opens it (unsubmit). The client's
// own POST /client/events/:id/submit stays one-way for the client
// themselves — only the studio can unlock.
router.post("/:id/clients/:userId/submit", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const mapping = await prisma.eventUserMapping.findUnique({
      where: { eventId_userId: { eventId: event.id, userId: req.params.userId } },
    });
    if (!mapping) {
      return res.status(404).json({ error: "Client not found" });
    }

    const updated = await prisma.eventUserMapping.update({
      where: { id: mapping.id },
      data: { submittedAt: mapping.submittedAt ?? new Date() },
    });
    res.json({ submitted_at: updated.submittedAt });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/clients/:userId/unsubmit", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const mapping = await prisma.eventUserMapping.findUnique({
      where: { eventId_userId: { eventId: event.id, userId: req.params.userId } },
    });
    if (!mapping) {
      return res.status(404).json({ error: "Client not found" });
    }

    const updated = await prisma.eventUserMapping.update({
      where: { id: mapping.id },
      data: { submittedAt: null },
    });
    res.json({ submitted_at: updated.submittedAt });
  } catch (err) {
    next(err);
  }
});

// MERGE (Studio-Verse revoke/restore, Phase 18E): soft revoke keeps the
// grant row (and its cap/expiry/submitted state) so the studio can
// restore it later; hard removal stays DELETE …/clients/:userId.
router.post("/:id/clients/:userId/revoke", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const mapping = await prisma.eventUserMapping.findUnique({
      where: { eventId_userId: { eventId: event.id, userId: req.params.userId } },
    });
    if (!mapping) {
      return res.status(404).json({ error: "Client not found" });
    }

    const updated = await prisma.eventUserMapping.update({
      where: { id: mapping.id },
      data: { revokedAt: mapping.revokedAt ?? new Date() },
    });
    res.json({ revoked_at: updated.revokedAt });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/clients/:userId/restore", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const mapping = await prisma.eventUserMapping.findUnique({
      where: { eventId_userId: { eventId: event.id, userId: req.params.userId } },
    });
    if (!mapping) {
      return res.status(404).json({ error: "Client not found" });
    }

    const updated = await prisma.eventUserMapping.update({
      where: { id: mapping.id },
      data: { revokedAt: null },
    });
    res.json({ revoked_at: updated.revokedAt });
  } catch (err) {
    next(err);
  }
});

// MERGE (Studio-Verse grouped favourites, Phase 18E): the studio's read
// side of Photo Selection — per-client groups plus a deduplicated merged
// view with "who favourited this" attribution. Favourites on photos
// hidden from Photo Selection since are excluded, matching what clients
// could ever have picked.
router.get("/:id/favourites", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const mappings = await prisma.eventUserMapping.findMany({
      where: { eventId: event.id },
      include: { user: true },
    });
    const favourites = await prisma.clientFavourite.findMany({
      where: { photo: { eventId: event.id, photoSelectionVisible: true, archivedAt: null } },
      include: {
        photo: true,
        user: true,
      },
      orderBy: { createdAt: "asc" },
    });

    const photoShape = (p) => ({
      photo_id: p.id,
      filename: p.filename,
      createdAt: p.createdAt,
      url: `/files/events/${event.id}/photos/${p.id}`,
      thumbnail_url: `/files/events/${event.id}/photos/${p.id}/thumb`,
    });

    const groups = mappings.map((m) => ({
      user_id: m.user.id,
      email: m.user.email,
      name: m.user.name,
      favourite_cap: m.favouriteCap,
      submitted_at: m.submittedAt,
      access_expires: m.accessExpires,
      revoked_at: m.revokedAt,
      photos: favourites.filter((f) => f.userId === m.userId).map((f) => photoShape(f.photo)),
    }));

    const mergedMap = new Map();
    for (const f of favourites) {
      if (!mergedMap.has(f.photoId)) {
        mergedMap.set(f.photoId, { ...photoShape(f.photo), favourited_by: [] });
      }
      mergedMap.get(f.photoId).favourited_by.push({
        user_id: f.user.id,
        email: f.user.email,
        name: f.user.name,
      });
    }

    res.json({ groups, merged: [...mergedMap.values()] });
  } catch (err) {
    next(err);
  }
});

// MERGE (Studio-Verse studio picks, Phase 18E): the studio's own separate
// curation list over the same photo pool — independent of what any client
// favourited. The acting studio user owns their picks (userId = req.user).
router.get("/:id/studio-picks", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const picks = await prisma.studioFavourite.findMany({
      where: { userId: req.user.id, photo: { eventId: event.id } },
      select: { photoId: true },
    });
    res.json({ photo_ids: picks.map((p) => p.photoId) });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/studio-picks", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const { photo_id: photoId } = req.body || {};
    if (!photoId || typeof photoId !== "string") {
      return res.status(400).json({ error: "photo_id is required" });
    }
    const photo = await prisma.photo.findFirst({ where: { id: photoId, eventId: event.id } });
    if (!photo) {
      return res.status(404).json({ error: "Photo not found" });
    }

    await prisma.studioFavourite.upsert({
      where: { photoId_userId: { photoId: photo.id, userId: req.user.id } },
      create: { photoId: photo.id, userId: req.user.id },
      update: {},
    });
    res.json({ photo_id: photo.id, is_pick: true });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id/studio-picks/:photoId", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const photo = await prisma.photo.findFirst({ where: { id: req.params.photoId, eventId: event.id } });
    if (!photo) {
      return res.status(404).json({ error: "Photo not found" });
    }

    await prisma.studioFavourite.deleteMany({
      where: { photoId: photo.id, userId: req.user.id },
    });
    res.json({ photo_id: photo.id, is_pick: false });
  } catch (err) {
    next(err);
  }
});

export default router;
