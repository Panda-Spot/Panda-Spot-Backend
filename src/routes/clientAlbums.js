import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/role.js";
import { loadAlbum, albumDetail, commentShape, createComment } from "./albums.js";
import { buildAlbumProofPdf } from "../lib/albumProof.js";
import { exportFilename } from "../lib/selectionExport.js";
import { sendAlbumApprovedEmail, sendAlbumChangesRequestedEmail } from "../lib/mailer.js";

async function notifyOwner(event, album, kind, extra = {}) {
  try {
    const owner = await prisma.user.findUnique({ where: { id: event.ownerId }, select: { email: true } });
    if (!owner?.email) return;
    const base = { eventName: event.name, albumName: album.name, eventId: event.id, albumId: album.id };
    if (kind === "approved") await sendAlbumApprovedEmail(owner.email, base).catch(() => {});
    else await sendAlbumChangesRequestedEmail(owner.email, { ...base, ...extra }).catch(() => {});
  } catch (err) {
    console.error(`Album ${kind} notification failed (album ${album.id}):`, err.message);
  }
}

const router = Router({ mergeParams: true });

/// Album proofing, client side (Phase 23): a logged-in USER with a live
/// grant on the event reviews SENT albums — flipbook, pins + replies,
/// request-changes / approve. Drafts are invisible; APPROVED locks
/// everything except viewing. Deliberately NOT gated on
/// photoSelectionEnabled: an in-review album must survive that toggle.
router.use(requireAuth, requireRole("USER"));

async function loadClientAlbum(req, res) {
  const mapping = await prisma.eventUserMapping.findUnique({
    where: { eventId_userId: { eventId: req.params.eventId, userId: req.user.id } },
    include: { event: true },
  });
  if (!mapping) {
    res.status(404).json({ error: "You don't have access to this event" });
    return null;
  }
  if (mapping.revokedAt) {
    res.status(404).json({ error: "You don't have access to this event", event_name: mapping.event.name, reason: "revoked" });
    return null;
  }
  if (mapping.accessExpires && new Date(mapping.accessExpires) < new Date()) {
    res.status(404).json({ error: "You don't have access to this event", event_name: mapping.event.name, reason: "expired" });
    return null;
  }
  if (mapping.event.archivedAt) {
    res.status(404).json({ error: "You don't have access to this event", event_name: mapping.event.name, reason: "archived" });
    return null;
  }
  const album = await loadAlbum(mapping.eventId, req.params.albumId, res);
  if (!album) return null;
  if (album.status === "DRAFT") {
    res.status(404).json({ error: "Album not found" });
    return null;
  }
  return { mapping, event: mapping.event, album };
}

function requireReviewOpen(album, res) {
  if (album.status === "APPROVED") {
    res.status(403).json({ error: "This album is approved and locked." });
    return false;
  }
  return true;
}

