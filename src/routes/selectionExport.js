import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { loadAccessibleEvent } from "../lib/access.js";
import { streamPhotosZip, zipFilenameForEvent } from "../lib/zip.js";
import {
  buildProofingPdf,
  buildSelectionCsv,
  buildSelectionTxt,
  exportFilename,
  resolveSelection,
} from "../lib/selectionExport.js";

const router = Router({ mergeParams: true });

/// Selection export + proofing reports, studio side (Phase 1): the
/// existing photo-selection workflow's paper trail — CSV/TXT filename
/// lists for album design/editing/printing, a branded proofing PDF for
/// client confirmation, and selected-photos zips per client or merged.
/// Owner-or-collaborator via loadAccessibleEvent (collaborator rows carry
/// no finer permission flags — membership IS event media access, same as
/// every other studio route including the existing gallery zips); the
/// client self-service counterparts live in routes/client.js.
router.use(requireAuth);

function scopeOf(req) {
  const clientId = typeof req.query.client_id === "string" && req.query.client_id ? req.query.client_id : null;
  const merged = req.query.scope === "merged";
  return { clientId, merged };
}

function labelFor(selection) {
  if (selection.clients.length === 1) {
    const u = selection.clients[0].user;
    return u?.name || (u?.email ? u.email.split("@")[0] : null) || "client";
  }
  return "all-clients";
}

function clientScopeLabel(selection) {
  if (selection.clients.length === 1) {
    const u = selection.clients[0].user;
    return `${u?.name || "Client"} (${u?.email || "?"})`;
  }
  return `All clients (merged — ${selection.clients.length} clients)`;
}

async function loadSelection(req, res) {
  const accessible = await loadAccessibleEvent(req, res);
  if (!accessible) return null;
  const { event } = accessible;
  try {
    return await resolveSelection({ eventId: event.id, ...scopeOf(req) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Could not resolve selection" });
    return null;
  }
}

function fail(res, context, err) {
  console.error(`Selection export failed (${context}):`, err);
  if (!res.headersSent) {
    res.status(500).json({ error: "Export failed — please try again." });
  }
}

router.get("/export.csv", async (req, res) => {
  const selection = await loadSelection(req, res);
  if (!selection) return;
  try {
    const csv = buildSelectionCsv(selection);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${exportFilename(selection.event.name, labelFor(selection), "csv")}"`
    );
    res.send(csv);
  } catch (err) {
    fail(res, `csv event=${req.params.id} q=${JSON.stringify(req.query)}`, err);
  }
});

router.get("/export.txt", async (req, res) => {
  const selection = await loadSelection(req, res);
  if (!selection) return;
  try {
    const txt = buildSelectionTxt(selection);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${exportFilename(selection.event.name, labelFor(selection), "txt")}"`
    );
    res.send(txt);
  } catch (err) {
    fail(res, `txt event=${req.params.id} q=${JSON.stringify(req.query)}`, err);
  }
});

router.get("/report.pdf", async (req, res) => {
  const selection = await loadSelection(req, res);
  if (!selection) return;
  try {
    const pdf = await buildProofingPdf({ ...selection, scopeLabel: clientScopeLabel(selection) });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${exportFilename(selection.event.name, labelFor(selection), "pdf")}"`
    );
    res.send(pdf);
  } catch (err) {
    fail(res, `pdf event=${req.params.id} q=${JSON.stringify(req.query)}`, err);
  }
});

// Selected-photos zip for one client (?client_id=) or the merged set
// (?scope=merged). The pre-existing full-gallery and studio-picks zips
// are untouched — this one answers "give me exactly what was picked".
router.get("/download-zip", async (req, res, next) => {
  const selection = await loadSelection(req, res);
  if (!selection) return;
  try {
    const label = labelFor(selection);
    const base = zipFilenameForEvent(selection.event).replace(/-photos\.zip$/, "");
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${base}-${label}-selection.zip"`);
    await streamPhotosZip(selection.photos, res);
  } catch (err) {
    console.error(`Selection export failed (zip event=${req.params.id} q=${JSON.stringify(req.query)}):`, err);
    next(err);
  }
});

export default router;
