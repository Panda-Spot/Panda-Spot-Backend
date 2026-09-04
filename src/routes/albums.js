import { Router } from "express";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { prisma } from "../lib/prisma.js";
import sharp from "sharp";
import { requireAuth } from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";
import { loadAccessibleEvent } from "../lib/access.js";
import { ALLOWED_EXTENSIONS, deleteFileIfExists, saveAlbumPage } from "../lib/storage.js";
import { contentMatchesExtension } from "../lib/fileValidation.js";
import { generateThumbnail } from "../lib/thumbnails.js";
import { streamPhotosZip, zipFilenameForEvent } from "../lib/zip.js";
import { readFile } from "node:fs/promises";
import { buildAlbumProofPdf } from "../lib/albumProof.js";
import { exportFilename } from "../lib/selectionExport.js";
import { sendAlbumSentEmail } from "../lib/mailer.js";

const router = Router({ mergeParams: true });

/// Album proofing (Phase 23): studio-designed spreads reviewed by the
/// client. Every route here is owner-or-collaborator via
/// loadAccessibleEvent (same gate as the rest of event settings); the
/// client side lives in routes/clientAlbums.js (USER-scoped, visibility
/// limited to non-DRAFT albums).
router.use(requireAuth);

function authorShape(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, email: u.email, role: u.role };
}

export { authorShape, pageShape, versionShape, commentShape, loadAlbum, albumDetail, createComment, requireUnlocked };

function pageShape(eventId, albumId, p) {
  return {
    page_id: p.id,
    page_number: p.pageNumber,
    filename: p.filename,
    file_size: p.fileSize,
    width: p.width ?? null,
    height: p.height ?? null,
    file_url: `/files/events/${eventId}/albums/${albumId}/files/${path.basename(p.storagePath)}`,
    thumbnail_url: p.thumbnailPath
      ? `/files/events/${eventId}/albums/${albumId}/files/${path.basename(p.thumbnailPath)}`
      : null,
    created_at: p.createdAt,
  };
}

function versionShape(eventId, albumId, v) {
  return {
    id: v.id,
    version_number: v.versionNumber,
    note: v.note,
    print_pdf_url: v.printPdfPath
      ? `/files/events/${eventId}/albums/${albumId}/files/${path.basename(v.printPdfPath)}`
      : null,
    created_at: v.createdAt,
    pages: [...(v.pages || [])]
      .sort((a, b) => a.pageNumber - b.pageNumber)
      .map((p) => pageShape(eventId, albumId, p)),
  };
}

function commentShape(c) {
  return {
    id: c.id,
    parent_id: c.parentId ?? null,
    version_id: c.versionId,
    page_id: c.pageId,
    pin_number: c.pinNumber,
    x_pct: c.xPct,
    y_pct: c.yPct,
    message: c.message,
    author: authorShape(c.author),
    resolved_at: c.resolvedAt,
    created_at: c.createdAt,
    replies: [...(c.replies || [])]
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
      .map((r) => ({
        id: r.id,
        message: r.message,
        author: authorShape(r.author),
        created_at: r.createdAt,
      })),
  };
}

async function loadAlbum(eventId, albumId, res) {
  const album = await prisma.album.findFirst({
    where: { id: albumId, eventId },
    include: {
      versions: { include: { pages: true }, orderBy: { versionNumber: "asc" } },
      sources: { include: { photo: true }, orderBy: { createdAt: "asc" } },
      createdBy: true,
    },
  });
  if (!album) {
    res.status(404).json({ error: "Album not found" });
    return null;
  }
  return album;
}

