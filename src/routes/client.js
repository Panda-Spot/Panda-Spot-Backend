import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/role.js";

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
    include: { event: true },
  });
  if (!mapping) {
    res.status(404).json({ error: "You don't have access to this event" });
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
        .map((m) => ({
          event_id: m.event.id,
          event_name: m.event.name,
          favourite_cap: m.favouriteCap,
          submitted_at: m.submittedAt,
        }))
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
      where: { userId: req.user.id, photo: { eventId: mapping.eventId } },
    });

    res.json({
      event_id: mapping.event.id,
      event_name: mapping.event.name,
      favourite_cap: mapping.favouriteCap,
      favourite_count: favouriteCount,
      submitted_at: mapping.submittedAt,
      allow_download: mapping.event.allowDownload,
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
      where: { eventId: mapping.eventId, approvalStatus: "approved" },
      orderBy: { createdAt: "desc" },
      include: { clientFavourites: { where: { userId: req.user.id } } },
    });

    res.json(
      photos.map((p) => ({
        photo_id: p.id,
        filename: p.filename,
        createdAt: p.createdAt,
        url: `/files/events/${mapping.eventId}/photos/${p.id}`,
        thumbnail_url: `/files/events/${mapping.eventId}/photos/${p.id}/thumb`,
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

    const photo = await prisma.photo.findFirst({ where: { id: req.params.photoId, eventId: mapping.eventId } });
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
          where: { userId: req.user.id, photo: { eventId: mapping.eventId } },
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

export default router;
