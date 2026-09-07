// PandaSpot transactional email templates.
//
// Ported from the standalone template system at D:\2026-SHOP\Panda-Spot\email.service.js
// (same idea: every mail picks one of several fully-designed HTML variants at
// random, table-based markup so it renders in Gmail/Outlook/Apple Mail).
// Rebuilt here as ESM for this server, rebranded from that file's
// finance-product copy to PandaSpot photography copy, and cut down to the
// mail types this backend actually sends (see lib/mailer.js).
//
// Convention: each builder takes plain data and returns
// { subject, html, text }. All user-controlled values are HTML-escaped
// inside the builders — callers pass raw strings.

const APP_NAME = "PandaSpot";
const YEAR = new Date().getFullYear();

export function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function cta(label, url, bg = "#0e8a8a") {
  const safeUrl = escapeHtml(url);
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px auto 0;">
    <tr><td align="center" style="border-radius:10px;background:${bg};">
      <a href="${safeUrl}" target="_blank"
         style="display:inline-block;padding:14px 36px;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;letter-spacing:.01em;">
        ${escapeHtml(label)} &rarr;
      </a>
    </td></tr>
  </table>`;
}

function footer(note) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td style="padding:24px 40px;text-align:center;border-top:1px solid #f1f5f9;">
      <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.7;">
        ${note || `You are receiving this email because you have a ${APP_NAME} account. Reply to this email if you need help.`}
      </p>
    </td></tr>
  </table>`;
}

function brandLine(dark = false) {
  return `<p style="margin:20px 0 0;text-align:center;font-size:11px;color:${dark ? "#475569" : "#94a3b8"};">
    &copy; ${YEAR} ${APP_NAME} &mdash; Spot yourself. Get your photos.
  </p>`;
}

// ── Shell 1 — teal gradient hero ─────────────────────────────────────
function shellTeal({ eyebrow, title, sub, bodyHtml, ctaLabel, ctaUrl, footerNote }) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f0fdfa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;background:#f0fdfa;"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;">
<tr><td style="padding-bottom:18px;text-align:center;font-size:12px;font-weight:700;color:#0f766e;letter-spacing:.08em;text-transform:uppercase;">${eyebrow}</td></tr>
<tr><td style="background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 8px 32px rgba(14,138,138,.12);">
  <div style="background:linear-gradient(135deg,#042f2e 0%,#0e8a8a 60%,#14b8a6 100%);padding:48px 40px;text-align:center;">
    <div style="width:68px;height:68px;background:rgba(255,255,255,.14);border-radius:18px;margin:0 auto 20px;line-height:68px;text-align:center;font-size:32px;">&#128247;</div>
    <h1 style="margin:0 0 8px;color:#ffffff;font-size:26px;font-weight:800;letter-spacing:-.3px;">${title}</h1>
    ${sub ? `<p style="margin:0;color:#99f6e4;font-size:14px;line-height:1.6;">${sub}</p>` : ""}
  </div>
  <div style="padding:36px 40px;">
    ${bodyHtml}
    ${ctaLabel && ctaUrl ? cta(ctaLabel, ctaUrl, "#0e8a8a") : ""}
  </div>
  ${footer(footerNote)}
</td></tr>
${brandLine()}
</table></td></tr></table>
</body></html>`;
}

// ── Shell 2 — warm gold hero ─────────────────────────────────────────
function shellGold({ eyebrow, title, sub, bodyHtml, ctaLabel, ctaUrl, footerNote }) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#fffbeb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;background:#fffbeb;"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;">
<tr><td style="background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(245,158,11,.14);border:1px solid #fde68a;">
  <div style="background:linear-gradient(135deg,#78350f 0%,#b45309 55%,#d97706 100%);padding:44px 40px;text-align:center;">
    <p style="margin:0 0 4px;font-size:11px;font-weight:700;color:#fde68a;letter-spacing:.1em;text-transform:uppercase;">${eyebrow}</p>
    <h1 style="margin:0 0 8px;color:#ffffff;font-size:26px;font-weight:800;">${title}</h1>
    ${sub ? `<p style="margin:0;color:#fef3c7;font-size:14px;line-height:1.6;">${sub}</p>` : ""}
  </div>
  <div style="padding:36px 40px;">
    ${bodyHtml}
    ${ctaLabel && ctaUrl ? cta(ctaLabel, ctaUrl, "#d97706") : ""}
  </div>
  ${footer(footerNote)}
</td></tr>
${brandLine()}
</table></td></tr></table>
</body></html>`;
}

