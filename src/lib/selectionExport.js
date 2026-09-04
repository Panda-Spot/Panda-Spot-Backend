import path from "node:path";
import PDFDocument from "pdfkit";
import { prisma } from "./prisma.js";
import { existsSync } from "./storage.js";

/// Shared selection-export builders (Phase 1: Selection Export And
/// Proofing Reports). Photo Selection's source of truth is ClientFavourite
/// rows; this module resolves them into per-client selections and renders
/// CSV / TXT / proofing-PDF from the same data, so the studio routes, the
/// client self-service routes, and any future audit views can't drift.
///
/// Visibility rule (mirrors GET /:id/favourites): only photos the client
/// could actually see — photoSelectionVisible + not archived. Approval is
/// deliberately NOT filtered: the export is a record of what was picked,
/// not a delivery channel (zips already enforce their own rules).

const VISIBLE_PHOTO = { photoSelectionVisible: true, archivedAt: null };

function slug(value, fallback) {
  const s = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || fallback;
}

/// Content-Disposition-safe download name:
/// "<event>-<label>-<yyyymmdd>.<ext>". Label is typically the client's
/// name/email slug or "all-clients".
export function exportFilename(eventName, label, ext) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `${slug(eventName, "event")}-${slug(label, "selection")}-${date}.${ext}`;
}

/// Resolves one client's selection OR the merged all-clients selection.
/// Studio callers pass any mapping (even revoked/expired — the export is
/// the studio's own record); client self-service passes its live mapping.
/// Returns { event, owner, clients, photos } where clients = [{ user,
/// mapping, favourites: [{ photo, selectedAt }] }] and photos is the
/// deduped photo list in first-selected order. Throws { status } errors
/// for the route to translate.
export async function resolveSelection({ eventId, clientId = null, merged = false, selfUserId = null }) {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    include: { owner: true },
  });
  if (!event) {
    throw Object.assign(new Error("Event not found"), { status: 404 });
  }
  if (!event.photoSelectionEnabled) {
    throw Object.assign(new Error("Photo Selection isn't turned on for this event."), { status: 400 });
  }

  let mappings;
  if (selfUserId) {
    const mapping = await prisma.eventUserMapping.findUnique({
      where: { eventId_userId: { eventId, userId: selfUserId } },
      include: { user: true },
    });
    if (!mapping) throw Object.assign(new Error("No selection found"), { status: 404 });
    mappings = [mapping];
  } else if (clientId) {
    const mapping = await prisma.eventUserMapping.findFirst({
      where: { eventId, userId: clientId },
      include: { user: true },
    });
    if (!mapping) throw Object.assign(new Error("That client has no selection on this event"), { status: 404 });
    mappings = [mapping];
  } else if (merged) {
    mappings = await prisma.eventUserMapping.findMany({
      where: { eventId },
      include: { user: true },
      orderBy: { createdAt: "asc" },
    });
  } else {
    throw Object.assign(new Error("Pass ?client_id=<userId> or ?scope=merged"), { status: 400 });
  }

  const clients = [];
  const seenPhotos = new Map();
  for (const mapping of mappings) {
    const favs = await prisma.clientFavourite.findMany({
      where: { userId: mapping.userId, photo: { eventId, ...VISIBLE_PHOTO } },
      include: { photo: true },
      orderBy: { createdAt: "asc" },
    });
    if (favs.length === 0) continue;
    clients.push({
      user: mapping.user,
      mapping,
      favourites: favs.map((f) => ({ photo: f.photo, selectedAt: f.createdAt })),
    });
    for (const f of favs) {
      if (!seenPhotos.has(f.photo.id)) seenPhotos.set(f.photo.id, f.photo);
    }
  }
  if (clients.length === 0) {
    throw Object.assign(new Error("No selected photos to export yet"), { status: 404 });
  }
  return { event, owner: event.owner, clients, photos: [...seenPhotos.values()] };
}

