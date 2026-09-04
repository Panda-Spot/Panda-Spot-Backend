import nodemailer from "nodemailer";

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

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export async function sendStudioCredentialsEmail(to, studioName, email, temporaryPassword, loginUrl) {
  const t = getTransporter();
  const subject = "Your PandaSpot studio account is ready";
  const text =
    `Your PandaSpot studio account has been created.\n\n` +
    `Studio: ${studioName || "PandaSpot Studio"}\n` +
    `Login: ${loginUrl}\n` +
    `Email: ${email}\n` +
    `Temporary password: ${temporaryPassword}\n\n` +
    `Sign in and change this password from your account settings.`;
  if (!t) {
    console.warn(`SMTP not configured — would have emailed ${to} the studio credentials:\n${text}`);
    return;
  }
  await t.sendMail({
    from: process.env.SMTP_FROM || "PandaSpot <no-reply@pandaspot.example>",
    to,
    subject,
    text,
    html:
      `<p>Your PandaSpot studio account has been created.</p>` +
      `<p><strong>Studio:</strong> ${escapeHtml(studioName || "PandaSpot Studio")}<br>` +
      `<strong>Login:</strong> <a href="${escapeHtml(loginUrl)}">${escapeHtml(loginUrl)}</a><br>` +
      `<strong>Email:</strong> ${escapeHtml(email)}<br>` +
      `<strong>Temporary password:</strong> ${escapeHtml(temporaryPassword)}</p>` +
      `<p>Sign in and change this password from your account settings.</p>`,
  });
}

export async function sendZipReadyEmail(to, downloadUrl) {
  const t = getTransporter();
  if (!t) {
    console.warn(`SMTP not configured — would have emailed ${to} the link: ${downloadUrl}`);
    return;
  }
  await t.sendMail({
    from: process.env.SMTP_FROM || "PandaSpot <no-reply@pandaspot.example>",
    to,
    subject: "Your PandaSpot photos are ready",
    text: `Your photos are ready to download: ${downloadUrl}`,
    html: `<p>Your photos are ready to download.</p><p><a href="${downloadUrl}">${downloadUrl}</a></p>`,
  });
}

export async function sendCollaboratorInviteEmail(to, eventName, inviteUrl) {
  const t = getTransporter();
  if (!t) {
    console.warn(`SMTP not configured — would have emailed ${to} the invite link: ${inviteUrl}`);
    return;
  }
  await t.sendMail({
    from: process.env.SMTP_FROM || "PandaSpot <no-reply@pandaspot.example>",
    to,
    subject: `You've been invited to help shoot "${eventName}" on PandaSpot`,
    text: `You've been invited to collaborate on the event "${eventName}" on PandaSpot: ${inviteUrl}`,
    html: `<p>You've been invited to collaborate on the event "${eventName}" on PandaSpot.</p><p><a href="${inviteUrl}">${inviteUrl}</a></p>`,
  });
}

/// MERGE (Studio-Verse): invites a client to log in and browse/favourite
/// this event's gallery (Photo Selection) — distinct from
/// sendCollaboratorInviteEmail above, which is for staff/second-shooter
/// access, not client-facing.
export async function sendClientInviteEmail(to, eventName, inviteUrl) {
  const t = getTransporter();
  if (!t) {
    console.warn(`SMTP not configured — would have emailed ${to} the client invite link: ${inviteUrl}`);
    return;
  }
  await t.sendMail({
    from: process.env.SMTP_FROM || "PandaSpot <no-reply@pandaspot.example>",
    to,
    subject: `Your photos from "${eventName}" are ready to view`,
    text: `You've been invited to browse and favourite your photos from "${eventName}" on PandaSpot: ${inviteUrl}`,
    html: `<p>You've been invited to browse and favourite your photos from "${eventName}" on PandaSpot.</p><p><a href="${inviteUrl}">${inviteUrl}</a></p>`,
  });
}

export async function sendEmailVerificationEmail(to, verifyUrl) {
  const t = getTransporter();
  if (!t) {
    console.warn(`SMTP not configured — would have emailed ${to} the verification link: ${verifyUrl}`);
    return;
  }
  await t.sendMail({
    from: process.env.SMTP_FROM || "PandaSpot <no-reply@pandaspot.example>",
    to,
    subject: "Verify your PandaSpot email address",
    text: `Please verify your email address: ${verifyUrl}`,
    html: `<p>Please verify your email address.</p><p><a href="${verifyUrl}">${verifyUrl}</a></p>`,
  });
}