// ── Shell 3 — dark premium ───────────────────────────────────────────
function shellDark({ eyebrow, title, sub, bodyHtml, ctaLabel, ctaUrl, footerNote }) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;background:#0f172a;"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
<tr><td style="padding-bottom:20px;text-align:center;font-size:12px;font-weight:700;color:#5eead4;letter-spacing:.1em;text-transform:uppercase;">${eyebrow}</td></tr>
<tr><td style="background:#1e293b;border-radius:20px;overflow:hidden;border:1px solid #334155;">
  <div style="padding:44px 40px;border-bottom:1px solid #334155;text-align:center;">
    <h1 style="margin:0 0 8px;color:#f8fafc;font-size:26px;font-weight:800;">${title}</h1>
    ${sub ? `<p style="margin:0;color:#94a3b8;font-size:14px;line-height:1.6;">${sub}</p>` : ""}
  </div>
  <div style="padding:32px 40px;color:#cbd5e1;font-size:14px;line-height:1.75;">
    ${bodyHtml}
    ${ctaLabel && ctaUrl ? cta(ctaLabel, ctaUrl, "#0e8a8a") : ""}
  </div>
  <div style="padding:20px 40px;border-top:1px solid #334155;text-align:center;">
    <p style="margin:0;font-size:11px;color:#475569;">${footerNote || `Questions? Just reply to this email.`}</p>
  </div>
</td></tr>
<tr><td style="padding-top:20px;text-align:center;font-size:11px;color:#334155;">&copy; ${YEAR} ${APP_NAME}</td></tr>
</table></td></tr></table>
</body></html>`;
}

// ── Shell 4 — light minimal centered ─────────────────────────────────
function shellLight({ eyebrow, title, sub, bodyHtml, ctaLabel, ctaUrl, footerNote }) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:48px 16px;background:#f8fafc;"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
<tr><td style="background:#ffffff;border-radius:20px;padding:48px 40px;box-shadow:0 2px 16px rgba(0,0,0,.06);text-align:center;border-top:4px solid #0e8a8a;">
  <p style="margin:0 0 16px;font-size:11px;font-weight:700;color:#0e8a8a;letter-spacing:.1em;text-transform:uppercase;">${eyebrow}</p>
  <h1 style="margin:0 0 12px;font-size:24px;font-weight:800;color:#1e293b;">${title}</h1>
  ${sub ? `<p style="margin:0 0 24px;font-size:14px;color:#64748b;line-height:1.7;">${sub}</p>` : ""}
  <div style="text-align:left;font-size:14px;color:#475569;line-height:1.75;">
    ${bodyHtml}
  </div>
  ${ctaLabel && ctaUrl ? cta(ctaLabel, ctaUrl, "#0e8a8a") : ""}
  <p style="margin:24px 0 0;font-size:11px;color:#cbd5e1;">${footerNote || ""}</p>
</td></tr>
${brandLine()}
</table></td></tr></table>
</body></html>`;
}

const SHELLS = [shellTeal, shellGold, shellDark, shellLight];

// Renders args through one randomly-picked shell. Pass raw values —
// builders escape user content before calling this.
function renderMail(args) {
  return pickRandom(SHELLS)(args);
}

function para(text) {
  return `<p style="margin:0 0 16px;font-size:14px;line-height:1.75;">${text}</p>`;
}

function infoBox(rows) {
  return `<table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;margin:0 0 20px;">
    <tr><td style="padding:18px 20px;">
      ${rows
        .map(
          ([k, v]) => `<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;"><tr>
            <td style="font-size:12px;color:#64748b;font-weight:600;width:150px;vertical-align:top;">${k}</td>
            <td style="font-size:13px;color:#1e293b;vertical-align:top;">${v}</td>
          </tr></table>`
        )
        .join("")}
    </td></tr>
  </table>`;
}