async function albumDetail(eventId, album) {
  const comments = await prisma.albumComment.findMany({
    where: { version: { albumId: album.id } },
    include: {
      author: true,
      replies: { include: { author: true }, orderBy: { createdAt: "asc" } },
    },
    orderBy: { createdAt: "asc" },
  });
  const openPins = comments.filter((c) => !c.parentId && c.pinNumber != null && !c.resolvedAt).length;
  return {
    id: album.id,
    name: album.name,
    status: album.status,
    locked_at: album.lockedAt,
    created_at: album.createdAt,
    created_by: authorShape(album.createdBy),
    sent_at: album.sentAt,
    open_pins: openPins,
    versions: album.versions.map((v) => versionShape(eventId, album.id, v)),
    sources: album.sources.map((s) => ({
      photo_id: s.photo.id,
      filename: s.photo.filename,
      source: s.photo.source,
      url: `/files/events/${eventId}/photos/${s.photo.id}`,
      thumbnail_url: `/files/events/${eventId}/photos/${s.photo.id}/thumb`,
    })),
    comments: comments.filter((c) => !c.parentId).map(commentShape),
  };
}

function requireUnlocked(album, res) {
  if (album.status === "APPROVED") {
    res.status(403).json({ error: "This album is approved and locked — reopen it to make changes." });
    return false;
  }
  return true;
}

// --- Albums ---

router.post("/", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const { name, from_favourites: fromFavourites } = req.body || {};
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name is required" });
    }
    const album = await prisma.album.create({
      data: { eventId: event.id, name: name.trim().slice(0, 120), createdById: req.user.id },
    });
    // One-tap staging from Photo Selection: every event photo at least one
    // client favourited becomes a zero-cost source ref. Idempotent by the
    // @@unique — re-running just tops up new favourites.
    let staged = 0;
    if (fromFavourites) {
      const favPhotos = await prisma.photo.findMany({
        where: { eventId: event.id, archivedAt: null, clientFavourites: { some: {} } },
        select: { id: true },
        take: 2000,
      });
      for (const p of favPhotos) {
        await prisma.albumSource.upsert({
          where: { albumId_photoId: { albumId: album.id, photoId: p.id } },
          create: { albumId: album.id, photoId: p.id },
          update: {},
        }).catch(() => null);
      }
      staged = await prisma.albumSource.count({ where: { albumId: album.id } });
    }
    res.status(201).json({
      id: album.id,
      name: album.name,
      status: album.status,
      created_at: album.createdAt,
      created_by: authorShape({ id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role }),
      source_count: staged,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const albums = await prisma.album.findMany({
      where: { eventId: event.id },
      include: {
        versions: { select: { id: true, versionNumber: true, createdAt: true } },
        _count: { select: { sources: true } },
        createdBy: true,
      },
      orderBy: { createdAt: "desc" },
    });
    const withPins = await Promise.all(
      albums.map(async (a) => ({
        id: a.id,
        name: a.name,
        status: a.status,
        locked_at: a.lockedAt,
        created_at: a.createdAt,
        created_by: authorShape(a.createdBy),
        sent_at: a.sentAt,
        source_count: a._count.sources,
        version_count: a.versions.length,
        latest_version: a.versions.length ? Math.max(...a.versions.map((v) => v.versionNumber)) : null,
        open_pins: await prisma.albumComment.count({
          where: { version: { albumId: a.id }, parentId: null, pinNumber: { not: null }, resolvedAt: null },
        }),
      }))
    );
    res.json(withPins);
  } catch (err) {
    next(err);
  }
});

router.get("/:albumId", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const album = await loadAlbum(event.id, req.params.albumId, res);
    if (!album) return;
    res.json(await albumDetail(event.id, album));
  } catch (err) {
    next(err);
  }
});

// Phase 7: album proofing PDF — title, event, reviewers, every revision
// with its spreads/notes, and every comment with OPEN/RESOLVED status,
// plus the approval timestamp once locked.
router.get("/:albumId/proof.pdf", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const album = await loadAlbum(event.id, req.params.albumId, res);
    if (!album) return;
    const detail = await albumDetail(event.id, album);
    const mappings = await prisma.eventUserMapping.findMany({
      where: { eventId: event.id, revokedAt: null },
      include: { user: true },
      orderBy: { createdAt: "asc" },
    });
    const pdf = await buildAlbumProofPdf({
      event,
      album: detail,
      clients: mappings.map((m) => ({ name: m.user?.name, email: m.user?.email })),
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${exportFilename(event.name, `${album.name}-proof`, "pdf")}"`
    );
    res.send(pdf);
  } catch (err) {
    console.error(`Album proof PDF failed (album ${req.params.albumId}):`, err);
    if (!res.headersSent) res.status(500).json({ error: "Proof PDF failed — please try again." });
  }
});

