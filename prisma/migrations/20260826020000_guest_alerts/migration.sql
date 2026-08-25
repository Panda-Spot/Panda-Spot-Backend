CREATE TABLE "GuestAlertSubscription" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "guestClientId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "contact" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastNotifiedAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "GuestAlertSubscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GuestAlertSubscription_eventId_guestClientId_key" ON "GuestAlertSubscription"("eventId", "guestClientId");

CREATE INDEX "GuestAlertSubscription_eventId_idx" ON "GuestAlertSubscription"("eventId");

ALTER TABLE "GuestAlertSubscription" ADD CONSTRAINT "GuestAlertSubscription_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
