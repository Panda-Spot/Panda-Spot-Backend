import { Router } from "express";
import path from "node:path";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";
import { IMAGE_EXTENSIONS, deleteFileIfExists, saveBrandingLogo, saveBrandingWatermark } from "../lib/storage.js";
import { contentMatchesExtension } from "../lib/fileValidation.js";
import {
  PRESET_THEMES,
  THEME_PRESETS,
  baseDomain,
  galleryCnameTarget,
  newVerificationToken,
  resolveHost,
  resolveThemeForEvent,
  sanitizeThemeInput,
  slugifyStudio,
  themeShape,
  verifyDomainDns,
} from "../lib/studioBranding.js";

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
    watermark_image_url: user.watermarkImagePath ? `/files/branding/${user.id}/watermark` : null,
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

router.post("/", upload.fields([{ name: "logo", maxCount: 1 }, { name: "watermark", maxCount: 1 }]), async (req, res, next) => {
  try {
    const { studio_name, brand_color, watermark_intensity, remove_watermark } = req.body || {};

    if (brand_color !== undefined && brand_color !== null && brand_color !== "" && !HEX_COLOR_RE.test(brand_color)) {
      return res.status(400).json({ error: "brand_color must be a hex color like #aa3bff" });
    }
    const normalizedWatermarkIntensity = normalizeWatermarkIntensity(watermark_intensity);

    const data = {};
    if (studio_name !== undefined) data.studioName = studio_name;
    if (brand_color !== undefined) data.brandColor = brand_color || null;
    if (normalizedWatermarkIntensity !== undefined) data.watermarkIntensity = normalizedWatermarkIntensity;

    const logoFile = req.files?.logo?.[0];
    if (logoFile) {
      const ext = path.extname(logoFile.originalname).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(ext)) {
        return res.status(400).json({ error: "Unsupported logo file type" });
      }
      if (!contentMatchesExtension(logoFile.buffer, ext)) {
        return res.status(400).json({ error: "File content doesn't match its extension" });
      }
      const logoPath = await saveBrandingLogo(req.user.id, logoFile.originalname, logoFile.buffer);
      data.logoPath = logoPath;
    }

    const watermarkFile = req.files?.watermark?.[0];
    if (watermarkFile) {
      const ext = path.extname(watermarkFile.originalname).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(ext)) {
        return res.status(400).json({ error: "Unsupported watermark file type" });
      }
      if (!contentMatchesExtension(watermarkFile.buffer, ext)) {
        return res.status(400).json({ error: "File content doesn't match its extension" });
      }
      const watermarkPath = await saveBrandingWatermark(req.user.id, watermarkFile.originalname, watermarkFile.buffer);
      data.watermarkImagePath = watermarkPath;
    } else if (remove_watermark === "true" || remove_watermark === true) {
      const current = await prisma.user.findUnique({ where: { id: req.user.id }, select: { watermarkImagePath: true } });
      if (current?.watermarkImagePath) {
        await deleteFileIfExists(current.watermarkImagePath);
      }
      data.watermarkImagePath = null;
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

// --- Gallery themes (Phase 11) ---
// Own themes plus the built-in preset catalog. Theme styling is
// validated tokens only (see lib/studioBranding.js) — never raw CSS.

router.get("/themes", async (req, res, next) => {
  try {
    const themes = await prisma.galleryTheme.findMany({
      where: { ownerId: req.user.id },
      orderBy: { createdAt: "desc" },
    });
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { defaultGalleryThemeId: true } });
    res.json({
      presets: PRESET_THEMES,
      default_theme_id: user?.defaultGalleryThemeId || null,
      themes: themes.map(themeShape),
    });
  } catch (err) {
    next(err);
  }
});

