-- Support tickets now distinguish the studio/admin responsible for a ticket
-- from the logged-in user who raised it. Existing tenant-raised tickets are
-- backfilled as self-requested so old behavior is preserved.

ALTER TABLE "SupportTicket" ADD COLUMN "requesterId" TEXT;
ALTER TABLE "SupportTicket" ADD COLUMN "eventId" TEXT;

UPDATE "SupportTicket"
SET "requesterId" = "tenantId"
WHERE "requesterId" IS NULL;

ALTER TABLE "SupportTicket" ALTER COLUMN "requesterId" SET NOT NULL;

CREATE INDEX "SupportTicket_requesterId_idx" ON "SupportTicket"("requesterId");
CREATE INDEX "SupportTicket_eventId_idx" ON "SupportTicket"("eventId");

ALTER TABLE "SupportTicket"
ADD CONSTRAINT "SupportTicket_requesterId_fkey"
FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SupportTicket"
ADD CONSTRAINT "SupportTicket_eventId_fkey"
FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;
