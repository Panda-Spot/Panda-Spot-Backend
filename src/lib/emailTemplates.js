// PandaSpot transactional email templates.
//
// Shell designs lifted from D:\2026-SHOP\Panda-Spot\email.service.js — same
// structures, radii, shadows and palettes — with PandaSpot photography copy
// swapped in. Every send picks one shell at random (pickRandom), same as
// that file's variant system. Table-based markup for Gmail/Outlook/Apple.
//
// Convention: builders take plain data and return { subject, html, text }.
// All user-controlled values are HTML-escaped before interpolation.

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

function cta(label, url, bg = "#4338ca") {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px auto 0;">
    <tr><td align="center" style="border-radius:10px;background:${bg};">
      <a href="${escapeHtml(url)}" target="_blank"
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

function brandFooter() {
  return `<p style="margin:20px 0 0;text-align:center;font-size:11px;color:#94a3b8;">
    &copy; ${YEAR} ${APP_NAME} &mdash; Spot yourself. Get your photos.
  </p>`;
}

function copyBox(url, bg = "#f8fafc", border = "#e2e8f0", labelColor = "#475569", linkColor = "#6366f1") {
  if (!url) return "";
  return `<div style="margin:28px 0 0;padding:16px;background:${bg};border-radius:10px;border:1px solid ${border};">
    <p style="margin:0 0 6px;font-size:12px;font-weight:700;color:${labelColor};">Or copy this link:</p>
    <p style="margin:0;font-size:11px;color:${linkColor};word-break:break-all;">${escapeHtml(url)}</p>
  </div>`;
}

// ── Shell A — gradient hero card (their reset V1 / welcome V1) ──────────
function shellHero({ eyebrow, icon, title, sub, bodyHtml, ctaLabel, ctaUrl, copyLink, footerNote, heroBg }) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;background:#f1f5f9;"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
<tr><td style="background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.07);">
  <div style="background:${heroBg || "linear-gradient(135deg,#1e1b4b,#4338ca)"};padding:44px 40px;text-align:center;">
    <div style="width:64px;height:64px;background:rgba(255,255,255,.12);border-radius:50%;margin:0 auto 16px;line-height:64px;font-size:28px;">${icon || "&#128247;"}</div>
    <h1 style="margin:0 0 6px;color:#fff;font-size:24px;font-weight:800;">${title}</h1>
    <p style="margin:0;color:#a5b4fc;font-size:13px;">${eyebrow}</p>
  </div>
  <div style="padding:36px 40px;">
    ${sub ? `<p style="margin:0 0 16px;font-size:14px;color:#475569;line-height:1.75;">${sub}</p>` : ""}
    ${bodyHtml}
    ${ctaLabel && ctaUrl ? cta(ctaLabel, ctaUrl, "#4338ca") : ""}
    ${copyBox(ctaUrl && copyLink !== false ? ctaUrl : null)}
  </div>
  ${footer(footerNote)}
</td></tr><tr><td style="padding-top:18px;text-align:center;font-size:11px;color:#94a3b8;">&copy; ${YEAR} ${APP_NAME}</td></tr>
</table></td></tr></table></body></html>`;
}

// ── Shell B — minimal letterhead (their reset V2 / verify V4) ───────────
function shellLetter({ eyebrow, title, sub, bodyHtml, ctaLabel, ctaUrl, copyLink, footerNote }) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:56px 24px;"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:460px;">
<tr><td style="padding-bottom:20px;border-bottom:2px solid #1e293b;">
  <p style="margin:0;font-size:14px;font-weight:700;color:#1e293b;">${APP_NAME}</p>
</td></tr>
<tr><td style="padding:32px 0;">
  <h1 style="margin:0 0 14px;font-size:26px;font-weight:800;color:#1e293b;">${title}</h1>
  ${sub ? `<p style="margin:0 0 24px;font-size:15px;color:#475569;line-height:1.8;">${sub}</p>` : ""}
  ${bodyHtml}
  ${ctaLabel && ctaUrl ? cta(ctaLabel, ctaUrl, "#1e293b") : ""}
  ${copyLink === false || !ctaUrl ? "" : `<p style="margin:20px 0 0;font-size:11px;color:#94a3b8;word-break:break-all;">${escapeHtml(ctaUrl)}</p>`}
</td></tr>
<tr><td style="border-top:1px solid #e2e8f0;padding-top:16px;text-align:center;"><p style="margin:0;font-size:11px;color:#94a3b8;">${footerNote || `&copy; ${YEAR} ${APP_NAME}`}</p></td></tr>
</table></td></tr></table></body></html>`;
}

// ── Shell C — glass card on gradient (their reset V3 / verify V3) ───────
function shellGlass({ eyebrow, title, sub, bodyHtml, ctaLabel, ctaUrl, copyLink, footerNote, pageBg, btnBg, boxBg, boxBorder, boxText }) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:${pageBg || "linear-gradient(135deg,#0c4a6e,#0369a1,#0ea5e9)"};">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:56px 16px;"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:500px;">
<tr><td style="background:rgba(255,255,255,.97);border-radius:24px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.3);">
  <div style="padding:40px 40px 28px;text-align:center;">
    <p style="margin:0 0 16px;font-size:52px;line-height:1;">&#128247;</p>
    <h1 style="margin:0 0 6px;font-size:24px;font-weight:800;color:#1e293b;">${title}</h1>
    <p style="margin:0 0 24px;font-size:13px;color:#64748b;">${eyebrow}</p>
    ${sub ? `<p style="margin:0 0 24px;font-size:14px;color:#475569;line-height:1.75;">${sub}</p>` : ""}
    ${bodyHtml}
    ${ctaLabel && ctaUrl ? cta(ctaLabel, ctaUrl, btnBg || "#0369a1") : ""}
    ${copyLink === false || !ctaUrl ? "" : `<div style="margin:24px 0 0;background:${boxBg || "#f0f9ff"};border-radius:10px;padding:14px 18px;border:1px solid ${boxBorder || "#bae6fd"};">
      <p style="margin:0 0 4px;font-size:11px;font-weight:700;color:${boxText || "#0369a1"};">Backup link:</p>
      <p style="margin:0;font-size:10px;color:${boxText || "#0369a1"};word-break:break-all;">${escapeHtml(ctaUrl)}</p>
    </div>`}
  </div>
  ${footer(footerNote)}
</td></tr>
<tr><td style="padding-top:16px;text-align:center;font-size:11px;color:rgba(255,255,255,.4);">&copy; ${YEAR} ${APP_NAME}</td></tr>
</table></td></tr></table></body></html>`;
}

// ── Shell D — dark slate security (their reset V4) ─────────────────────
function shellDark({ eyebrow, title, sub, bodyHtml, ctaLabel, ctaUrl, copyLink, footerNote }) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:48px 16px;background:#0f172a;"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
<tr><td style="background:#1e293b;border-radius:20px;overflow:hidden;border:1px solid #334155;">
  <div style="padding:28px 40px;border-bottom:1px solid #334155;">
    <p style="margin:0 0 2px;font-size:11px;font-weight:700;color:#f59e0b;letter-spacing:.08em;text-transform:uppercase;">&#128247; ${eyebrow}</p>
    <h1 style="margin:0;color:#f8fafc;font-size:22px;font-weight:800;">${title}</h1>
  </div>
  <div style="padding:28px 40px;">
    ${sub ? `<p style="margin:0 0 16px;font-size:13px;color:#94a3b8;line-height:1.7;">${sub}</p>` : ""}
    <div style="font-size:13px;color:#cbd5e1;line-height:1.75;">${bodyHtml}</div>
    ${ctaLabel && ctaUrl ? cta(ctaLabel, ctaUrl, "#f59e0b") : ""}
    ${copyLink === false || !ctaUrl ? "" : `<div style="margin:20px 0;padding:14px 16px;background:#0f172a;border-radius:8px;border:1px solid #334155;">
      <p style="margin:0 0 4px;font-size:11px;color:#475569;font-weight:700;">Direct link:</p>
      <p style="margin:0;font-size:11px;color:#6366f1;word-break:break-all;">${escapeHtml(ctaUrl)}</p>
    </div>`}
  </div>
  <div style="padding:14px 40px;border-top:1px solid #334155;text-align:center;"><p style="margin:0;font-size:11px;color:#334155;">${footerNote || `&copy; ${YEAR} ${APP_NAME}`}</p></div>
</td></tr></table></td></tr></table></body></html>`;
}