router.patch("/:albumId", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const album = await loadAlbum(event.id, req.params.albumId, res);
    if (!album) return;
    const { name } = req.body || {};
    if (name !== undefined && (typeof name !== "string" || !name.trim())) {
      return res.status(400).json({ error: "name must be a non-empty string" });
    }
    const updated = await prisma.album.update({
      where: { id: album.id },
      data: { name: name !== undefined ? name.trim().slice(0, 120) : undefined },
    });
    res.json({ id: updated.id, name: updated.name, status: updated.status });
  } catch (err) {
    next(err);
  }
});

router.delete("/:albumId", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const album = await loadAlbum(event.id, req.params.albumId, res);
    if (!album) return;
    if (!requireUnlocked(album, res)) return;
    // Phase 4: deleting a whole project is owner-only.
    if (!requireOwner(accessible, res)) return;
    await prisma.album.delete({ where: { id: album.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// --- Sources (zero-cost staging from event photos) ---

router.post("/:albumId/sources", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const album = await loadAlbum(event.id, req.params.albumId, res);
    if (!album) return;
    if (!requireUnlocked(album, res)) return;

    const { photo_ids: photoIds } = req.body || {};
    if (!Array.isArray(photoIds) || photoIds.length === 0) {
      return res.status(400).json({ error: "photo_ids (non-empty array) is required" });
    }
    if (photoIds.length > 2000) {
      return res.status(400).json({ error: "photo_ids is limited to 2000 per call" });
    }
    const rows = await prisma.photo.findMany({
      where: { id: { in: photoIds }, eventId: event.id },
      select: { id: true },
    });
    const found = new Set(rows.map((r) => r.id));
    const skipped = photoIds.filter((id) => !found.has(id));
    let added = 0;
    for (const id of found) {
      const up = await prisma.albumSource.upsert({
        where: { albumId_photoId: { albumId: album.id, photoId: id } },
        create: { albumId: album.id, photoId: id },
        update: {},
      }).catch(() => null);
      if (up) added += 1;
    }
    // Re-fetch to report the true count (upsert is idempotent — re-adding
    // existing sources changes nothing).
    const total = await prisma.albumSource.count({ where: { albumId: album.id } });
    res.status(201).json({ added, skipped, total });
  } catch (err) {
    next(err);
  }
});

router.get("/:albumId/sources", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const album = await loadAlbum(event.id, req.params.albumId, res);
    if (!album) return;
    res.json(
      album.sources.map((s) => ({
        photo_id: s.photo.id,
        filename: s.photo.filename,
        source: s.photo.source,
        url: `/files/events/${event.id}/photos/${s.photo.id}`,
        thumbnail_url: `/files/events/${event.id}/photos/${s.photo.id}/thumb`,
      }))
    );
  } catch (err) {
    next(err);
  }
});

