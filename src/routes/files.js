import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { existsSync } from "../lib/storage.js";

const router = Router();

// Unauthenticated by design: photo/event IDs are UUIDs (not enumerable), and
// this mirrors the original spike's trust model — whoever has a photo URL
// (from an upload response or a search match) can view that one file.
router.get("/events/:eventId/photos/:photoId", async (req, res, next) => {
  try {
    const photo = await prisma.photo.findUnique({ where: { id: req.params.photoId } });
    if (!photo || photo.eventId !== req.params.eventId) {
      return res.status(404).json({ error: "Photo not found" });
    }
    if (!existsSync(photo.storagePath)) {
      return res.status(404).json({ error: "Photo file missing on disk" });
    }
    res.sendFile(photo.storagePath);
  } catch (err) {
    next(err);
  }
});

// Public by design: guests viewing an event's page need to see the
// photographer's studio branding without logging in.
router.get("/branding/:userId/logo", async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!user || !user.logoPath) {
      return res.status(404).json({ error: "No logo set" });
    }
    if (!existsSync(user.logoPath)) {
      return res.status(404).json({ error: "Logo file missing on disk" });
    }
    res.sendFile(user.logoPath);
  } catch (err) {
    next(err);
  }
});

export default router;