// ── Shell E — top-strip centered (their emerald verify V2 / reset V6) ───
function shellStrip({ eyebrow, title, sub, bodyHtml, ctaLabel, ctaUrl, copyLink, footerNote, stripBg, icon }) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f0fdf4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:48px 16px;background:#f0fdf4;"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;">
<tr><td style="background:#fff;border-radius:24px;overflow:hidden;box-shadow:0 4px 24px rgba(16,185,129,.1);border:1px solid #a7f3d0;">
  <div style="height:5px;background:${stripBg || "linear-gradient(90deg,#10b981,#059669,#047857)"};"></div>
  <div style="padding:40px 40px 28px;text-align:center;">
    <p style="margin:0 0 12px;font-size:52px;line-height:1;">${icon || "&#128247;"}</p>
    <h1 style="margin:0 0 6px;font-size:24px;font-weight:800;color:#1e293b;">${title}</h1>
    <p style="margin:0 0 20px;font-size:13px;color:#059669;">${eyebrow}</p>
    ${sub ? `<p style="margin:0 0 24px;font-size:14px;color:#475569;line-height:1.75;">${sub}</p>` : ""}
    <div style="text-align:left;">${bodyHtml}</div>
    ${ctaLabel && ctaUrl ? cta(ctaLabel, ctaUrl, "#059669") : ""}
    ${copyLink === false || !ctaUrl ? "" : `<p style="margin:20px 0 0;font-size:11px;color:#94a3b8;word-break:break-all;">${escapeHtml(ctaUrl)}</p>`}
  </div>
  ${footer(footerNote)}</td></tr>${brandFooter2()}</table></td></tr></table></body></html>`;
}

function brandFooter2() {
  return `<p style="margin:20px 0 0;text-align:center;font-size:11px;color:#94a3b8;">
    &copy; ${YEAR} ${APP_NAME} &mdash; Spot yourself. Get your photos.
  </p>`;
}

// ── Shell F — warm gold bordered (their welcome V15 / orange verify V5) ─
function shellGold({ eyebrow, title, sub, bodyHtml, ctaLabel, ctaUrl, copyLink, footerNote, heroBg }) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#fffbeb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;background:#fffbeb;"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
<tr><td style="background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(245,158,11,.12);border:2px solid #fef08a;">
  <div style="background:${heroBg || "linear-gradient(135deg,#78350f,#b45309,#d97706)"};padding:36px 40px;text-align:center;">
    <p style="margin:0 0 4px;font-size:11px;font-weight:700;color:#fde68a;letter-spacing:.1em;text-transform:uppercase;">${eyebrow}</p>
    <h1 style="margin:0 0 8px;color:#fff;font-size:24px;font-weight:800;">${title}</h1>
    ${sub ? `<p style="margin:0;color:#fef3c7;font-size:14px;line-height:1.6;">${sub}</p>` : ""}
  </div>
  <div style="padding:32px 40px;">
    ${bodyHtml}
    ${ctaLabel && ctaUrl ? cta(ctaLabel, ctaUrl, "#d97706") : ""}
    ${copyLink === false || !ctaUrl ? "" : `<div style="margin:24px 0 0;background:#fffbeb;border:1px solid #fde68a;border-radius:12px;padding:16px 18px;">
      <p style="margin:0 0 4px;font-size:11px;font-weight:700;color:#92400e;text-transform:uppercase;letter-spacing:.06em;">Or copy this link</p>
      <p style="margin:0;font-size:11px;color:#92400e;word-break:break-all;">${escapeHtml(ctaUrl)}</p>
    </div>`}
  </div>
  ${footer(footerNote)}
</td></tr>${brandFooter2()}</table></td></tr></table></body></html>`;
}

