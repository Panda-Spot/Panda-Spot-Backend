import { Router } from "express";
import path from "node:path";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";
import { ALLOWED_EXTENSIONS, saveBrandingLogo } from "../lib/storage.js";
import { contentMatchesExtension } from "../lib/fileValidation.js";

const router = Router();

router.use(requireAuth);

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

function brandingResponse(user) {
  return {
    studio_name: user.studioName ?? null,
    logo_url: user.logoPath ? `/files/branding/${user.id}/logo` : null,
    brand_color: user.brandColor ?? null,
  };
}

router.get("/", async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    res.json(brandingResponse(user));
  } catch (err) {
    next(err);
  }
});

router.post("/", upload.single("logo"), async (req, res, next) => {
  try {
    const { studio_name, brand_color } = req.body || {};

    if (brand_color !== undefined && brand_color !== null && brand_color !== "" && !HEX_COLOR_RE.test(brand_color)) {
      return res.status(400).json({ error: "brand_color must be a hex color like #aa3bff" });
    }

    const data = {};
    if (studio_name !== undefined) data.studioName = studio_name;
    if (brand_color !== undefined) data.brandColor = brand_color || null;

    if (req.file) {
      const ext = path.extname(req.file.originalname).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        return res.status(400).json({ error: "Unsupported logo file type" });
      }
      if (!contentMatchesExtension(req.file.buffer, ext)) {
        return res.status(400).json({ error: "File content doesn't match its extension" });
      }
      const logoPath = await saveBrandingLogo(req.user.id, req.file.originalname, req.file.buffer);
      data.logoPath = logoPath;
    }

    const user = await prisma.user.update({ where: { id: req.user.id }, data });
    res.json(brandingResponse(user));
  } catch (err) {
    next(err);
  }
});

export default router;