// ── Verify email ─────────────────────────────────────────────────────
export function verificationEmail({ name, url, email }) {
  const safeName = escapeHtml(name || "there");
  const subject = "Verify your PandaSpot email address";
  const text = `Hi ${name || "there"} — please verify your email address: ${url}`;
  const html = renderMail({
    eyebrow: `${APP_NAME} &bull; Email verification`,
    title: `One more step, ${safeName}`,
    sub: "Confirm your email to unlock uploads, galleries and guest links.",
    bodyHtml:
      para(`Hi ${safeName} — tap the button below to verify <strong>${escapeHtml(email || "")}</strong>. The link expires in 24 hours.`) +
      para(`If you didn't create a PandaSpot account, just ignore this email.`),
    ctaLabel: "Verify email",
    ctaUrl: url,
    footerNote: `Link not working? Paste this into your browser: ${escapeHtml(url)}`,
  });
  return { subject, html, text };
}

// ── Password reset ───────────────────────────────────────────────────
export function passwordResetEmail({ name, url }) {
  const safeName = escapeHtml(name || "there");
  const subject = "Reset your PandaSpot password";
  const text = `Hi ${name || "there"} — reset your password: ${url}`;
  const html = renderMail({
    eyebrow: `${APP_NAME} &bull; Password reset`,
    title: "Reset your password",
    sub: "A password change was requested for your studio account.",
    bodyHtml:
      para(`Hi ${safeName} — tap below to choose a new password. The link expires in 1 hour and works only once.`) +
      para(`Didn't ask for this? Your password is unchanged — just ignore this email.`),
    ctaLabel: "Reset password",
    ctaUrl: url,
    footerNote: `Link not working? Paste this into your browser: ${escapeHtml(url)}`,
  });
  return { subject, html, text };
}

// ── Collaborator (second-shooter) invite ─────────────────────────────
export function collaboratorInviteEmail({ eventName, url }) {
  const safeEvent = escapeHtml(eventName || "an event");
  const subject = `You've been invited to help shoot "${eventName}" on PandaSpot`;
  const text = `You've been invited to collaborate on the event "${eventName}" on PandaSpot: ${url}`;
  const html = renderMail({
    eyebrow: `${APP_NAME} &bull; Team invite`,
    title: "You're invited to help shoot",
    sub: `A studio invited you to collaborate on “${safeEvent}”.`,
    bodyHtml:
      para(`You'll get your own login scoped to <strong>“${safeEvent}”</strong> only — upload photos, see the gallery and analytics. Nothing is shared until you accept.`) +
      infoBox([["Event", safeEvent], ["Access", "Upload + view this event only"]]) +
      para(`Open the link and tap <strong>Accept invitation</strong> — or Decline if it wasn't meant for you.`),
    ctaLabel: "Review invitation",
    ctaUrl: url,
    footerNote: `You only get access after you accept. Questions? Ask the studio that invited you.`,
  });
  return { subject, html, text };
}

// ── Client (photo-selection) invite ──────────────────────────────────
export function clientInviteEmail({ eventName, url }) {
  const safeEvent = escapeHtml(eventName || "your event");
  const subject = `Your photos from "${eventName}" are ready to view`;
  const text = `You've been invited to browse and favourite your photos from "${eventName}" on PandaSpot: ${url}`;
  const html = renderMail({
    eyebrow: `${APP_NAME} &bull; Your photos are ready`,
    title: "Your photos are ready",
    sub: `Your photographer shared <strong>“${safeEvent}”</strong> with you.`,
    bodyHtml:
      para(`Browse the gallery, tap the heart on your favourites, then submit your selection — your studio takes it from there.`) +
      infoBox([["Event", safeEvent], ["What to do", "Favourite + submit your picks"]]),
    ctaLabel: "View my photos",
    ctaUrl: url,
    footerNote: `The link is personal to your email address.`,
  });
  return { subject, html, text };
}