const SHELLS = [shellHero, shellLetter, shellGlass, shellDark, shellStrip, shellGold];

// Renders args through one randomly-picked shell. Pass raw values —
// builders escape user content before calling this.
function renderMail(args) {
  return pickRandom(SHELLS)(args);
}

function para(text, color = "#475569") {
  return `<p style="margin:0 0 16px;font-size:14px;color:${color};line-height:1.75;">${text}</p>`;
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
    icon: "&#9993;&#65039;",
    title: "Verify your email",
    sub: `Hi <strong>${safeName}</strong> — almost there! Confirm <strong>${escapeHtml(email || "")}</strong> to finish setting up your studio. The link expires in 24 hours.`,
    bodyHtml: para(`Tap the button below to verify. If you didn't create a PandaSpot account, safely ignore this email.`),
    ctaLabel: "Verify email",
    ctaUrl: url,
    footerNote: `Link valid for 24 hours and single-use. Didn't sign up? Ignore this email.`,
  });
  return { subject, html, text };
}

// ── Password reset ───────────────────────────────────────────────────
export function passwordResetEmail({ name, url }) {
  const safeName = escapeHtml(name || "there");
  const subject = "Reset your PandaSpot password";
  const text = `Hi ${name || "there"} — reset your password: ${url}`;
  const html = renderMail({
    eyebrow: `${APP_NAME} &bull; Password recovery`,
    icon: "&#128274;",
    title: "Reset your password",
    sub: `Hi <strong>${safeName}</strong> — a reset was requested for your studio account. The link expires in 1 hour, single-use.`,
    bodyHtml: para(`Tap below to choose a new password. If you didn't ask for this, your password is unchanged — just ignore this email.`),
    ctaLabel: "Reset password",
    ctaUrl: url,
    footerNote: `Link expires in 1 hour. If you did not request this, no action is needed.`,
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
    icon: "&#128247;",
    title: "You're invited to help shoot",
    sub: `A studio invited you to collaborate on <strong>“${safeEvent}”</strong>.`,
    bodyHtml:
      infoBox([["Event", safeEvent], ["Access", "Upload + view this event only"]]) +
      para(`You'll get your own login scoped to this event — upload photos, see the gallery and analytics. Open the link and tap <strong>Accept invitation</strong> (or Decline if it wasn't meant for you). Nothing is shared until you accept.`),
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
    icon: "&#127881;",
    title: "Your photos are ready",
    sub: `Your photographer shared <strong>“${safeEvent}”</strong> with you.`,
    bodyHtml:
      infoBox([["Event", safeEvent], ["What to do", "Favourite + submit your picks"]]) +
      para(`Browse the gallery, tap the heart on your favourites, then submit your selection — your studio takes it from there.`),
    ctaLabel: "View my photos",
    ctaUrl: url,
    footerNote: `This link is personal to your email address.`,
  });
  return { subject, html, text };
}