router.get("/", async (req, res, next) => {
  try {
    const mapping = await prisma.eventUserMapping.findUnique({
      where: { eventId_userId: { eventId: req.params.eventId, userId: req.user.id } },
    });
    if (!mapping || mapping.revokedAt) {
      return res.status(404).json({ error: "You don't have access to this event" });
    }
    if (mapping.accessExpires && new Date(mapping.accessExpires) < new Date()) {
      return res.status(404).json({ error: "You don't have access to this event" });
    }
    const albums = await prisma.album.findMany({
      where: {
        eventId: mapping.eventId,
        status: { not: "DRAFT" },
      },
      include: {
        versions: { select: { id: true, versionNumber: true, printPdfPath: true } },
      },
      orderBy: { updatedAt: "desc" },
    });
    const withPins = await Promise.all(
      albums.map(async (a) => ({
        id: a.id,
        name: a.name,
        status: a.status,
        locked_at: a.lockedAt,
        updated_at: a.updatedAt,
        version_count: a.versions.length,
        latest_version: a.versions.length ? Math.max(...a.versions.map((v) => v.versionNumber)) : null,
        has_print_pdf: a.versions.some((v) => v.printPdfPath),
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
    const loaded = await loadClientAlbum(req, res);
    if (!loaded) return;
    res.json(await albumDetail(loaded.event.id, loaded.album));
  } catch (err) {
    next(err);
  }
});

router.post("/:albumId/comments", async (req, res, next) => {
  try {
    const loaded = await loadClientAlbum(req, res);
    if (!loaded) return;
    if (!requireReviewOpen(loaded.album, res)) return;

    const { version_id: versionId, page_id: pageId, parent_id: parentId, x_pct: xPct, y_pct: yPct, message } = req.body || {};
    if (!versionId) return res.status(400).json({ error: "version_id is required" });
    try {
      const created = await createComment({
        album: loaded.album,
        versionId,
        pageId,
        parentId,
        xPct,
        yPct,
        message,
        authorId: req.user.id,
      });
      res.status(201).json(commentShape({ ...created, replies: [] }));
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

// Phase 6: clients can delete their OWN comments while the album is still
// in review (unlocked). Top-level deletes cascade to its replies.
router.delete("/:albumId/comments/:commentId", async (req, res, next) => {
  try {
    const loaded = await loadClientAlbum(req, res);
    if (!loaded) return;
    if (!requireReviewOpen(loaded.album, res)) return;
    const comment = await prisma.albumComment.findFirst({
      where: { id: req.params.commentId, version: { albumId: loaded.album.id }, authorId: req.user.id },
    });
    if (!comment) return res.status(404).json({ error: "Comment not found" });
    await prisma.albumComment.delete({ where: { id: comment.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.post("/:albumId/request-changes", async (req, res, next) => {
  try {
    const loaded = await loadClientAlbum(req, res);
    if (!loaded) return;
    if (loaded.album.status !== "SENT") {
      return res.status(409).json({ error: `Changes can only be requested on a sent album (current: ${loaded.album.status}).` });
    }
    const { message } = req.body || {};
    const latest = loaded.album.versions.length
      ? loaded.album.versions.reduce((a, b) => (a.versionNumber >= b.versionNumber ? a : b))
      : null;
    // An optional note rides along as a general version comment so the
    // studio sees the reasoning next to the status flip.
    if (message && typeof message === "string" && message.trim() && latest) {
      try {
        await createComment({
          album: loaded.album,
          versionId: latest.id,
          pageId: null,
          parentId: null,
          xPct: null,
          yPct: null,
          message,
          authorId: req.user.id,
        });
      } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        throw err;
      }
    }
    const updated = await prisma.album.update({
      where: { id: loaded.album.id },
      data: { status: "CHANGES_REQUESTED" },
    });
    // Phase 7: best-effort studio notification (never fails the request).
    notifyOwner(loaded.event, loaded.album, "changes", {
      clientName: req.user.name || req.user.email,
      message: message && typeof message === "string" ? message.trim() : null,
    });
    res.json({ status: updated.status });
  } catch (err) {
    next(err);
  }
});

router.post("/:albumId/approve", async (req, res, next) => {
  try {
    const loaded = await loadClientAlbum(req, res);
    if (!loaded) return;
    if (loaded.album.status !== "SENT") {
      return res.status(409).json({ error: `Only a sent album can be approved (current: ${loaded.album.status}).` });
    }
    const updated = await prisma.album.update({
      where: { id: loaded.album.id },
      data: { status: "APPROVED", lockedAt: new Date() },
    });
    // Phase 7: best-effort studio notification (never fails the request).
    notifyOwner(loaded.event, loaded.album, "approved", {
      clientName: req.user.name || req.user.email,
    });
    res.json({ status: updated.status, locked_at: updated.lockedAt });
  } catch (err) {
    next(err);
  }
});

// Phase 7: the client's own proofing PDF — same lifecycle record the
// studio sees (title, event, revisions, comments with status, approval
// timestamp). Drafts stay invisible via loadClientAlbum.
router.get("/:albumId/proof.pdf", async (req, res, next) => {
  try {
    const loaded = await loadClientAlbum(req, res);
    if (!loaded) return;
    const detail = await albumDetail(loaded.event.id, loaded.album);
    const pdf = await buildAlbumProofPdf({
      event: loaded.event,
      album: detail,
      clients: [{ name: req.user.email, email: req.user.email }],
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${exportFilename(loaded.event.name, `${loaded.album.name}-proof`, "pdf")}"`
    );
    res.send(pdf);
  } catch (err) {
    console.error(`Album proof PDF failed (client album ${req.params.albumId}):`, err);
    if (!res.headersSent) res.status(500).json({ error: "Proof PDF failed — please try again." });
  }
});

export default router;