// ── Zip ready ────────────────────────────────────────────────────────
export function zipReadyEmail({ url }) {
  const subject = "Your PandaSpot photos are ready";
  const text = `Your photos are ready to download: ${url}`;
  const html = renderMail({
    eyebrow: `${APP_NAME} &bull; Download ready`,
    title: "Your photos are ready",
    sub: "Your zip file has finished building.",
    bodyHtml: para(`Tap below to download your photos. Keep the link handy — large selections stay available for a limited time.`),
    ctaLabel: "Download photos",
    ctaUrl: url,
    footerNote: `Link not working? Paste this into your browser: ${escapeHtml(url)}`,
  });
  return { subject, html, text };
}

// ── Guest photo alert ────────────────────────────────────────────────
export function guestAlertEmail({ eventName, url, count }) {
  const n = Number(count) || 0;
  const plural = n === 1 ? "photo" : "photos";
  const safeEvent = escapeHtml(eventName || "your event");
  const subject = `${n} new ${plural} of you at "${eventName}"`;
  const text = `${n} new ${plural} of you just showed up at "${eventName}": ${url}`;
  const html = renderMail({
    eyebrow: `${APP_NAME} &bull; New matches`,
    title: `${n} new ${plural} of you`,
    sub: `More of your photos just landed in <strong>“${safeEvent}”</strong>.`,
    bodyHtml: para(`The gallery keeps growing during the event — open it to see your latest matches, react, and download.`),
    ctaLabel: "See my photos",
    ctaUrl: url,
    footerNote: `You're getting this because you asked to be notified for “${safeEvent}”.`,
  });
  return { subject, html, text };
}

// ── Studio credentials (admin-created account) ───────────────────────
export function studioCredentialsEmail({ studioName, email, temporaryPassword, loginUrl }) {
  const subject = "Your PandaSpot studio account is ready";
  const text =
    `Your PandaSpot studio account has been created.\n\n` +
    `Studio: ${studioName || "PandaSpot Studio"}\n` +
    `Login: ${loginUrl}\n` +
    `Email: ${email}\n` +
    `Temporary password: ${temporaryPassword}\n\n` +
    `Sign in and change this password from your account settings.`;
  const html = renderMail({
    eyebrow: `${APP_NAME} &bull; Account ready`,
    title: "Your studio account is ready",
    sub: `An administrator created <strong>${escapeHtml(studioName || "PandaSpot Studio")}</strong> for you.`,
    bodyHtml:
      infoBox([
        ["Login page", escapeHtml(loginUrl || "")],
        ["Email", escapeHtml(email || "")],
        ["Temporary password", escapeHtml(temporaryPassword || "")],
      ]) +
      para(`Sign in with the temporary password, then change it from your account settings — it is shown only once, here.`),
    ctaLabel: "Sign in",
    ctaUrl: loginUrl,
    footerNote: `Keep this email until you've signed in and changed the password.`,
  });
  return { subject, html, text };
}

// ── Drive-backup reclaim notice ──────────────────────────────────────
export function driveReclaimNoticeEmail({ eventName, driveUrl }) {
  const safeEvent = escapeHtml(eventName || "your event");
  const subject = `Action needed: save your own copy of "${eventName}"'s photos`;
  const body =
    `Your Shoots-captured photos for "${eventName}" are temporarily backed up to a shared Google Drive relay — ` +
    `not stored permanently there or on PandaSpot's own servers. To keep them, open the Drive folder, select ` +
    `all the files, and choose "Make a copy" — that copy is fully yours, in your own Drive storage.\n\n` +
    `Timeline: files still in the shared relay are removed from Drive after 2 days (pulled back to PandaSpot's ` +
    `server as a last resort), and permanently deleted everywhere 7 days after they were captured. After that, ` +
    `they cannot be recovered.\n\n` +
    (driveUrl ? `Drive folder: ${driveUrl}\n\n` : "") +
    `This only affects photos captured via Shoots with Drive backup turned on for this event.`;
  const html = renderMail({
    eyebrow: `${APP_NAME} &bull; Action needed`,
    title: "Save your own copy",
    sub: `Your relay backup for <strong>“${safeEvent}”</strong> is temporary.`,
    bodyHtml:
      para(`Your Shoots captures are sitting in a shared Google Drive relay — <strong>not</strong> permanent storage. Open the folder, select everything, and choose <strong>“Make a copy”</strong> into your own Drive.`) +
      infoBox([
        ["After 2 days", "Removed from the shared Drive (pulled back to PandaSpot)"],
        ["After 7 days", "Permanently deleted everywhere — unrecoverable"],
      ]) +
      para(`This only affects Shoots captures with Drive backup turned on for this event.`),
    ctaLabel: driveUrl ? "Open Drive folder" : null,
    ctaUrl: driveUrl || null,
    footerNote: `Your “Make a copy” copy is fully yours and never touched by this lifecycle.`,
  });
  return { subject, html, text: body };
}