router.delete("/:albumId/sources/:photoId", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const album = await loadAlbum(event.id, req.params.albumId, res);
    if (!album) return;
    if (!requireUnlocked(album, res)) return;
    await prisma.albumSource.deleteMany({
      where: { albumId: album.id, photoId: req.params.photoId },
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Full-resolution originals of the staged sources, for designing spreads
// externally (Photoshop) — the studio's take-home counterpart to the
// guest/client zips. Streams from local disk or Drive like every other zip.
router.get("/:albumId/sources/download-zip", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const album = await loadAlbum(event.id, req.params.albumId, res);
    if (!album) return;
    const photos = album.sources.map((s) => s.photo).filter(Boolean);
    if (photos.length === 0) {
      return res.status(404).json({ error: "This album has no staged source photos yet" });
    }
    const safeEvent = event.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "pandaspot-event";
    const safeAlbum = album.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "album";
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${safeEvent}-${safeAlbum}-sources.zip"`);
    await streamPhotosZip(photos, res);
  } catch (err) {
    next(err);
  }
});

// --- Versions (spread images or a print PDF, exclusive) ---

const versionUpload = upload.fields([
  { name: "images", maxCount: 60 },
  { name: "print_pdf", maxCount: 1 },
]);

function isPdfBuffer(buffer) {
  return buffer && buffer.length > 4 && buffer.toString("ascii", 0, 4) === "%PDF";
}

router.post("/:albumId/versions", versionUpload, async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const album = await loadAlbum(event.id, req.params.albumId, res);
    if (!album) return;
    if (!requireUnlocked(album, res)) return;

    const images = req.files?.images || [];
    const pdfs = req.files?.print_pdf || [];
    if ((images.length === 0 && pdfs.length === 0) || (images.length > 0 && pdfs.length > 0)) {
      return res.status(400).json({ error: "Upload spread images[] or a single print_pdf — not both, not neither." });
    }
    const { note, notes } = req.body || {};
    const noteText = note ?? notes;
    if (noteText != null && (typeof noteText !== "string" || noteText.length > 500)) {
      return res.status(400).json({ error: "note must be a string up to 500 characters" });
    }

    const existingMax = album.versions.length ? Math.max(...album.versions.map((v) => v.versionNumber)) : 0;
    const versionNumber = existingMax + 1;

    if (pdfs.length > 0) {
      const pdf = pdfs[0];
      if (!isPdfBuffer(pdf.buffer)) {
        return res.status(415).json({ error: "print_pdf content isn't a PDF" });
      }
      const printPdfPath = await saveAlbumPage(event.id, album.id, versionNumber, `${randomUUID()}.pdf`, pdf.buffer);
      const version = await prisma.albumVersion.create({
        data: {
          albumId: album.id,
          versionNumber,
          note: noteText?.trim() || null,
          printPdfPath,
        },
      });
      if (album.status === "CHANGES_REQUESTED") {
        await prisma.album.update({ where: { id: album.id }, data: { status: "SENT", sentAt: new Date() } });
      }
      const full = await prisma.albumVersion.findUnique({
        where: { id: version.id },
        include: { pages: { orderBy: { pageNumber: "asc" } } },
      });
      return res.status(201).json(versionShape(event.id, album.id, full));
    }

    // Spread images, in upload order.
    for (const file of images) {
      const ext = path.extname(file.originalname).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext) || ext === ".pdf") {
        return res.status(415).json({ error: `Unsupported spread file type: ${file.originalname}` });
      }
      if (!contentMatchesExtension(file.buffer, ext)) {
        return res.status(415).json({ error: `File content doesn't match its extension: ${file.originalname}` });
      }
    }

    const version = await prisma.albumVersion.create({
      data: { albumId: album.id, versionNumber, note: noteText?.trim() || null },
    });
    let pageNumber = 0;
    for (const file of images) {
      pageNumber += 1;
      const ext = path.extname(file.originalname).toLowerCase();
      const storagePath = await saveAlbumPage(event.id, album.id, versionNumber, `${randomUUID()}${ext}`, file.buffer);
      // Phase 4: capture spread dimensions when detectable — best effort,
      // never fatal to the upload.
      let width = null;
      let height = null;
      try {
        const meta = await sharp(file.buffer).metadata();
        if (meta?.width && meta?.height) {
          width = meta.width;
          height = meta.height;
        }
      } catch {
        // Unreadable pixels still make a valid page; dimensions stay null.
      }
      const page = await prisma.albumPage.create({
        data: {
          versionId: version.id,
          pageNumber,
          storagePath,
          filename: file.originalname,
          fileSize: file.buffer.length,
          width,
          height,
        },
      });
      try {
        const thumbnailPath = await generateThumbnail(file.buffer, event.id, page.id);
        if (thumbnailPath) {
          await prisma.albumPage.update({ where: { id: page.id }, data: { thumbnailPath } });
        }
      } catch {
        // Thumbnails are a fast-path nicety — the flipbook falls back to
        // the full file, so a failure here never fails the version upload.
      }
    }

    if (album.status === "CHANGES_REQUESTED") {
      await prisma.album.update({ where: { id: album.id }, data: { status: "SENT", sentAt: new Date() } });
    }
    const full = await prisma.albumVersion.findUnique({
      where: { id: version.id },
      include: { pages: { orderBy: { pageNumber: "asc" } } },
    });
    res.status(201).json(versionShape(event.id, album.id, full));
  } catch (err) {
    next(err);
  }
});