function csvCell(value) {
  if (value == null) return "";
  const s = value instanceof Date ? value.toISOString() : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/// One row per (photo × client) selection: spreadsheet-pivotable, and the
/// merged export stays attributable. Columns per spec: filename, original
/// filename if available, photo id, source, selected date, client
/// email/name, event name.
export function buildSelectionCsv({ event, clients }) {
  const header = [
    "filename",
    "original_filename",
    "photo_id",
    "source",
    "selected_at",
    "client_name",
    "client_email",
    "event_name",
  ];
  const lines = [header.join(",")];
  for (const c of clients) {
    for (const f of c.favourites) {
      const stored = f.photo.storagePath ? path.posix.basename(String(f.photo.storagePath).replace(/\\/g, "/")) : "";
      lines.push(
        [
          csvCell(f.photo.filename),
          csvCell(stored && stored !== f.photo.filename ? stored : f.photo.filename),
          csvCell(f.photo.id),
          csvCell(f.photo.source || "upload"),
          csvCell(f.selectedAt),
          csvCell(c.user?.name),
          csvCell(c.user?.email),
          csvCell(event.name),
        ].join(",")
      );
    }
  }
  return lines.join("\r\n") + "\r\n";
}

/// One filename per line — paste straight into Lightroom/Photoshop search
/// or a file manager. Deduped for merged exports.
export function buildSelectionTxt({ photos }) {
  return photos.map((p) => p.filename).join("\n") + "\n";
}

/// Proofing PDF report: studio branding/logo, event + client header,
/// counts + submitted/generated dates, numbered filename list, guest
/// comments on the selected photos, and the studio's overlapping picks.
/// Text-only (no thumbnails) so it stays fast on big selections.
/// compress:false keeps the content greppable for automated QA.
export async function buildProofingPdf({ event, owner, scopeLabel, clients, photos }) {
  const photoIds = photos.map((p) => p.id);
  const [comments, picks] = await Promise.all([
    prisma.photoComment.findMany({
      where: { photoId: { in: photoIds } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.studioFavourite.findMany({
      where: { userId: event.ownerId, photoId: { in: photoIds } },
      include: { photo: true },
    }),
  ]);
  const commentsByPhoto = new Map();
  for (const c of comments) {
    if (!commentsByPhoto.has(c.photoId)) commentsByPhoto.set(c.photoId, []);
    commentsByPhoto.get(c.photoId).push(c);
  }

  const studioName = owner?.studioName || "PandaSpot studio";
  const generatedAt = new Date();
  const submittedList = clients.map((c) => c.mapping?.submittedAt).filter(Boolean);
  const submittedAt = submittedList.length ? new Date(Math.max(...submittedList.map((d) => new Date(d).getTime()))) : null;

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 48, compress: false, bufferPages: true });
      const chunks = [];
      doc.on("data", (d) => chunks.push(d));
      doc.on("error", reject);
      doc.on("end", () => resolve(Buffer.concat(chunks)));

      // Header: logo + studio identity.
      if (owner?.logoPath && existsSync(owner.logoPath)) {
        try {
          doc.image(owner.logoPath, { fit: [140, 60] });
          doc.moveDown(0.5);
        } catch (err) {
          console.error(`Proofing PDF: couldn't embed logo for event ${event.id}:`, err.message);
        }
      }
      doc.fontSize(10).fillColor("#666").text(studioName);
      doc.fontSize(20).fillColor("#111").text("Photo Selection Proofing Report");
      doc.moveDown(0.5);
      doc.fontSize(11).fillColor("#111");
      doc.text(`Event: ${event.name}`);
      doc.text(`Client: ${scopeLabel}`);
      doc.text(`Selected photos: ${photos.length}`);
      doc.text(`Submitted: ${submittedAt ? submittedAt.toLocaleString() : "Not submitted yet"}`);
      doc.text(`Generated: ${generatedAt.toLocaleString()}`);
      if (clients.length > 1) {
        doc.moveDown(0.5);
        doc.fontSize(10).fillColor("#666").text("Included clients:");
        doc.fontSize(10).fillColor("#111");
        for (const c of clients) {
          doc.text(
            `• ${c.user?.name || "?"} (${c.user?.email || "?"}) — ${c.favourites.length} selected` +
              (c.mapping?.submittedAt ? ` — submitted ${new Date(c.mapping.submittedAt).toLocaleString()}` : " — not submitted")
          );
        }
      }

      // Numbered filename list.
      doc.moveDown(0.5);
      doc.fontSize(14).fillColor("#111").text("Selected files");
      doc.fontSize(10);
      photos.forEach((p, i) => {
        doc.fillColor("#111").text(`${i + 1}. ${p.filename}`, { continued: false });
      });

      // Guest comments linked to the selected photos.
      const photosWithComments = photos.filter((p) => (commentsByPhoto.get(p.id) || []).length > 0);
      if (photosWithComments.length > 0) {
        doc.moveDown(0.5);
        doc.fontSize(14).fillColor("#111").text("Comments");
        doc.fontSize(10);
        for (const p of photosWithComments) {
          doc.fillColor("#111").text(p.filename, { underline: true });
          for (const c of commentsByPhoto.get(p.id)) {
            doc.fillColor("#333").text(
              `• ${c.guestName || "Guest"} (${new Date(c.createdAt).toLocaleString()}): ${c.text}`
            );
          }
          doc.moveDown(0.25);
        }
      }

      // Studio picks overlapping this selection, when relevant.
      if (picks.length > 0) {
        doc.moveDown(0.5);
        doc.fontSize(14).fillColor("#111").text("Studio picks in this selection");
        doc.fontSize(10).fillColor("#111");
        for (const s of picks) {
          doc.text(`• ${s.photo.filename}`);
        }
      }

      // Footers with page numbers.
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(i);
        doc.fontSize(8).fillColor("#999");
        doc.text(`PandaSpot proofing report — ${event.name} — page ${i + 1} of ${range.count}`, 48, 810, {
          align: "center",
        });
      }
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
