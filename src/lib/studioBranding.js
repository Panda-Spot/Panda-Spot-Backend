import dns from "node:dns/promises";
import { randomBytes } from "node:crypto";
import { prisma } from "./prisma.js";

/// Gallery themes, studio subdomains, and custom domains (Phase 11).
/// Styling stays database-driven but injection-proof: themes carry only
/// validated tokens (hex colors, allowlisted fonts/enums) — never raw CSS.

export function baseDomain() {
  return (process.env.BASE_DOMAIN || "pandaspot.in").toLowerCase();
}

export function galleryCnameTarget() {
  return (process.env.GALLERY_CNAME_TARGET || `galleries.${baseDomain()}`).toLowerCase();
}

export const THEME_PRESETS = ["wedding", "corporate", "birthday", "minimal", "premium", "custom"];
export const THEME_FONTS = ["serif", "sans", "script-accent"];
export const THEME_BUTTONS = ["rounded", "pill", "square"];
export const THEME_LAYOUTS = ["grid", "masonry", "cinematic"];
export const THEME_WATERMARKS = ["text", "logo", "none"];

export const PRESET_THEMES = {
  wedding: {
    name: "Wedding",
    primaryColor: "#D4AF37",
    accentColor: "#B76E79",
    backgroundColor: "#0E0C09",
    textColor: "#F7F0E1",
    fontFamily: "serif",
    buttonStyle: "pill",
    galleryLayout: "masonry",
    watermarkStyle: "text",
  },
  corporate: {
    name: "Corporate",
    primaryColor: "#2563EB",
    accentColor: "#0EA5E9",
    backgroundColor: "#0B1220",
    textColor: "#F1F5F9",
    fontFamily: "sans",
    buttonStyle: "rounded",
    galleryLayout: "grid",
    watermarkStyle: "logo",
  },
  birthday: {
    name: "Birthday",
    primaryColor: "#EC4899",
    accentColor: "#F59E0B",
    backgroundColor: "#160A12",
    textColor: "#FDF2F8",
    fontFamily: "script-accent",
    buttonStyle: "pill",
    galleryLayout: "masonry",
    watermarkStyle: "text",
  },
  minimal: {
    name: "Minimal",
    primaryColor: "#E5E5E5",
    accentColor: "#A3A3A3",
    backgroundColor: "#0A0A0A",
    textColor: "#FAFAFA",
    fontFamily: "sans",
    buttonStyle: "square",
    galleryLayout: "grid",
    watermarkStyle: "none",
  },
  premium: {
    name: "Premium",
    primaryColor: "#C9A227",
    accentColor: "#6D28D9",
    backgroundColor: "#08070C",
    textColor: "#F5F1E8",
    fontFamily: "serif",
    buttonStyle: "pill",
    galleryLayout: "cinematic",
    watermarkStyle: "logo",
  },
};

export const DEFAULT_THEME = {
  id: "default",
  name: "PandaSpot default",
  preset: "custom",
  primaryColor: "#D4AF37",
  accentColor: "#D4AF37",
  backgroundColor: "#0A0A0B",
  textColor: "#F5F1E8",
  fontFamily: "sans",
  buttonStyle: "rounded",
  galleryLayout: "grid",
  watermarkStyle: "text",
  hidePandaSpotBrand: false,
  customShareCard: false,
  is_default: true,
};

const HEX_RE = /^#[0-9a-f]{6}$/i;

function bad(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/// Validates a theme create/patch body into Prisma data. Unknown keys
/// are ignored (never stored); invalid values 400.
export function sanitizeThemeInput(body = {}) {
  const data = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 80) {
      throw bad("name must be a non-empty string (max 80)");
    }
    data.name = body.name.trim();
  }
  if (body.preset !== undefined) {
    if (!THEME_PRESETS.includes(body.preset)) throw bad(`preset must be one of ${THEME_PRESETS.join(", ")}`);
    data.preset = body.preset;
  }
  for (const key of ["primary_color", "accent_color", "background_color", "text_color"]) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== "string" || !HEX_RE.test(body[key])) {
        throw bad(`${key} must be a hex color like #aa3bff`);
      }
      const field = { primary_color: "primaryColor", accent_color: "accentColor", background_color: "backgroundColor", text_color: "textColor" }[key];
      data[field] = body[key];
    }
  }
  if (body.font_family !== undefined) {
    if (!THEME_FONTS.includes(body.font_family)) throw bad(`font_family must be one of ${THEME_FONTS.join(", ")}`);
    data.fontFamily = body.font_family;
  }
  if (body.button_style !== undefined) {
    if (!THEME_BUTTONS.includes(body.button_style)) throw bad(`button_style must be one of ${THEME_BUTTONS.join(", ")}`);
    data.buttonStyle = body.button_style;
  }
  if (body.gallery_layout !== undefined) {
    if (!THEME_LAYOUTS.includes(body.gallery_layout)) throw bad(`gallery_layout must be one of ${THEME_LAYOUTS.join(", ")}`);
    data.galleryLayout = body.gallery_layout;
  }
  if (body.watermark_style !== undefined) {
    if (!THEME_WATERMARKS.includes(body.watermark_style)) throw bad(`watermark_style must be one of ${THEME_WATERMARKS.join(", ")}`);
    data.watermarkStyle = body.watermark_style;
  }
  if (body.hide_pandaspot_brand !== undefined) {
    if (typeof body.hide_pandaspot_brand !== "boolean") throw bad("hide_pandaspot_brand must be a boolean");
    data.hidePandaSpotBrand = body.hide_pandaspot_brand;
  }
  if (body.custom_share_card !== undefined) {
    if (typeof body.custom_share_card !== "boolean") throw bad("custom_share_card must be a boolean");
    data.customShareCard = body.custom_share_card;
  }
  return data;
}