// Create from scratch or from a preset name (tokens prefilled, then
// overridable in the same call).
router.post("/themes", async (req, res, next) => {
  try {
    const { preset, ...rest } = req.body || {};
    let seed = {};
    if (preset !== undefined) {
      if (!THEME_PRESETS.includes(preset) || preset === "custom") {
        return res.status(400).json({ error: `preset must be one of ${THEME_PRESETS.filter((p) => p !== "custom").join(", ")}` });
      }
      seed = { ...PRESET_THEMES[preset], preset };
    }
    let data;
    try {
      data = sanitizeThemeInput({ name: rest.name || seed.name || "Untitled theme", ...seed, ...rest });
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }
    if (!data.name) return res.status(400).json({ error: "name is required" });
    const theme = await prisma.galleryTheme.create({ data: { ...data, ownerId: req.user.id } });
    res.status(201).json(themeShape(theme));
  } catch (err) {
    next(err);
  }
});

router.patch("/themes/:id", async (req, res, next) => {
  try {
    const theme = await prisma.galleryTheme.findFirst({ where: { id: req.params.id, ownerId: req.user.id } });
    if (!theme) return res.status(404).json({ error: "Theme not found" });
    let data;
    try {
      data = sanitizeThemeInput(req.body || {});
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: "No theme change provided." });
    }
    const updated = await prisma.galleryTheme.update({ where: { id: theme.id }, data });
    res.json(themeShape(updated));
  } catch (err) {
    next(err);
  }
});

