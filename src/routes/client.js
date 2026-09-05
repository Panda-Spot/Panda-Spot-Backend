import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/role.js";
import { signMediaToken } from "../lib/mediaTokens.js";
import { resolveThemeForEvent } from "../lib/studioBranding.js";
import { streamPhotosZip, zipFilenameForEvent } from "../lib/zip.js";
import {
  buildProofingPdf,
  buildSelectionCsv,
  buildSelectionTxt,
  exportFilename,
  resolveSelection,
} from "../lib/selectionExport.js";

const router = Router();

/// MERGE (Studio-Verse Photo Selection): every route here is a logged-in
/// USER-role client browsing/favouriting ONE event they've been granted
/// access to via EventUserMapping (see routes/clientInvites.js for how
/// that access is granted) — the client-facing counterpart to
/// routes/events.js (the studio side) and routes/guest.js (the anonymous
/// Face Search side). See MERGE_PLAN.md D6/§1: Photo Selection is
/// independent of Face Search and always requires a real login.
router.use(requireAuth, requireRole("USER"));

async function loadClientAccess(req, res) {
  const mapping = await prisma.eventUserMapping.findUnique({
    where: { eventId_userId: { eventId: req.params.id, userId: req.user.id } },
    include: {
      event: {
        include: {
          owner: {
            select: {
              studioName: true,
              watermarkIntensity: true,
              brandColor: true,
              watermarkImagePath: true,
              defaultGalleryTheme: true,
            },
          },
          galleryTheme: true,
        },
      },
    },
  });
  if (!mapping) {
    res.status(404).json({ error: "You don't have access to this event" });
    return null;
  }
  // MERGE (Studio-Verse revoke/expiry/archive, Phase 18E+18F): a revoked
  // grant, a past access_expires, or an archived event all read as "no
  // access" — but unlike a never-granted event, the response names the
  // event and the reason so the client app can render its Access Expired
  // screen instead of a generic 404. Safe: UUIDs aren't enumerable, and
  // every one of these clients was explicitly granted this event before.
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
  if (!mapping.event.photoSelectionEnabled) {
    res.status(403).json({ error: "Photo Selection isn't turned on for this event." });
    return null;
  }
  return mapping;
}

router.get("/events", async (req, res, next) => {
  try {
    const mappings = await prisma.eventUserMapping.findMany({
      where: { userId: req.user.id },
      include: { event: true },
      orderBy: { createdAt: "desc" },
    });
    res.json(
      mappings
        .filter((m) => m.event.photoSelectionEnabled)
        .map((m) => {
          // MERGE (Studio-Verse folder grid, Phase 18F): revoked/expired/
          // archived grants stay visible with accessible:false + a reason
          // (lock overlay + Access Expired screen) instead of vanishing —
          // the client was explicitly granted each of these before.
          const revoked = !!m.revokedAt;
          const expired = !!m.accessExpires && new Date(m.accessExpires) < new Date();
          const archived = !!m.event.archivedAt;
          return {
            event_id: m.event.id,
            event_name: m.event.name,
            event_date: m.event.eventDate,
            cover_url: m.event.coverPhotoPath ? `/files/events/${m.event.id}/cover` : null,
            favourite_cap: m.favouriteCap,
            submitted_at: m.submittedAt,
            access_expires: m.accessExpires,
            accessible: !revoked && !expired && !archived,
            reason: revoked ? "revoked" : expired ? "expired" : archived ? "archived" : null,
          };
        })
    );
  } catch (err) {
    next(err);
  }
});

