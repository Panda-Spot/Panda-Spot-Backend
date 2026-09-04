-- Phase 2 (consent-first Face Search + privacy controls). Additive only:
-- 5 new Event privacy columns (safe defaults keep existing events
-- working), plus GuestConsent audit log and GuestDataRequest queue.
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "requireFaceSearchConsent" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "privacyNoticeText" TEXT;
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "selfieRetentionMode" TEXT NOT NULL DEFAULT 'process_only';
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "guestDataRetentionDays" INTEGER;
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "allowGuestDataDeleteRequest" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS "GuestConsent" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "guestClientId" TEXT NOT NULL,
  "consentedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consentText" TEXT NOT NULL,
  "consentVersion" TEXT NOT NULL DEFAULT 'v1',
  "ip" TEXT,
  "userAgent" TEXT,
  CONSTRAINT "GuestConsent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "GuestConsent_eventId_idx" ON "GuestConsent"("eventId");
CREATE INDEX IF NOT EXISTS "GuestConsent_guestClientId_idx" ON "GuestConsent"("guestClientId");
DO $$ BEGIN
  ALTER TABLE "GuestConsent" ADD CONSTRAINT "GuestConsent_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "GuestDataRequest" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "guestClientId" TEXT NOT NULL,
  "contact" TEXT,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "GuestDataRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "GuestDataRequest_eventId_status_idx" ON "GuestDataRequest"("eventId", "status");
CREATE INDEX IF NOT EXISTS "GuestDataRequest_guestClientId_idx" ON "GuestDataRequest"("guestClientId");
DO $$ BEGIN
  ALTER TABLE "GuestDataRequest" ADD CONSTRAINT "GuestDataRequest_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