// ── Album sent for review ────────────────────────────────────────────
export function albumSentEmail({ eventName, albumName, versionNumber, url }) {
  const safeAlbum = escapeHtml(albumName || "your album");
  const subject = `Your album “${albumName}” is ready for review`;
  const text =
    `${eventName}: album “${albumName}” (v${versionNumber}) is ready for your review.\n` +
    `Flip through the spreads, drop pins where you want changes, then approve or request changes.` +
    (url ? `\nOpen it here: ${url}` : "");
  const html = renderMail({
    eyebrow: `${APP_NAME} &bull; Album review`,
    title: "Your album is ready",
    sub: `<strong>“${safeAlbum}”</strong> (v${Number(versionNumber) || 1}) is waiting for your review.`,
    bodyHtml:
      infoBox([
        ["Event", escapeHtml(eventName || "")],
        ["Album", safeAlbum],
        ["Version", `v${Number(versionNumber) || 1}`],
      ]) +
      para(`Flip through the spreads, drop pins exactly where you want changes, then approve or request changes.`),
    ctaLabel: "Review album",
    ctaUrl: url,
    footerNote: `Drafts stay invisible — you only ever see albums your studio sends.`,
  });
  return { subject, html, text };
}

// ── Album changes requested ──────────────────────────────────────────
export function albumChangesEmail({ eventName, albumName, clientName, message, url }) {
  const safeAlbum = escapeHtml(albumName || "the album");
  const subject = `Changes requested on “${albumName}”`;
  const safeClient = escapeHtml(clientName || "The client");
  const text =
    `${clientName || "The client"} requested changes on album “${albumName}” (${eventName}).` +
    (message ? `\nTheir note: ${message}` : "") +
    (url ? `\nOpen it here: ${url}` : "");
  const html = renderMail({
    eyebrow: `${APP_NAME} &bull; Album feedback`,
    title: "Changes requested",
    sub: `${safeClient} left feedback on <strong>“${safeAlbum}”</strong>.`,
    bodyHtml:
      infoBox([
        ["Event", escapeHtml(eventName || "")],
        ["Album", safeAlbum],
        ["From", safeClient],
      ]) +
      (message ? para(`Their note: <em>“${escapeHtml(message)}”</em>`) : "") +
      para(`Upload a new version when ready — the client is notified automatically.`),
    ctaLabel: "Open album",
    ctaUrl: url,
    footerNote: null,
  });
  return { subject, html, text };
}

// ── Album approved ───────────────────────────────────────────────────
export function albumApprovedEmail({ eventName, albumName, clientName, url }) {
  const safeAlbum = escapeHtml(albumName || "the album");
  const subject = `Album approved: “${albumName}”`;
  const safeClient = escapeHtml(clientName || "The client");
  const text =
    `${clientName || "The client"} approved album “${albumName}” (${eventName}) — it is now locked for print.` +
    (url ? `\nOpen it here: ${url}` : "");
  const html = renderMail({
    eyebrow: `${APP_NAME} &bull; Approved &amp; locked`,
    title: "Album approved 🎉",
    sub: `${safeClient} approved <strong>“${safeAlbum}”</strong> — locked for print.`,
    bodyHtml:
      infoBox([
        ["Event", escapeHtml(eventName || "")],
        ["Album", safeAlbum],
        ["Status", "Approved — locked"],
      ]) +
      para(`No further changes can be made unless you reopen it as a new draft.`),
    ctaLabel: "Open album",
    ctaUrl: url,
    footerNote: null,
  });
  return { subject, html, text };
}
