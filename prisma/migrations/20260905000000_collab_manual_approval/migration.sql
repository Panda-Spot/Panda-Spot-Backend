-- Manual collaborator approval: track declines separately so owners can see
-- pending / accepted / declined history with timestamps. Additive only.
ALTER TABLE "EventInvite" ADD COLUMN IF NOT EXISTS "declinedAt" TIMESTAMP(3);