router.delete("/themes/:id", async (req, res, next) => {
  try {
    const theme = await prisma.galleryTheme.findFirst({ where: { id: req.params.id, ownerId: req.user.id } });
    if (!theme) return res.status(404).json({ error: "Theme not found" });
    // Events using it fall back via SetNull; clear the studio default too.
    await prisma.user.updateMany({ where: { id: req.user.id, defaultGalleryThemeId: theme.id }, data: { defaultGalleryThemeId: null } });
    await prisma.galleryTheme.delete({ where: { id: theme.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Studio-wide default (or null to go back to built-in). Must be own theme.
router.post("/themes/default", async (req, res, next) => {
  try {
    const { theme_id: themeId } = req.body || {};
    if (themeId !== null && typeof themeId !== "string") {
      return res.status(400).json({ error: "theme_id must be a theme id, or null to clear" });
    }
    if (themeId) {
      const theme = await prisma.galleryTheme.findFirst({ where: { id: themeId, ownerId: req.user.id } });
      if (!theme) return res.status(404).json({ error: "Theme not found" });
    }
    await prisma.user.update({ where: { id: req.user.id }, data: { defaultGalleryThemeId: themeId } });
    res.json({ default_theme_id: themeId });
  } catch (err) {
    next(err);
  }
});

// --- Subdomain + custom domains (Phase 11) ---

function domainShape(d) {
  return {
    id: d.id,
    host: d.host,
    type: d.type,
    status: d.status,
    verified_at: d.verifiedAt,
    created_at: d.createdAt,
  };
}

router.get("/domains", async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    const domains = await prisma.studioDomain.findMany({
      where: { ownerId: req.user.id },
      orderBy: { createdAt: "desc" },
    });
    res.json({
      base_domain: baseDomain(),
      studio_slug: user?.studioSlug || null,
      studio_url: user?.studioSlug ? `https://${user.studioSlug}.${baseDomain()}` : null,
      domains: domains.map(domainShape),
      dns_help: {
        cname_target: galleryCnameTarget(),
        txt_name: "@ (root) or as shown by your DNS provider",
      },
    });
  } catch (err) {
    next(err);
  }
});

// Claim <slug>.<base-domain>. One active slug per studio — reclaiming
// replaces the old host. Instantly verified: we own the wildcard DNS.
router.post("/subdomain", async (req, res, next) => {
  try {
    const { slug } = req.body || {};
    if (typeof slug !== "string") {
      return res.status(400).json({ error: "slug is required" });
    }
    const clean = slugifyStudio(slug);
    if (clean.length < 3 || !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(clean)) {
      return res.status(400).json({ error: "slug must be 3+ characters: letters, numbers, dashes" });
    }
    const host = `${clean}.${baseDomain()}`;
    const taken = await prisma.user.findFirst({ where: { studioSlug: clean, id: { not: req.user.id } } });
    if (taken) return res.status(409).json({ error: "That studio address is already taken." });
    const hostTaken = await prisma.studioDomain.findFirst({ where: { host, ownerId: { not: req.user.id } } });
    if (hostTaken) return res.status(409).json({ error: "That studio address is already taken." });
    await prisma.studioDomain.deleteMany({ where: { ownerId: req.user.id, type: "PANDA_SUBDOMAIN" } });
    const domain = await prisma.studioDomain.create({
      data: { host, type: "PANDA_SUBDOMAIN", ownerId: req.user.id, status: "verified", verifiedAt: new Date() },
    });
    await prisma.user.update({ where: { id: req.user.id }, data: { studioSlug: clean } });
    res.status(201).json({ ...domainShape(domain), studio_url: `https://${host}` });
  } catch (err) {
    next(err);
  }
});

// Register a studio-owned custom domain. Verification happens via
// POST /branding/domains/:id/verify once DNS is pointed.
router.post("/domains", async (req, res, next) => {
  try {
    const { host } = req.body || {};
    if (typeof host !== "string" || !host.trim()) {
      return res.status(400).json({ error: "host is required" });
    }
    let clean = host.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].split(":")[0];
    if (!/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(clean) || clean.length > 253) {
      return res.status(400).json({ error: "host must be a valid domain like gallery.yourstudio.com" });
    }
    if (clean === baseDomain() || clean.endsWith(`.${baseDomain()}`)) {
      return res.status(400).json({ error: "PandaSpot subdomains use the studio-address flow instead." });
    }
    const taken = await prisma.studioDomain.findFirst({ where: { host: clean } });
    if (taken) {
      return res.status(taken.ownerId === req.user.id ? 200 : 409).json(
        taken.ownerId === req.user.id
          ? domainShape(taken)
          : { error: "That domain is already registered." }
      );
    }
    const domain = await prisma.studioDomain.create({
      data: {
        host: clean,
        type: "CUSTOM_DOMAIN",
        ownerId: req.user.id,
        status: "pending",
        verificationToken: newVerificationToken(),
      },
    });
    res.status(201).json({
      ...domainShape(domain),
      verification_token: domain.verificationToken,
      dns_help: {
        cname: { host: clean, points_to: galleryCnameTarget() },
        txt: { host: clean, value: `pandaspot-verify=${domain.verificationToken}` },
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post("/domains/:id/verify", async (req, res, next) => {
  try {
    const domain = await prisma.studioDomain.findFirst({ where: { id: req.params.id, ownerId: req.user.id } });
    if (!domain) return res.status(404).json({ error: "Domain not found" });
    if (domain.type !== "CUSTOM_DOMAIN") {
      return res.status(400).json({ error: "PandaSpot subdomains are verified automatically." });
    }
    const result = await verifyDomainDns(domain);
    const data = { status: result.status };
    if (result.status === "verified") data.verifiedAt = new Date();
    const updated = await prisma.studioDomain.update({ where: { id: domain.id }, data });
    res.json({ ...domainShape(updated), detail: result.detail });
  } catch (err) {
    next(err);
  }
});

router.delete("/domains/:id", async (req, res, next) => {
  try {
    const domain = await prisma.studioDomain.findFirst({ where: { id: req.params.id, ownerId: req.user.id } });
    if (!domain) return res.status(404).json({ error: "Domain not found" });
    if (domain.type === "PANDA_SUBDOMAIN") {
      await prisma.user.update({ where: { id: req.user.id }, data: { studioSlug: null } });
    }
    await prisma.studioDomain.delete({ where: { id: domain.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Debug/introspection for the studio: which host the platform sees for
// them (proxies may rewrite it — see x-forwarded-host support).
router.get("/resolve-host", async (req, res, next) => {
  try {
    const host = req.get("x-forwarded-host") || req.get("host");
    res.json(await resolveHost(host));
  } catch (err) {
    next(err);
  }
});

export default router;
