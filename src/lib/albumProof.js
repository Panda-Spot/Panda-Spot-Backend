import PDFDocument from "pdfkit";

/// Album proofing report (Phase 7): the revision lifecycle on paper —
/// album + event header, per-revision spreads/notes, every comment with
/// author + OPEN/RESOLVED status, and the approval timestamp. Text-only
/// (no spread thumbnails) so it stays fast; compress:false keeps content
/// greppable for automated QA, same as the selection proofing PDF.
export async function buildAlbumProofPdf({ event, album, clients }) {
  const versions = [...(album.versions || [])].sort((a, b) => a.versionNumber - b.versionNumber);
  const comments = [...(album.comments || [])].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const byVersion = new Map();
  for (const c of comments) {
    if (!byVersion.has(c.version_id)) byVersion.set(c.version_id, []);
    byVersion.get(c.version_id).push(c);
  }

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 48, compress: false, bufferPages: true });
      const chunks = [];
      doc.on("data", (d) => chunks.push(d));
      doc.on("error", reject);
      doc.on("end", () => resolve(Buffer.concat(chunks)));

      doc.fontSize(20).fillColor("#111").text(`Album proof: ${album.name}`);
      doc.moveDown(0.5);
      doc.fontSize(11).fillColor("#111");
      doc.text(`Event: ${event.name}`);
      doc.text(`Status: ${album.status}`);
      if (album.created_by?.name || album.created_by?.email) {
        doc.text(`Created by: ${album.created_by.name || album.created_by.email}`);
      }
      if (clients && clients.length > 0) {
        doc.text(`Reviewers: ${clients.map((c) => `${c.name || "?"} (${c.email || "?"})`).join(", ")}`);
      }
      doc.text(`Generated: ${new Date().toLocaleString()}`);
      if (album.status === "APPROVED") {
        doc.text(`Approved at: ${album.locked_at ? new Date(album.locked_at).toLocaleString() : "yes (locked)"}`);
      }

      for (const v of versions) {
        doc.moveDown(0.5);
        doc.fontSize(14).fillColor("#111").text(`Revision V${v.version_number}`);
        doc.fontSize(10).fillColor("#333");
        if (v.print_pdf_url) {
          doc.text(`Print PDF version (press file attached in app).`);
        } else {
          doc.text(`${(v.pages || []).length} spread(s).`);
          for (const p of [...(v.pages || [])].sort((a, b) => a.page_number - b.page_number)) {
            const dims = p.width && p.height ? ` (${p.width}x${p.height})` : "";
            doc.text(`• p.${p.page_number}: ${p.filename}${dims}`);
          }
        }
        if (v.note) doc.text(`Studio note: ${v.note}`);
        const thread = byVersion.get(v.id) || [];
        if (thread.length === 0) {
          doc.text(`Comments: none.`);
        } else {
          const open = thread.filter((c) => !c.resolved_at).length;
          doc.text(`Comments (${thread.length}, ${open} open):`);
          for (const c of thread) {
            const where = c.pin_number != null
              ? `pin ${c.pin_number}${c.page_id ? ` (p.${pageNum(v, c.page_id)})` : ""}`
              : "general note";
            const who = c.author?.name || c.author?.email || "Studio";
            doc.text(
              `• [${c.resolved_at ? "RESOLVED" : "OPEN"}] ${where} — ${who}: ${c.message}`
            );
            for (const r of c.replies || []) {
              const rw = r.author?.name || r.author?.email || "Studio";
              doc.text(`    ↳ ${rw}: ${r.message}`);
            }
          }
        }
      }

      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(i);
        doc.fontSize(8).fillColor("#999");
        doc.text(`PandaSpot album proof — ${album.name} — page ${i + 1} of ${range.count}`, 48, 810, { align: "center" });
      }
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function pageNum(version, pageId) {
  const p = (version.pages || []).find((x) => x.page_id === pageId);
  return p ? p.page_number : "?";
}