router.delete("/:albumId/versions/:versionId", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const album = await loadAlbum(event.id, req.params.albumId, res);
    if (!album) return;
    if (!requireUnlocked(album, res)) return;
    const version = album.versions.find((v) => v.id === req.params.versionId);
    if (!version) return res.status(404).json({ error: "Version not found" });
    const maxNumber = Math.max(...album.versions.map((v) => v.versionNumber));
    if (version.versionNumber !== maxNumber) {
      return res.status(409).json({ error: "Only the latest version can be deleted — history stays intact." });
    }
    for (const page of version.pages || []) {
      await deleteFileIfExists(page.storagePath);
      if (page.thumbnailPath) await deleteFileIfExists(page.thumbnailPath);
    }
    const fresh = await prisma.albumVersion.findUnique({
      where: { id: version.id },
      select: { printPdfPath: true },
    });
    if (fresh?.printPdfPath) await deleteFileIfExists(fresh.printPdfPath);
    await prisma.albumVersion.delete({ where: { id: version.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Phase 4: reorder spreads inside one version. Body { order: [pageId…] }
// must contain exactly the version's pages — positions are reassigned
// 1..N in that order. Pins ride along (they're keyed by page id).
router.patch("/:albumId/versions/:versionId/pages/reorder", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const album = await loadAlbum(event.id, req.params.albumId, res);
    if (!album) return;
    if (!requireUnlocked(album, res)) return;
    const version = album.versions.find((v) => v.id === req.params.versionId);
    if (!version) return res.status(404).json({ error: "Version not found" });
    if (version.printPdfPath) {
      return res.status(400).json({ error: "Print-PDF versions have no spreads to reorder." });
    }
    const { order } = req.body || {};
    const currentIds = new Set((version.pages || []).map((p) => p.id));
    if (!Array.isArray(order) || order.length !== currentIds.size || !order.every((id) => currentIds.has(id))) {
      return res.status(400).json({ error: "order must list exactly this version's page ids" });
    }
    // Two-phase (temp high numbers first): pageNumber is @@unique per
    // version, so direct swaps would transiently collide mid-transaction.
    await prisma.$transaction([
      ...order.map((id, i) => prisma.albumPage.update({ where: { id }, data: { pageNumber: 100000 + i } })),
      ...order.map((id, i) => prisma.albumPage.update({ where: { id }, data: { pageNumber: i + 1 } })),
    ]);
    const full = await prisma.albumVersion.findUnique({
      where: { id: version.id },
      include: { pages: { orderBy: { pageNumber: "asc" } } },
    });
    res.json(versionShape(event.id, album.id, full));
  } catch (err) {
    next(err);
  }
});

// Phase 4: delete one spread. Its pins go with it (DB cascade); the rest
// renumber to keep 1..N contiguous for the flipbook.
router.delete("/:albumId/versions/:versionId/pages/:pageId", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const album = await loadAlbum(event.id, req.params.albumId, res);
    if (!album) return;
    if (!requireUnlocked(album, res)) return;
    const version = album.versions.find((v) => v.id === req.params.versionId);
    if (!version) return res.status(404).json({ error: "Version not found" });
    const page = (version.pages || []).find((p) => p.id === req.params.pageId);
    if (!page) return res.status(404).json({ error: "Page not found" });
    if ((version.pages || []).length <= 1) {
      return res.status(409).json({ error: "A version needs at least one spread — delete the version instead." });
    }
    await deleteFileIfExists(page.storagePath);
    if (page.thumbnailPath) await deleteFileIfExists(page.thumbnailPath);
    await prisma.albumPage.delete({ where: { id: page.id } });
    const remaining = await prisma.albumPage.findMany({
      where: { versionId: version.id },
      orderBy: { pageNumber: "asc" },
      select: { id: true },
    });
    await prisma.$transaction([
      ...remaining.map((p, i) => prisma.albumPage.update({ where: { id: p.id }, data: { pageNumber: 100000 + i } })),
      ...remaining.map((p, i) => prisma.albumPage.update({ where: { id: p.id }, data: { pageNumber: i + 1 } })),
    ]);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Phase 7: start a new revision FROM the current spreads — the new
// version gets its own file copies (copy-on-write), so reworking or
// replacing pages never disturbs the preserved revision. Body
// { from_version_id? } defaults to the latest image version.
router.post("/:albumId/versions/duplicate", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const album = await loadAlbum(event.id, req.params.albumId, res);
    if (!album) return;
    if (!requireUnlocked(album, res)) return;
    const { from_version_id: fromVersionId } = req.body || {};
    const imageVersions = (album.versions || []).filter((v) => !v.printPdfPath);
    const source = fromVersionId
      ? imageVersions.find((v) => v.id === fromVersionId)
      : imageVersions.reduce((a, b) => (a && a.versionNumber >= b.versionNumber ? a : b), null);
    if (!source) {
      return res.status(400).json({ error: "No image version to duplicate yet — upload spreads first." });
    }
    if (!source.pages || source.pages.length === 0) {
      return res.status(400).json({ error: "The source version has no spreads to duplicate." });
    }
    const versionNumber = Math.max(...album.versions.map((v) => v.versionNumber)) + 1;
    const version = await prisma.albumVersion.create({
      data: {
        albumId: album.id,
        versionNumber,
        note: `Duplicated from V${source.versionNumber} — replace spreads as needed`,
      },
    });
    let pageNumber = 0;
    for (const src of [...source.pages].sort((a, b) => a.pageNumber - b.pageNumber)) {
      pageNumber += 1;
      const ext = path.extname(src.filename || src.storagePath).toLowerCase() || ".jpg";
      const buffer = await readFile(src.storagePath);
      const storagePath = await saveAlbumPage(event.id, album.id, versionNumber, `${randomUUID()}${ext}`, buffer);
      const page = await prisma.albumPage.create({
        data: {
          versionId: version.id,
          pageNumber,
          storagePath,
          filename: src.filename,
          fileSize: buffer.length,
          width: src.width ?? null,
          height: src.height ?? null,
        },
      });
      try {
        const thumbnailPath = await generateThumbnail(buffer, event.id, page.id);
        if (thumbnailPath) {
          await prisma.albumPage.update({ where: { id: page.id }, data: { thumbnailPath } });
        }
      } catch {
        // Same nicety rule as uploads — thumbnails never fail a duplication.
      }
    }
    if (album.status === "CHANGES_REQUESTED") {
      await prisma.album.update({ where: { id: album.id }, data: { status: "SENT", sentAt: new Date() } });
    }
    const full = await prisma.albumVersion.findUnique({
      where: { id: version.id },
      include: { pages: { orderBy: { pageNumber: "asc" } } },
    });
    res.status(201).json(versionShape(event.id, album.id, full));
  } catch (err) {
    next(err);
  }
});

// --- Review lifecycle ---

router.post("/:albumId/send", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const album = await loadAlbum(event.id, req.params.albumId, res);
    if (!album) return;
    if (album.status !== "DRAFT") {
      return res.status(409).json({ error: `Only a draft can be sent (current: ${album.status}).` });
    }
    const hasContent = album.versions.some(
      (v) => (v.pages && v.pages.length > 0) || v.printPdfPath
    );
    if (!hasContent) {
      return res.status(400).json({ error: "Upload at least one version with spreads before sending." });
    }
    const updated = await prisma.album.update({
      where: { id: album.id },
      data: { status: "SENT", sentAt: new Date() },
    });
    // Phase 7: best-effort client notification — mail failures (or no
    // SMTP at all) must never fail the send itself.
    try {
      const mappings = await prisma.eventUserMapping.findMany({
        where: { eventId: event.id },
        include: { user: true },
      });
      const latestVersion = Math.max(...album.versions.map((v) => v.versionNumber));
      for (const m of mappings) {
        if (m.user?.email && !m.revokedAt) {
          await sendAlbumSentEmail(m.user.email, {
            eventName: event.name,
            albumName: album.name,
            versionNumber: latestVersion,
            eventId: event.id,
            albumId: album.id,
          }).catch(() => {});
        }
      }
    } catch (err) {
      console.error(`Album send notification failed (album ${album.id}):`, err.message);
    }
    res.json({ status: updated.status, sent_at: updated.sentAt });
  } catch (err) {
    next(err);
  }
});

