import nodemailer from "nodemailer";
import {
  albumApprovedEmail,
  albumChangesEmail,
  albumSentEmail,
  clientInviteEmail,
  collaboratorInviteEmail,
  driveReclaimNoticeEmail,
  guestAlertEmail,
  passwordResetEmail,
  studioCredentialsEmail,
  verificationEmail,
  zipReadyEmail,
} from "./emailTemplates.js";

let transporter = null;
function getTransporter() {
  if (!process.env.SMTP_HOST) return null; // not configured yet — caller should handle gracefully
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || "587", 10),
      secure: process.env.SMTP_SECURE === "true",
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  }
  return transporter;
}

function fromHeader() {
  return process.env.SMTP_FROM || "PandaSpot <no-reply@pandaspot.example>";
}

// Every sender below keeps the same signature and the same graceful
// pattern: no SMTP means a warn-log (never a throw), and callers must
// never let a mail failure fail the request itself. The HTML now comes
// from lib/emailTemplates.js — one of several fully-designed variants
// picked at random per send.
async function sendTemplated(to, rendered, warnText) {
  const t = getTransporter();
  if (!t) {
    console.warn(`SMTP not configured — would have emailed ${to}:\nSubject: ${rendered.subject}\n${warnText || rendered.text}`);
    return;
  }
  await t.sendMail({ from: fromHeader(), to, subject: rendered.subject, text: rendered.text, html: rendered.html });
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export async function sendStudioCredentialsEmail(to, studioName, email, temporaryPassword, loginUrl) {
  const rendered = studioCredentialsEmail({ studioName, email, temporaryPassword, loginUrl });
  const t = getTransporter();
  if (!t) {
    console.warn(`SMTP not configured — would have emailed ${to} the studio credentials:\n${rendered.text}`);
    return;
  }
  await t.sendMail({ from: fromHeader(), to, subject: rendered.subject, text: rendered.text, html: rendered.html });
}

export async function sendZipReadyEmail(to, downloadUrl) {
  return sendTemplated(to, zipReadyEmail({ url: downloadUrl }), `link: ${downloadUrl}`);
}

export async function sendCollaboratorInviteEmail(to, eventName, inviteUrl) {
  return sendTemplated(to, collaboratorInviteEmail({ eventName, url: inviteUrl }), `invite link: ${inviteUrl}`);
}

/// MERGE (Studio-Verse): invites a client to log in and browse/favourite
/// this event's gallery (Photo Selection) — distinct from
/// sendCollaboratorInviteEmail above, which is for staff/second-shooter
/// access, not client-facing.
export async function sendClientInviteEmail(to, eventName, inviteUrl) {
  return sendTemplated(to, clientInviteEmail({ eventName, url: inviteUrl }), `client invite link: ${inviteUrl}`);
}

export async function sendEmailVerificationEmail(to, verifyUrl) {
  return sendTemplated(to, verificationEmail({ url: verifyUrl }), `verification link: ${verifyUrl}`);
}

export async function sendGuestAlertEmail(to, eventName, galleryUrl, newPhotoCount) {
  const rendered = guestAlertEmail({ eventName, url: galleryUrl, count: newPhotoCount });
  const t = getTransporter();
  if (!t) {
    console.warn(`SMTP not configured — would have emailed ${to} about ${newPhotoCount} new match(es): ${galleryUrl}`);
    return;
  }
  await t.sendMail({ from: fromHeader(), to, subject: rendered.subject, text: rendered.text, html: rendered.html });
}

export async function sendDriveBackupReclaimNoticeEmail(to, eventName, driveFolderUrl) {
  const rendered = driveReclaimNoticeEmail({ eventName, driveUrl: driveFolderUrl });
  const t = getTransporter();
  if (!t) {
    console.warn(`SMTP not configured — would have emailed ${to}:\nSubject: ${rendered.subject}\n${rendered.text}`);
    return;
  }
  await t.sendMail({ from: fromHeader(), to, subject: rendered.subject, text: rendered.text, html: rendered.html });
}

export async function sendPasswordResetEmail(to, resetUrl) {
  return sendTemplated(to, passwordResetEmail({ url: resetUrl }), `password reset link: ${resetUrl}`);
}

// Phase 7 (album revision lifecycle): best-effort notifications, same
// graceful pattern as every mailer here — no SMTP means a warn-log, and
// callers must never let a mail failure fail the request itself.
function albumMail(to, subject, lines, link, html) {
  const t = getTransporter();
  const text = [...lines, link ? `Open it here: ${link}` : null].filter(Boolean).join("\n");
  if (!t) {
    console.warn(`SMTP not configured — would have emailed ${to} (${subject}):\n${text}`);
    return Promise.resolve();
  }
  return t.sendMail({
    from: fromHeader(),
    to,
    subject,
    text,
    html: html || lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("") + (link ? `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>` : ""),
  });
}

export function albumReviewLink(eventId, albumId) {
  const base = (process.env.PUBLIC_WEB_URL || "").replace(/\/$/, "");
  if (!base) return null;
  return `${base}/client/${eventId}/albums/${albumId}`;
}

export async function sendAlbumSentEmail(to, { eventName, albumName, versionNumber, eventId, albumId }) {
  const link = albumReviewLink(eventId, albumId);
  const rendered = albumSentEmail({ eventName, albumName, versionNumber, url: link });
  return albumMail(
    to,
    rendered.subject,
    [
      `${eventName}: album “${albumName}” (v${versionNumber}) is ready for your review.`,
      `Flip through the spreads, drop pins where you want changes, then approve or request changes.`,
    ],
    link,
    rendered.html
  );
}

export async function sendAlbumChangesRequestedEmail(to, { eventName, albumName, clientName, message, eventId, albumId }) {
  const base = (process.env.PUBLIC_WEB_URL || "").replace(/\/$/, "");
  const link = base ? `${base}/events/${eventId}/albums/${albumId}` : null;
  const rendered = albumChangesEmail({ eventName, albumName, clientName, message, url: link });
  return albumMail(
    to,
    rendered.subject,
    [
      `${clientName || "The client"} requested changes on album “${albumName}” (${eventName}).`,
      message ? `Their note: ${message}` : null,
    ].filter(Boolean),
    link,
    rendered.html
  );
}

export async function sendAlbumApprovedEmail(to, { eventName, albumName, clientName, eventId, albumId }) {
  const base = (process.env.PUBLIC_WEB_URL || "").replace(/\/$/, "");
  const link = base ? `${base}/events/${eventId}/albums/${albumId}` : null;
  const rendered = albumApprovedEmail({ eventName, albumName, clientName, url: link });
  return albumMail(
    to,
    rendered.subject,
    [`${clientName || "The client"} approved album “${albumName}” (${eventName}) — it is now locked for print.`],
    link,
    rendered.html
  );
}
