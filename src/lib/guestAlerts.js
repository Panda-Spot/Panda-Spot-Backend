import { prisma } from "./prisma.js";
import { getEffectiveThreshold } from "./threshold.js";
import { sendGuestAlertEmail } from "./mailer.js";
import { sendWhatsAppMessage } from "./whatsapp.js";

const PUBLIC_WEB_URL = process.env.PUBLIC_WEB_URL || "http://localhost:5173";

// A guest doesn't get pinged more than once this often, even if several
// batches of new photos land close together (Beam adds photos one at a
// time during a live shoot) — keeps notifications a manageable trickle.
const MIN_NOTIFY_INTERVAL_MS = 15 * 60 * 1000;

export function isValidEmail(value) {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** Creates or updates a guest's alert subscription for one event. */
export async function subscribeGuestAlert({ eventId, guestClientId, channel, contact }) {
  return prisma.guestAlertSubscription.upsert({
    where: { eventId_guestClientId: { eventId, guestClientId } },
    update: { channel, contact, active: true },
    create: { eventId, guestClientId, channel, contact },
  });
}

/** Turns off alerts for a guest on one event — idempotent, no-op if there was no subscription. */
export async function unsubscribeGuestAlert({ eventId, guestClientId }) {
  await prisma.guestAlertSubscription.updateMany({
    where: { eventId, guestClientId },
    data: { active: false },
  });
}

/**
 * Of `photoIds`, returns the ones whose best face match against a guest's
 * most recent search embedding for this event clears `threshold` — entirely
 * in SQL (the pgvector embedding never leaves Postgres) since it's an
 * Unsupported type Prisma Client can't bind directly, same reasoning as
 * lib/faces.js's searchSimilarPhotos.
 */
async function matchedPhotosForGuest({ eventId, guestClientId, photoIds, threshold }) {
  const rows = await prisma.$queryRaw`
    SELECT f."photoId" AS "photoId"
    FROM "Face" f
    JOIN "GuestSearch" gs ON gs.id = (
      SELECT id FROM "GuestSearch"
      WHERE "eventId" = ${eventId} AND "guestClientId" = ${guestClientId}
      ORDER BY "createdAt" DESC
      LIMIT 1
    )
    WHERE f."eventId" = ${eventId} AND f."photoId" = ANY(${photoIds}::text[])
    GROUP BY f."photoId"
    HAVING MAX(1 - (f.embedding <=> gs.embedding)) >= ${threshold}
  `;
  return rows.map((r) => r.photoId);
}

/**
 * Checks every active guest alert subscription on `event` against a batch of
 * newly-added photo ids, and notifies (email or WhatsApp) any guest whose
 * earlier selfie now matches one or more of them. Called after a batch of
 * uploads/Drive-imports finishes, and after each Beam capture — never
 * throws, since it runs as a side effect of photo ingestion and a
 * notification failure shouldn't affect the ingestion result.
 */
export async function checkAndNotifyForNewPhotos(event, newPhotoIds) {
  if (!newPhotoIds || newPhotoIds.length === 0) return;

  let subs;
  try {
    subs = await prisma.guestAlertSubscription.findMany({ where: { eventId: event.id, active: true } });
  } catch (err) {
    console.error(`Failed to load guest alert subscriptions for event ${event.id}:`, err);
    return;
  }
  if (subs.length === 0) return;

  const threshold = getEffectiveThreshold(event);
  const galleryUrl = `${PUBLIC_WEB_URL}/e/${event.guestSlug}`;

  for (const sub of subs) {
    if (sub.lastNotifiedAt && Date.now() - sub.lastNotifiedAt.getTime() < MIN_NOTIFY_INTERVAL_MS) continue;

    let matchedPhotoIds;
    try {
      matchedPhotoIds = await matchedPhotosForGuest({
        eventId: event.id,
        guestClientId: sub.guestClientId,
        photoIds: newPhotoIds,
        threshold,
      });
    } catch (err) {
      console.error(`Guest alert matching failed for subscription ${sub.id}:`, err);
      continue;
    }
    if (matchedPhotoIds.length === 0) continue;

    try {
      if (sub.channel === "whatsapp") {
        await sendWhatsAppMessage(
          sub.contact,
          `${matchedPhotoIds.length} new photo${matchedPhotoIds.length === 1 ? "" : "s"} of you just showed up at "${event.name}" on PandaSpot: ${galleryUrl}`
        );
      } else {
        await sendGuestAlertEmail(sub.contact, event.name, galleryUrl, matchedPhotoIds.length);
      }
      await prisma.guestAlertSubscription.update({
        where: { id: sub.id },
        data: { lastNotifiedAt: new Date() },
      });
    } catch (err) {
      console.error(`Failed to notify guest alert subscription ${sub.id}:`, err);
    }
  }
}