function requireOwner(accessible, res) {
  if (accessible.role !== "owner") {
    res.status(403).json({ error: "Only the event owner can do that — collaborators have review powers, not destructive ones." });
    return false;
  }
  return true;
}

router.post("/:albumId/reopen", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;
    // Phase 4: unlocking an approved album is owner-only.
    if (!requireOwner(accessible, res)) return;

    const album = await loadAlbum(event.id, req.params.albumId, res);
    if (!album) return;
    if (album.status !== "APPROVED") {
      return res.status(409).json({ error: "Only an approved album can be reopened." });
    }
    const updated = await prisma.album.update({
      where: { id: album.id },
      data: { status: "DRAFT", lockedAt: null },
    });
    // Phase 7: unlocking is the one destructive review action — the UI
    // confirms with this same warning, and the API echoes it so headless
    // callers can't miss what reopening does.
    res.json({
      status: updated.status,
      warning:
        "Album unlocked back to DRAFT: the client loses access until you send again, and the approval lock is gone. Only reopen for genuine rework.",
    });
  } catch (err) {
    next(err);
  }
});

// --- Pinned comments (studio side; clients use clientAlbums.js) ---

async function createComment({ album, versionId, pageId, parentId, xPct, yPct, message, authorId }) {
  const version = await prisma.albumVersion.findFirst({ where: { id: versionId, albumId: album.id } });
  if (!version) {
    const err = new Error("Version not found in this album");
    err.status = 404;
    throw err;
  }
  let page = null;
  if (pageId) {
    page = await prisma.albumPage.findFirst({ where: { id: pageId, versionId: version.id } });
    if (!page) {
      const err = new Error("Page not found in this version");
      err.status = 404;
      throw err;
    }
  }
  let parent = null;
  if (parentId) {
    parent = await prisma.albumComment.findFirst({
      where: { id: parentId, versionId: version.id },
      select: { id: true, parentId: true },
    });
    if (!parent) {
      const err = new Error("Parent comment not found in this version");
      err.status = 404;
      throw err;
    }
    if (parent.parentId) {
      const err = new Error("Replies can't nest deeper than one level");
      err.status = 400;
      throw err;
    }
  }

  // Mixed state (only one coordinate) is a client bug — coordinates come
  // as a pair or not at all. No coordinates = general version note.
  if (!parentId && (xPct == null) !== (yPct == null)) {
    const err = new Error("x_pct and y_pct must be provided together");
    err.status = 400;
    throw err;
  }
  const positioned = !parentId && xPct != null && yPct != null;
  let pinNumber = null;
  if (positioned) {
    if (typeof xPct !== "number" || typeof yPct !== "number" || xPct < 0 || xPct > 100 || yPct < 0 || yPct > 100) {
      const err = new Error("x_pct/y_pct must be numbers between 0 and 100");
      err.status = 400;
      throw err;
    }
    const agg = await prisma.albumComment.aggregate({
      where: { versionId: version.id, pageId: page?.id ?? null, pinNumber: { not: null } },
      _max: { pinNumber: true },
    });
    pinNumber = (agg._max.pinNumber ?? 0) + 1;
  }
  if (!message || typeof message !== "string" || !message.trim()) {
    const err = new Error("message is required");
    err.status = 400;
    throw err;
  }

  return prisma.albumComment.create({
    data: {
      versionId: version.id,
      pageId: page?.id ?? null,
      parentId: parent?.id ?? null,
      pinNumber,
      xPct: positioned ? xPct : null,
      yPct: positioned ? yPct : null,
      message: message.trim().slice(0, 2000),
      authorId,
    },
    include: { author: true },
  });
}

