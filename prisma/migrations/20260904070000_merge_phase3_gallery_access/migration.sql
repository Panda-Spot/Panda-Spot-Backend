-- Phase 3 (gallery access upgrade). Additive only: access mode + key
-- hash + expiry preset on Event. Defaults keep every existing event on
-- the public-link behavior it already has (accessMode public,
-- expiryPreset 90_days matching computeExpiresAt).
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "accessMode" TEXT NOT NULL DEFAULT 'public';
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "accessKeyHash" TEXT;
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "expiryPreset" TEXT NOT NULL DEFAULT '90_days';