router.get("/events/:id", async (req, res, next) => {
  try {
    const mapping = await loadClientAccess(req, res);
    if (!mapping) return;

    const favouriteCount = await prisma.clientFavourite.count({
      where: { userId: req.user.id, photo: { eventId: mapping.eventId, photoSelectionVisible: true, archivedAt: null } },
    });

    res.json({
      event_id: mapping.event.id,
      event_name: mapping.event.name,
      event_date: mapping.event.eventDate,
      cover_url: mapping.event.coverPhotoPath ? `/files/events/${mapping.event.id}/cover` : null,
      favourite_cap: mapping.favouriteCap,
      favourite_count: favouriteCount,
      submitted_at: mapping.submittedAt,
      access_expires: mapping.accessExpires,
      published_at: mapping.event.publishedAt,
      allow_download: mapping.event.allowDownload,
      // Brand equivalents of the public guest lookup's studio fields (same
      // values, no extra leak) — drive the gallery's brand re-theming.
      brand_color: mapping.event.owner?.brandColor ?? null,
      logo_url: `/files/branding/${mapping.event.ownerId}/logo`,
      watermark_text: mapping.event.owner?.studioName || mapping.event.name,
      watermark_intensity: mapping.event.owner?.watermarkIntensity ?? 0.75,
      watermark_image_url: mapping.event.owner?.watermarkImagePath
        ? `/files/branding/${mapping.event.ownerId}/watermark`
        : null,
      // Phase 11: same theme resolution as the public gallery.
      theme: resolveThemeForEvent(mapping.event),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/events/:id/photos", async (req, res, next) => {
  try {
    const mapping = await loadClientAccess(req, res);
    if (!mapping) return;

    const photos = await prisma.photo.findMany({
      where: { eventId: mapping.eventId, approvalStatus: "approved", photoSelectionVisible: true, archivedAt: null },
      orderBy: { createdAt: "desc" },
      include: { clientFavourites: { where: { userId: req.user.id } } },
    });

    res.json(
      photos.map((p) => ({
        photo_id: p.id,
        filename: p.filename,
        createdAt: p.createdAt,
        protected_url: `/files/protected/media/${signMediaToken({ eventId: mapping.eventId, photoId: p.id })}`,
        protected_thumbnail_url: `/files/protected/media/${signMediaToken({ eventId: mapping.eventId, photoId: p.id, variant: "thumb" })}`,
        is_favourite: p.clientFavourites.length > 0,
      }))
    );
  } catch (err) {
    next(err);
  }
});

// MERGE (Studio-Verse): reproduces the favourite-cap + one-way-submit-lock
// behavior exactly — see the EventUserMapping model's own comment.
router.post("/events/:id/photos/:photoId/favourite", async (req, res, next) => {
  try {
    const mapping = await loadClientAccess(req, res);
    if (!mapping) return;
    if (mapping.submittedAt) {
      return res.status(403).json({ error: "Your selection is already submitted and can't be changed." });
    }

    const photo = await prisma.photo.findFirst({
      where: { id: req.params.photoId, eventId: mapping.eventId, photoSelectionVisible: true, archivedAt: null },
    });
    if (!photo) {
      return res.status(404).json({ error: "Photo not found" });
    }

    const { favourite } = req.body || {};
    const existing = await prisma.clientFavourite.findUnique({
      where: { photoId_userId: { photoId: photo.id, userId: req.user.id } },
    });

    if (favourite) {
      if (existing) {
        return res.json({ is_favourite: true });
      }
      if (mapping.favouriteCap != null) {
        const count = await prisma.clientFavourite.count({
          where: { userId: req.user.id, photo: { eventId: mapping.eventId, photoSelectionVisible: true, archivedAt: null } },
        });
        if (count >= mapping.favouriteCap) {
          return res.status(400).json({ error: `You can favourite up to ${mapping.favouriteCap} photos.` });
        }
      }
      await prisma.clientFavourite.create({ data: { photoId: photo.id, userId: req.user.id } });
      return res.json({ is_favourite: true });
    }

    if (existing) {
      await prisma.clientFavourite.delete({ where: { id: existing.id } });
    }
    res.json({ is_favourite: false });
  } catch (err) {
    next(err);
  }
});

// One-way — matches Studio-Verse's submit-lock exactly (no "unsubmit").
router.post("/events/:id/submit", async (req, res, next) => {
  try {
    const mapping = await loadClientAccess(req, res);
    if (!mapping) return;
    if (mapping.submittedAt) {
      return res.json({ submitted_at: mapping.submittedAt });
    }
    const updated = await prisma.eventUserMapping.update({
      where: { id: mapping.id },
      data: { submittedAt: new Date() },
    });
    res.json({ submitted_at: updated.submittedAt });
  } catch (err) {
    next(err);
  }
});

// MERGE (Studio-Verse Studio Pick indicator, Phase 18F): the photo ids the
// studio itself picked on this event — shown as a distinct badge so
// clients can see what the photographer already favourited. Ids only;
// every one of these photos is already visible to this client.
router.get("/events/:id/studio-pick-ids", async (req, res, next) => {
  try {
    const mapping = await loadClientAccess(req, res);
    if (!mapping) return;

    const picks = await prisma.studioFavourite.findMany({
      where: { userId: mapping.event.ownerId, photo: { eventId: mapping.eventId, archivedAt: null } },
      select: { photoId: true },
    });
    res.json({ photo_ids: picks.map((p) => p.photoId) });
  } catch (err) {
    next(err);
  }
});

// MERGE (Selection export, Phase 1): the client's own picked filenames
// as CSV/TXT plus a branded proofing PDF of their selection — only when
// the studio allows downloads (same allow_download gate as the
// favourites zip below). Submitted or not, the record exports either way.
async function loadSelfSelection(req, res) {
  const mapping = await loadClientAccess(req, res);
  if (!mapping) return null;
  if (!mapping.event.allowDownload) {
    res.status(403).json({ error: "Downloads are disabled for this event by the studio." });
    return null;
  }
  try {
    return await resolveSelection({ eventId: mapping.eventId, selfUserId: req.user.id });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Could not resolve selection" });
    return null;
  }
}

router.get("/events/:id/selection/export.csv", async (req, res) => {
  const selection = await loadSelfSelection(req, res);
  if (!selection) return;
  try {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${exportFilename(selection.event.name, "my-selection", "csv")}"`
    );
    res.send(buildSelectionCsv(selection));
  } catch (err) {
    console.error(`Selection export failed (client csv event=${req.params.id} user=${req.user.id}):`, err);
    if (!res.headersSent) res.status(500).json({ error: "Export failed — please try again." });
  }
});

router.get("/events/:id/selection/export.txt", async (req, res) => {
  const selection = await loadSelfSelection(req, res);
  if (!selection) return;
  try {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${exportFilename(selection.event.name, "my-selection", "txt")}"`
    );
    res.send(buildSelectionTxt(selection));
  } catch (err) {
    console.error(`Selection export failed (client txt event=${req.params.id} user=${req.user.id}):`, err);
    if (!res.headersSent) res.status(500).json({ error: "Export failed — please try again." });
  }
});

router.get("/events/:id/selection/report.pdf", async (req, res) => {
  const selection = await loadSelfSelection(req, res);
  if (!selection) return;
  try {
    const u = selection.clients[0]?.user;
    const pdf = await buildProofingPdf({
      ...selection,
      scopeLabel: `${u?.name || "Client"} (${u?.email || "?"})`,
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${exportFilename(selection.event.name, "my-selection", "pdf")}"`
    );
    res.send(pdf);
  } catch (err) {
    console.error(`Selection export failed (client pdf event=${req.params.id} user=${req.user.id}):`, err);
    if (!res.headersSent) res.status(500).json({ error: "Export failed — please try again." });
  }
});

// MERGE (Studio-Verse favourites zip, Phase 18F): the client's own
// favourited photos as one zip. Honors the studio's allow_download
// opt-out exactly like the guest zip does.
router.post("/events/:id/download-zip", async (req, res, next) => {
  try {
    const mapping = await loadClientAccess(req, res);
    if (!mapping) return;
    if (!mapping.event.allowDownload) {
      return res.status(403).json({ error: "Downloads are disabled for this event by the studio." });
    }

    const favourites = await prisma.clientFavourite.findMany({
      where: {
        userId: req.user.id,
        photo: { eventId: mapping.eventId, approvalStatus: "approved", photoSelectionVisible: true, archivedAt: null },
      },
      include: { photo: true },
      orderBy: { createdAt: "asc" },
    });
    const photos = favourites.map((f) => f.photo);
    if (photos.length === 0) {
      return res.status(404).json({ error: "You have no favourite photos to download yet" });
    }

    const zipFilename = zipFilenameForEvent(mapping.event);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipFilename}"`);

    await streamPhotosZip(photos, res);
  } catch (err) {
    next(err);
  }
});

// --- Studio suite: contracts + questionnaires (Phase 12) ---
// Assignment matching is by email OR user id — whichever the studio set.

function clientContractVisible(contract, user) {
  if (!contract) return false;
  if (contract.clientUserId && contract.clientUserId === user.id) return true;
  if (contract.clientEmail && contract.clientEmail.toLowerCase() === (user.email || "").toLowerCase()) return true;
  return false;
}

router.get("/contracts", async (req, res, next) => {
  try {
    const email = (req.user.email || "").toLowerCase();
    const rows = await prisma.clientContract.findMany({
      where: { OR: [{ clientUserId: req.user.id }, ...(email ? [{ clientEmail: email }] : [])] },
      include: { template: { select: { name: true } }, event: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json(
      rows.map((c) => ({
        id: c.id,
        template_name: c.template?.name || null,
        event: c.event,
        status: c.status,
        signature_name: c.signatureName,
        accepted_at: c.acceptedAt,
        created_at: c.createdAt,
      }))
    );
  } catch (err) {
    next(err);
  }
});

router.get("/contracts/:id", async (req, res, next) => {
  try {
    const contract = await prisma.clientContract.findUnique({
      where: { id: req.params.id },
      include: { template: { select: { name: true } }, event: { select: { id: true, name: true } } },
    });
    if (!contract || !clientContractVisible(contract, req.user)) {
      return res.status(404).json({ error: "Contract not found" });
    }
    res.json({
      id: contract.id,
      template_name: contract.template?.name || null,
      event: contract.event,
      status: contract.status,
      signature_name: contract.signatureName,
      accepted_at: contract.acceptedAt,
      created_at: contract.createdAt,
      file_url: contract.templateId ? `/client/contracts/${contract.id}/file` : null,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/contracts/:id/file", async (req, res, next) => {
  try {
    const contract = await prisma.clientContract.findUnique({
      where: { id: req.params.id },
      include: { template: true },
    });
    if (!contract || !clientContractVisible(contract, req.user)) {
      return res.status(404).json({ error: "Contract not found" });
    }
    if (!contract.template?.filePath) {
      return res.status(404).json({ error: "Contract file not available" });
    }
    const { existsSync } = await import("../lib/storage.js");
    if (!existsSync(contract.template.filePath)) {
      return res.status(404).json({ error: "Contract file missing" });
    }
    res.setHeader("Content-Type", "application/pdf");
    res.sendFile(contract.template.filePath);
  } catch (err) {
    next(err);
  }
});

// Checkbox foundation for signing: name + timestamp. E-signature
// providers slot in later without changing this contract.
router.post("/contracts/:id/accept", async (req, res, next) => {
  try {
    const contract = await prisma.clientContract.findUnique({ where: { id: req.params.id } });
    if (!contract || !clientContractVisible(contract, req.user)) {
      return res.status(404).json({ error: "Contract not found" });
    }
    if (contract.status === "signed") {
      return res.json({ id: contract.id, status: contract.status, accepted_at: contract.acceptedAt });
    }
    const { name } = req.body || {};
    if (!name || typeof name !== "string" || !name.trim() || name.length > 120) {
      return res.status(400).json({ error: "Please type your full name to accept" });
    }
    const updated = await prisma.clientContract.update({
      where: { id: contract.id },
      data: { status: "signed", signatureName: name.trim(), acceptedAt: new Date() },
    });
    res.json({ id: updated.id, status: updated.status, accepted_at: updated.acceptedAt });
  } catch (err) {
    next(err);
  }
});

router.get("/questionnaires", async (req, res, next) => {
  try {
    const email = (req.user.email || "").toLowerCase();
    const rows = await prisma.questionnaireAssignment.findMany({
      where: {
        OR: [{ clientUserId: req.user.id }, ...(email ? [{ clientEmail: email }] : [])],
      },
      include: {
        questionnaire: true,
        event: { select: { id: true, name: true } },
        response: true,
      },
      orderBy: { createdAt: "desc" },
    });
    res.json(
      rows.map((a) => ({
        assignment_id: a.id,
        questionnaire: { id: a.questionnaire.id, title: a.questionnaire.title, questions: a.questionnaire.questions },
        event: a.event,
        submitted: !!a.response,
        submitted_at: a.response?.submittedAt || null,
        answers: a.response?.answers || null,
      }))
    );
  } catch (err) {
    next(err);
  }
});

router.post("/questionnaires/:assignmentId/respond", async (req, res, next) => {
  try {
    const assignment = await prisma.questionnaireAssignment.findUnique({
      where: { id: req.params.assignmentId },
      include: { questionnaire: true },
    });
    if (!assignment) return res.status(404).json({ error: "Questionnaire not found" });
    const email = (req.user.email || "").toLowerCase();
    const mine =
      (assignment.clientUserId && assignment.clientUserId === req.user.id) ||
      (assignment.clientEmail && assignment.clientEmail.toLowerCase() === email);
    if (!mine) return res.status(404).json({ error: "Questionnaire not found" });
    if (!assignment.questionnaire.active) {
      return res.status(409).json({ error: "This questionnaire is closed." });
    }
    const { answers } = req.body || {};
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
      return res.status(400).json({ error: "answers must be an object keyed by question id" });
    }
    const questions = Array.isArray(assignment.questionnaire.questions) ? assignment.questionnaire.questions : [];
    const ids = new Set(questions.map((q) => q.id));
    for (const [qid, answer] of Object.entries(answers)) {
      if (!ids.has(qid)) return res.status(400).json({ error: `Unknown question: ${qid}` });
      if (answer !== null && typeof answer !== "string" && !Array.isArray(answer)) {
        return res.status(400).json({ error: `Answer for ${qid} must be text or a list` });
      }
      if (typeof answer === "string" && answer.length > 5000) {
        return res.status(400).json({ error: `Answer for ${qid} is too long` });
      }
    }
    const saved = await prisma.questionnaireResponse.upsert({
      where: { assignmentId: assignment.id },
      create: { assignmentId: assignment.id, answers },
      update: { answers, submittedAt: new Date() },
    });
    res.status(201).json({ submitted_at: saved.submittedAt });
  } catch (err) {
    next(err);
  }
});

export default router;
