import { Router } from "express";
import { randomUUID, randomBytes } from "node:crypto";
import path from "node:path";
import fsp from "node:fs/promises";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";
import { ALLOWED_EXTENSIONS, deleteFileIfExists } from "../lib/storage.js";
import { getStorageProvider } from "../lib/storageProvider.js";
import { detectFaces } from "../lib/faceEngine.js";
import { insertFace } from "../lib/faces.js";
import { createJob, emitJobEvent, getJob } from "../lib/jobQueue.js";
import { loadAccessibleEvent } from "../lib/access.js";
import { sendCollaboratorInviteEmail, sendClientInviteEmail } from "../lib/mailer.js";
import { contentMatchesExtension } from "../lib/fileValidation.js";
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
import { uploadToDriveFolder, MIME_BY_EXT } from "../lib/driveBackup.js";

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
    // Union of events owned by this user and events they collaborate on,
    // each tagged with their role on that event.
    // Sub-galleries are real Events but aren't shown as their own top-level
    // dashboard entries — a guest reaches them via the parent's picker (see
    // GET /:id's sub_galleries), and the owner manages them from the
    // parent's detail page too.
    const owned = await prisma.event.findMany({
      where: { ownerId: req.user.id, parentEventId: null },
      include: { _count: { select: { photos: true } } },
    });
    const collabRows = await prisma.eventCollaborator.findMany({
      where: { userId: req.user.id },
      include: { event: { include: { _count: { select: { photos: true } } } } },
    });

    const all = [
      ...owned.map((e) => ({ ...e, role: "owner" })),
      ...collabRows.map((c) => ({ ...c.event, role: "collaborator" })),
    ];
    all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json(
      all.map((e) => ({
        id: e.id,
        name: e.name,
        guestSlug: e.guestSlug,
        guestLink: guestLinkPath(e.guestSlug),
        createdAt: e.createdAt,
        expires_at: e.expiresAt,
        photo_count: e._count.photos,
        role: e.role,
      }))
    );
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
  const newPhotoIds = [];

  try {
    for (const file of files) {
      const ext = path.extname(file.originalname).toLowerCase();
      let addedPhoto = null;

      if (!ALLOWED_EXTENSIONS.has(ext)) {
        skipped.push(`${file.originalname} (unsupported file type)`);
      } else if (!contentMatchesExtension(file.buffer, ext)) {
        skipped.push(`${file.originalname} (file content doesn't match its extension)`);
      } else if (usedBytes + file.buffer.length > storageLimitBytes) {
        skipped.push(`${file.originalname} (event storage limit reached)`);
      } else {
        let detection;
        try {
          detection = await detectFaces(file.buffer, file.originalname);
        } catch (err) {
          skipped.push(`${file.originalname} (${err.isFaceEngineError ? err.message : "could not process image"})`);
          detection = null;
        }

        if (detection) {
          const photoId = randomUUID();
          const storedFilename = `${photoId}${ext}`;
          const storagePath = await getStorageProvider().writeOriginal(event.id, storedFilename, file.buffer);
          const thumbnailPath = await generateThumbnail(file.buffer, event.id, photoId);

          const faces = detection.faces || [];
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
              originalExpiresAt: new Date(Date.now() + effectivePhotoRetentionDays(owner) * 24 * 60 * 60 * 1000),
            },
          });

          for (const face of faces) {
            await insertFace({
              photoId: photo.id,
              eventId: event.id,
              bbox: face.bbox,
              embedding: face.embedding,
              detScore: face.det_score,
            });
          }

          facesFoundSoFar += faces.length;
          usedBytes += file.buffer.length;
          newPhotoIds.push(photo.id);
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

    const photos = await prisma.photo.findMany({
      where: { eventId: event.id },
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
        moderation_flagged: p.moderationFlagged,
      }))
    );
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

    const updated = await prisma.photo.update({
      where: { id: photo.id },
      data: { approvalStatus: "approved" },
    });

    publishLiveEvent(event.id, {
      type: "photo_added",
      photo_id: updated.id,
      filename: updated.filename,
      face_count: updated.faceCount,
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

router.post("/:id/clients/invite", async (req, res, next) => {
  try {
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

    res.json({
      clients: mappings.map((m) => ({
        user_id: m.user.id,
        email: m.user.email,
        name: m.user.name,
        favourite_cap: m.favouriteCap,
        submitted_at: m.submittedAt,
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

export default router;