export function themeShape(t) {
  if (!t) return null;
  return {
    id: t.id,
    name: t.name,
    preset: t.preset,
    primary_color: t.primaryColor,
    accent_color: t.accentColor,
    background_color: t.backgroundColor,
    text_color: t.textColor,
    font_family: t.fontFamily,
    button_style: t.buttonStyle,
    gallery_layout: t.galleryLayout,
    watermark_style: t.watermarkStyle,
    hide_pandaspot_brand: t.hidePandaSpotBrand,
    custom_share_card: t.customShareCard,
    is_default: false,
  };
}

/// Resolution order: event override → studio default → built-in default.
/// `event` must include galleryTheme + owner{defaultGalleryTheme}.
export function resolveThemeForEvent(event) {
  if (event?.galleryTheme) return { ...themeShape(event.galleryTheme), resolved_from: "event" };
  if (event?.owner?.defaultGalleryTheme) {
    return { ...themeShape(event.owner.defaultGalleryTheme), resolved_from: "studio" };
  }
  return { ...DEFAULT_THEME, resolved_from: "default" };
}

function normalizeHost(value) {
  return String(value || "").split(",")[0].trim().toLowerCase().split(":")[0];
}

export function slugifyStudio(name) {
  return (
    String(name || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "studio"
  );
}

/// Host → studio resolution. Order: verified custom domain row, then
/// <slug>.<base-domain> wildcard (plus <slug>.localhost for local dev).
/// Unknown hosts resolve to null and callers fall back to the default
/// theme — never an error, never a leak about which slugs exist beyond
/// the caller's own studio. Accepts prisma client override for tests.
export async function resolveHost(hostHeader, db = prisma) {
  const host = normalizeHost(hostHeader);
  if (!host) return { ownerId: null, via: null, host };
  const row = await db.studioDomain.findUnique({ where: { host } }).catch(() => null);
  if (row && row.status === "verified") {
    return { ownerId: row.ownerId, via: row.type === "CUSTOM_DOMAIN" ? "custom" : "subdomain", host, domain: row };
  }
  const base = baseDomain();
  const localSuffix = ".localhost";
  let slug = null;
  if (host.endsWith(`.${base}`)) {
    const left = host.slice(0, -(base.length + 1));
    if (left && !left.includes(".")) slug = left;
  } else if (host.endsWith(localSuffix)) {
    const left = host.slice(0, -localSuffix.length);
    if (left && !left.includes(".")) slug = left;
  }
  if (slug) {
    const user = await db.user.findUnique({ where: { studioSlug: slug }, select: { id: true } }).catch(() => null);
    if (user) return { ownerId: user.id, via: "subdomain", host };
  }
  return { ownerId: null, via: null, host };
}

/// DNS proof for a custom domain: TXT `pandaspot-verify=<token>` wins
/// (verified); otherwise a CNAME to the galleries target counts as
/// dns_ready (propagating). Anything else is failed with a reason.
export async function verifyDomainDns(domain) {
  const host = domain.host;
  try {
    const txts = await dns.resolveTxt(host).catch(() => []);
    const flat = txts.flat().map(String);
    if (domain.verificationToken && flat.includes(`pandaspot-verify=${domain.verificationToken}`)) {
      return { status: "verified", detail: "TXT verification record found." };
    }
  } catch {
    // No TXT records — fall through to the CNAME check.
  }
  try {
    const cnames = await dns.resolveCname(host).catch(() => []);
    if (cnames.map((c) => String(c).toLowerCase().replace(/\.$/, "")).includes(galleryCnameTarget())) {
      return { status: "dns_ready", detail: `CNAME points at ${galleryCnameTarget()} — add the TXT record to finish verification.` };
    }
  } catch {
    // No CNAME either.
  }
  return {
    status: "failed",
    detail: `Point a CNAME at ${galleryCnameTarget()} and add TXT "pandaspot-verify=${domain.verificationToken || "<token>"}".`,
  };
}

export function newVerificationToken() {
  return randomBytes(16).toString("hex");
}
