-- Phase 10 (lead capture + attendee export). Additive only: capture
-- mode on Event (disabled = existing behavior), plus lead + activity
-- tables. No backfill — guests appear as they visit.
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "leadCaptureMode" TEXT NOT NULL DEFAULT 'disabled';

CREATE TABLE IF NOT EXISTS "GuestLead" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "guestClientId" TEXT NOT NULL,
  "name" TEXT,
  "phone" TEXT,
  "email" TEXT,
  "guestType" TEXT NOT NULL DEFAULT 'guest',
  "consentGiven" BOOLEAN NOT NULL DEFAULT false,
  "consentText" TEXT,
  "consentVersion" TEXT NOT NULL DEFAULT 'v1',
  "source" TEXT,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GuestLead_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "GuestLead_eventId_guestClientId_key" ON "GuestLead"("eventId", "guestClientId");
CREATE INDEX IF NOT EXISTS "GuestLead_eventId_idx" ON "GuestLead"("eventId");
CREATE INDEX IF NOT EXISTS "GuestLead_guestClientId_idx" ON "GuestLead"("guestClientId");
DO $$ BEGIN
  ALTER TABLE "GuestLead" ADD CONSTRAINT "GuestLead_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "GuestActivity" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "guestClientId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "meta" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GuestActivity_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "GuestActivity_eventId_createdAt_idx" ON "GuestActivity"("eventId", "createdAt");
CREATE INDEX IF NOT EXISTS "GuestActivity_guestClientId_idx" ON "GuestActivity"("guestClientId");
DO $$ BEGIN
  ALTER TABLE "GuestActivity" ADD CONSTRAINT "GuestActivity_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