router.post("/:albumId/comments", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const album = await loadAlbum(event.id, req.params.albumId, res);
    if (!album) return;
    if (!requireUnlocked(album, res)) return;

    const { version_id: versionId, page_id: pageId, parent_id: parentId, x_pct: xPct, y_pct: yPct, message } = req.body || {};
    if (!versionId) return res.status(400).json({ error: "version_id is required" });
    try {
      const created = await createComment({ album, versionId, pageId, parentId, xPct, yPct, message, authorId: req.user.id });
      res.status(201).json(commentShape({ ...created, replies: [] }));
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

router.post("/:albumId/comments/:commentId/resolve", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const album = await loadAlbum(event.id, req.params.albumId, res);
    if (!album) return;
    if (!requireUnlocked(album, res)) return;
    const comment = await prisma.albumComment.findFirst({
      where: { id: req.params.commentId, version: { albumId: album.id }, parentId: null },
    });
    if (!comment) return res.status(404).json({ error: "Comment not found" });

    const { resolved } = req.body || {};
    const updated = await prisma.albumComment.update({
      where: { id: comment.id },
      data: { resolvedAt: resolved === false ? null : new Date() },
    });
    res.json({ id: updated.id, resolved_at: updated.resolvedAt });
  } catch (err) {
    next(err);
  }
});

