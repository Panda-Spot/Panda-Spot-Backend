-- CreateTable
CREATE TABLE "EventCollaborator" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventCollaborator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventInvite" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),

    CONSTRAINT "EventInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EventCollaborator_eventId_userId_key" ON "EventCollaborator"("eventId", "userId");

-- CreateIndex
CREATE INDEX "EventCollaborator_userId_idx" ON "EventCollaborator"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "EventInvite_token_key" ON "EventInvite"("token");

-- CreateIndex
CREATE INDEX "EventInvite_eventId_idx" ON "EventInvite"("eventId");

-- CreateIndex
CREATE INDEX "EventInvite_email_idx" ON "EventInvite"("email");

-- AddForeignKey
ALTER TABLE "EventCollaborator" ADD CONSTRAINT "EventCollaborator_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventCollaborator" ADD CONSTRAINT "EventCollaborator_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventInvite" ADD CONSTRAINT "EventInvite_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
