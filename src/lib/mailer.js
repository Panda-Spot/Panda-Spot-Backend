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
    `Your Beam-captured photos for "${eventName}" are temporarily backed up to a shared Google Drive relay — ` +
    `not stored permanently there or on PandaSpot's own servers. To keep them, open the Drive folder, select ` +
    `all the files, and choose "Make a copy" — that copy is fully yours, in your own Drive storage.\n\n` +
    `Timeline: files still in the shared relay are removed from Drive after 2 days (pulled back to PandaSpot's ` +
    `server as a last resort), and permanently deleted everywhere 7 days after they were captured. After that, ` +
    `they cannot be recovered.\n\n` +
    (driveFolderUrl ? `Drive folder: ${driveFolderUrl}\n\n` : "") +
    `This only affects photos captured via Beam with Drive backup turned on for this event.`;
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