// Phase 6: explicit unresolve alias — reopens a resolved thread back to
// OPEN. Same guards as resolve.
router.post("/:albumId/comments/:commentId/unresolve", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const album = await loadAlbum(event.id, req.params.albumId, res);
    if (!album) return;
    if (!requireUnlocked(album, res)) return;
    const comment = await prisma.albumComment.findFirst({
      where: { id: req.params.commentId, version: { albumId: album.id }, parentId: null },
    });
    if (!comment) return res.status(404).json({ error: "Comment not found" });

    const updated = await prisma.albumComment.update({
      where: { id: comment.id },
      data: { resolvedAt: null },
    });
    res.json({ id: updated.id, resolved_at: updated.resolvedAt });
  } catch (err) {
    next(err);
  }
});

// Phase 6: delete a comment (top-level deletes cascade to its replies).
// Studio side: owner or collaborator, unlocked albums only.
router.delete("/:albumId/comments/:commentId", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const album = await loadAlbum(event.id, req.params.albumId, res);
    if (!album) return;
    if (!requireUnlocked(album, res)) return;
    const comment = await prisma.albumComment.findFirst({
      where: { id: req.params.commentId, version: { albumId: album.id } },
    });
    if (!comment) return res.status(404).json({ error: "Comment not found" });
    await prisma.albumComment.delete({ where: { id: comment.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Phase 6: flat per-revision thread list — top-level comments with
// replies, newest-last. Revision feedback stays queryable per version
// even after newer revisions exist.
router.get("/:albumId/versions/:versionId/comments", async (req, res, next) => {
  try {
    const accessible = await loadAccessibleEvent(req, res);
    if (!accessible) return;
    const { event } = accessible;

    const album = await loadAlbum(event.id, req.params.albumId, res);
    if (!album) return;
    const version = album.versions.find((v) => v.id === req.params.versionId);
    if (!version) return res.status(404).json({ error: "Version not found" });
    const comments = await prisma.albumComment.findMany({
      where: { versionId: version.id, parentId: null },
      include: { author: true, replies: { include: { author: true }, orderBy: { createdAt: "asc" } } },
      orderBy: { createdAt: "asc" },
    });
    res.json(comments.map(commentShape));
  } catch (err) {
    next(err);
  }
});

export default router;