// ── Zip ready ────────────────────────────────────────────────────────
export function zipReadyEmail({ url }) {
  const subject = "Your PandaSpot photos are ready";
  const text = `Your photos are ready to download: ${url}`;
  const html = renderMail({
    eyebrow: `${APP_NAME} &bull; Download ready`,
    icon: "&#128230;",
    title: "Your photos are ready",
    sub: "Your zip file has finished building.",
    bodyHtml: para(`Tap below to download. Keep the link handy — large selections stay available for a limited time.`),
    ctaLabel: "Download photos",
    ctaUrl: url,
    footerNote: null,
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
    icon: "&#128247;",
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
    icon: "&#127881;",
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
    icon: "&#9888;",
    title: "Save your own copy",
    sub: `Your relay backup for <strong>“${safeEvent}”</strong> is temporary.`,
    bodyHtml:
      infoBox([
        ["After 2 days", "Removed from the shared Drive (pulled back to PandaSpot)"],
        ["After 7 days", "Permanently deleted everywhere — unrecoverable"],
      ]) +
      para(`Open the folder, select everything, and choose <strong>“Make a copy”</strong> into your own Drive. This only affects Shoots captures with Drive backup on for this event.`),
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
    icon: "&#128214;",
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
    footerNote: `You only ever see albums your studio sends — drafts stay invisible.`,
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
    icon: "&#128221;",
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
    icon: "&#127881;",
    title: "Album approved",
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
