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
const MIN_WATERMARK_INTENSITY = 0;
const MAX_WATERMARK_INTENSITY = 1;

function normalizeWatermarkIntensity(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < MIN_WATERMARK_INTENSITY || numeric > MAX_WATERMARK_INTENSITY) {
    throw new Error("watermark_intensity must be between 0 and 1");
  }
  return numeric;
}

function brandingResponse(user) {
  return {
    studio_name: user.studioName ?? null,
    logo_url: user.logoPath ? `/files/branding/${user.id}/logo` : null,
    brand_color: user.brandColor ?? null,
    watermark_intensity: user.watermarkIntensity ?? 0.75,
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
    const { studio_name, brand_color, watermark_intensity } = req.body || {};

    if (brand_color !== undefined && brand_color !== null && brand_color !== "" && !HEX_COLOR_RE.test(brand_color)) {
      return res.status(400).json({ error: "brand_color must be a hex color like #aa3bff" });
    }
    const normalizedWatermarkIntensity = normalizeWatermarkIntensity(watermark_intensity);

    const data = {};
    if (studio_name !== undefined) data.studioName = studio_name;
    if (brand_color !== undefined) data.brandColor = brand_color || null;
    if (normalizedWatermarkIntensity !== undefined) data.watermarkIntensity = normalizedWatermarkIntensity;

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
    if (err.message?.startsWith("watermark_intensity")) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

// MERGE (Studio-Verse tenant profile, Phase 18H): contact/address details
// backing the Studio Profile page's contact section — the equivalent of
// Studio-Verse's tenant_phone_number / tenant_studio_address. Lazily
// created so older accounts get a row on first read.

function profileResponse(row) {
  return {
    phone: row?.phone ?? null,
    studio_address: row?.studioAddress ?? null,
  };
}

router.get("/profile", async (req, res, next) => {
  try {
    const row = await prisma.tenantProfile.upsert({
      where: { tenantId: req.user.id },
      create: { tenantId: req.user.id },
      update: {},
    });
    res.json(profileResponse(row));
  } catch (err) {
    next(err);
  }
});

router.patch("/profile", async (req, res, next) => {
  try {
    const { phone, studio_address: studioAddress } = req.body || {};
    const data = {};
    if (phone !== undefined) {
      if (phone !== null && (typeof phone !== "string" || phone.trim() === "")) {
        return res.status(400).json({ error: "phone must be a non-empty string, or null to clear" });
      }
      data.phone = phone === null ? null : phone.trim().slice(0, 30);
    }
    if (studioAddress !== undefined) {
      if (studioAddress !== null && (typeof studioAddress !== "string" || studioAddress.trim() === "")) {
        return res.status(400).json({ error: "studio_address must be a non-empty string, or null to clear" });
      }
      data.studioAddress = studioAddress === null ? null : studioAddress.trim().slice(0, 500);
    }
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: "No profile change provided." });
    }
    const row = await prisma.tenantProfile.upsert({
      where: { tenantId: req.user.id },
      create: { tenantId: req.user.id, ...data },
      update: data,
    });
    res.json(profileResponse(row));
  } catch (err) {
    next(err);
  }
});

export default router;
