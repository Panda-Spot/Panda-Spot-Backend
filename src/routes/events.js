import { Router } from "express";
import { randomUUID, randomBytes } from "node:crypto";
import path from "node:path";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";
import { ALLOWED_EXTENSIONS, saveEventPhoto, deleteFileIfExists, removeEventDir } from "../lib/storage.js";
import { zipDownloadPath } from "../lib/zip.js";
import { detectFaces } from "../lib/faceEngine.js";
import { insertFace } from "../lib/faces.js";
import { createJob, emitJobEvent, getJob } from "../lib/jobQueue.js";
import { loadAccessibleEvent } from "../lib/access.js";
import { sendCollaboratorInviteEmail } from "../lib/mailer.js";
import { contentMatchesExtension } from "../lib/fileValidation.js";
import { uploadLimiter } from "../lib/rateLimiters.js";
import { generateThumbnail } from "../lib/thumbnails.js";
import { FREE_EVENT_LIMIT, FREE_EVENT_STORAGE_BYTES, countOwnedEvents, eventStorageUsedBytes } from "../lib/planLimits.js";
import { computeExpiresAt } from "../lib/expiry.js";
import { bucketByDay } from "../lib/dailyBuckets.js";

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

    const ownedCount = await countOwnedEvents(prisma, req.user.id);
    if (ownedCount >= FREE_EVENT_LIMIT) {
      return res.status(403).json({
        error: "You've reached the free plan limit of 15 events. Upgrade coming soon.",
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
    const owned = await prisma.event.findMany({
      where: { ownerId: req.user.id },
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

    res.json({
      id: event.id,
      name: event.name,
      guestSlug: event.guestSlug,
      guestLink: guestLinkPath(event.guestSlug),
      createdAt: event.createdAt,
      expires_at: event.expiresAt,
      photo_count: photoCount,
      storage_used_bytes: storageUsedBytes,
      storage_limit_bytes: FREE_EVENT_STORAGE_BYTES,
      role,
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

// Owner-only — deleting the whole event (guest link, every photo, every
// collaborator) is a much bigger action than removing one bad photo.
// Deletes in FK dependency order (children before the Event row itself),
// then removes the event's entire photo/thumbnail directory from disk in
// one shot, plus any pre-built zip files from the email-download flow.
router.delete("/:id", async (req, res, next) => {
  try {
    const event = await loadOwnedEvent(req, res);
    if (!event) return;

    const zipDownloads = await prisma.zipDownload.findMany({ where: { eventId: event.id } });

    await prisma.matchFeedback.deleteMany({
      where: { search: { eventId: event.id } },
    });
    await prisma.guestSearch.deleteMany({ where: { eventId: event.id } });
    await prisma.face.deleteMany({ where: { eventId: event.id } });
    await prisma.photo.deleteMany({ where: { eventId: event.id } });
    await prisma.zipDownload.deleteMany({ where: { eventId: event.id } });
    await prisma.eventCollaborator.deleteMany({ where: { eventId: event.id } });
    await prisma.eventInvite.deleteMany({ where: { eventId: event.id } });
    await prisma.event.delete({ where: { id: event.id } });

    await removeEventDir(event.id);
    for (const z of zipDownloads) {
      await deleteFileIfExists(z.filePath || zipDownloadPath(z.id));
    }

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

  try {
    for (const file of files) {
      const ext = path.extname(file.originalname).toLowerCase();

      if (!ALLOWED_EXTENSIONS.has(ext)) {
        skipped.push(`${file.originalname} (unsupported file type)`);
      } else if (!contentMatchesExtension(file.buffer, ext)) {
        skipped.push(`${file.originalname} (file content doesn't match its extension)`);
      } else if (usedBytes + file.buffer.length > FREE_EVENT_STORAGE_BYTES) {
        skipped.push(`${file.originalname} (event storage limit reached — 10GB free plan cap)`);
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
          const storagePath = await saveEventPhoto(event.id, storedFilename, file.buffer);
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
      });
    }

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
      }))
    );
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

    await deleteFileIfExists(photo.storagePath);
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

export default router;
