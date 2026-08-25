// Thin REST wrapper around Twilio's WhatsApp messaging API — no SDK
// dependency, just a fetch call with Basic Auth, same lightweight style as
// lib/googleDrive.js's raw Drive API calls. Left unconfigured (env vars
// unset), sendWhatsAppMessage logs instead of sending — same safe no-op
// pattern as lib/mailer.js when SMTP_HOST is unset.

function isConfigured() {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_WHATSAPP_FROM);
}

/** True if `phone` looks like a plausible E.164 number (+ followed by 8-15 digits). */
export function isValidE164(phone) {
  return typeof phone === "string" && /^\+[1-9]\d{7,14}$/.test(phone);
}

/**
 * Sends a WhatsApp text message to `to` (E.164 phone number, e.g.
 * "+919876543210"). Never throws on missing config — callers that need to
 * report a hard failure to the user should check isConfigured()-style logic
 * themselves; this function's job is just "best effort, don't crash a
 * request/job over a notification".
 */
export async function sendWhatsAppMessage(to, body) {
  if (!isConfigured()) {
    console.warn(`WhatsApp not configured — would have sent to ${to}: ${body}`);
    return;
  }

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM; // e.g. "whatsapp:+14155238886"

  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const params = new URLSearchParams({
    To: `whatsapp:${to}`,
    From: from,
    Body: body,
  });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`WhatsApp send failed (${res.status}): ${detail.slice(0, 200)}`);
  }
}