export async function sendGuestAlertEmail(to, eventName, galleryUrl, newPhotoCount) {
  const t = getTransporter();
  const plural = newPhotoCount === 1 ? "photo" : "photos";
  if (!t) {
    console.warn(`SMTP not configured — would have emailed ${to} about ${newPhotoCount} new match(es): ${galleryUrl}`);
    return;
  }
  await t.sendMail({
    from: process.env.SMTP_FROM || "PandaSpot <no-reply@pandaspot.example>",
    to,
    subject: `${newPhotoCount} new ${plural} of you at "${eventName}"`,
    text: `${newPhotoCount} new ${plural} of you just showed up at "${eventName}": ${galleryUrl}`,
    html: `<p>${newPhotoCount} new ${plural} of you just showed up at "${eventName}".</p><p><a href="${galleryUrl}">${galleryUrl}</a></p>`,
  });
}

export async function sendDriveBackupReclaimNoticeEmail(to, eventName, driveFolderUrl) {
  const t = getTransporter();
  const subject = `Action needed: save your own copy of "${eventName}"'s photos`;
  const body =
    `Your Shoots-captured photos for "${eventName}" are temporarily backed up to a shared Google Drive relay — ` +
    `not stored permanently there or on PandaSpot's own servers. To keep them, open the Drive folder, select ` +
    `all the files, and choose "Make a copy" — that copy is fully yours, in your own Drive storage.\n\n` +
    `Timeline: files still in the shared relay are removed from Drive after 2 days (pulled back to PandaSpot's ` +
    `server as a last resort), and permanently deleted everywhere 7 days after they were captured. After that, ` +
    `they cannot be recovered.\n\n` +
    (driveFolderUrl ? `Drive folder: ${driveFolderUrl}\n\n` : "") +
    `This only affects photos captured via Shoots with Drive backup turned on for this event.`;
  if (!t) {
    console.warn(`SMTP not configured — would have emailed ${to}:\nSubject: ${subject}\n${body}`);
    return;
  }
  await t.sendMail({
    from: process.env.SMTP_FROM || "PandaSpot <no-reply@pandaspot.example>",
    to,
    subject,
    text: body,
    html: `<p>${body.replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>`,
  });
}

export async function sendPasswordResetEmail(to, resetUrl) {
  const t = getTransporter();
  if (!t) {
    console.warn(`SMTP not configured — would have emailed ${to} the password reset link: ${resetUrl}`);
    return;
  }
  await t.sendMail({
    from: process.env.SMTP_FROM || "PandaSpot <no-reply@pandaspot.example>",
    to,
    subject: "Reset your PandaSpot password",
    text: `Reset your password: ${resetUrl}`,
    html: `<p>Reset your password.</p><p><a href="${resetUrl}">${resetUrl}</a></p>`,
  });
}

// Phase 7 (album revision lifecycle): best-effort notifications, same
// graceful pattern as every mailer here — no SMTP means a warn-log, and
// callers must never let a mail failure fail the request itself.
function albumMail(to, subject, lines, link) {
  const t = getTransporter();
  const text = [...lines, link ? `Open it here: ${link}` : null].filter(Boolean).join("\n");
  if (!t) {
    console.warn(`SMTP not configured — would have emailed ${to} (${subject}):\n${text}`);
    return Promise.resolve();
  }
  return t.sendMail({
    from: process.env.SMTP_FROM || "PandaSpot <no-reply@pandaspot.example>",
    to,
    subject,
    text,
    html: lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("") + (link ? `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>` : ""),
  });
}

export function albumReviewLink(eventId, albumId) {
  const base = (process.env.PUBLIC_WEB_URL || "").replace(/\/$/, "");
  if (!base) return null;
  return `${base}/client/${eventId}/albums/${albumId}`;
}

export async function sendAlbumSentEmail(to, { eventName, albumName, versionNumber, eventId, albumId }) {
  return albumMail(
    to,
    `Your album “${albumName}” is ready for review`,
    [
      `${eventName}: album “${albumName}” (v${versionNumber}) is ready for your review.`,
      `Flip through the spreads, drop pins where you want changes, then approve or request changes.`,
    ],
    albumReviewLink(eventId, albumId)
  );
}

export async function sendAlbumChangesRequestedEmail(to, { eventName, albumName, clientName, message, eventId, albumId }) {
  const base = (process.env.PUBLIC_WEB_URL || "").replace(/\/$/, "");
  return albumMail(
    to,
    `Changes requested on “${albumName}”`,
    [
      `${clientName || "The client"} requested changes on album “${albumName}” (${eventName}).`,
      message ? `Their note: ${message}` : null,
    ].filter(Boolean),
    base ? `${base}/events/${eventId}/albums/${albumId}` : null
  );
}

export async function sendAlbumApprovedEmail(to, { eventName, albumName, clientName, eventId, albumId }) {
  const base = (process.env.PUBLIC_WEB_URL || "").replace(/\/$/, "");
  return albumMail(
    to,
    `Album approved: “${albumName}”`,
    [`${clientName || "The client"} approved album “${albumName}” (${eventName}) — it is now locked for print.`],
    base ? `${base}/events/${eventId}/albums/${albumId}` : null
  );
}
