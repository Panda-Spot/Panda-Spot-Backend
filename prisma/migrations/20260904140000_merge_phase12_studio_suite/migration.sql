-- Phase 12 (business studio management). Additive only: tenant-scoped
-- pipeline tables. No backfill — studios build inquiries, packages,
-- contracts, questionnaires, bookings, and expenses going forward.
CREATE TABLE IF NOT EXISTS "BookingInquiry" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "phone" TEXT,
  "email" TEXT NOT NULL,
  "eventType" TEXT,
  "eventDate" TIMESTAMP(3),
  "message" TEXT,
  "status" TEXT NOT NULL DEFAULT 'new',
  "convertedEventId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BookingInquiry_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "BookingInquiry_tenantId_status_idx" ON "BookingInquiry"("tenantId", "status");
DO $$ BEGIN
  ALTER TABLE "BookingInquiry" ADD CONSTRAINT "BookingInquiry_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "StudioPackage" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "price" DECIMAL(10,2) NOT NULL,
  "deliverables" TEXT[] NOT NULL DEFAULT '{}',
  "includedPhotos" INTEGER NOT NULL DEFAULT 0,
  "includedAlbums" INTEGER NOT NULL DEFAULT 0,
  "includedEvents" INTEGER NOT NULL DEFAULT 1,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StudioPackage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "StudioPackage_tenantId_idx" ON "StudioPackage"("tenantId");
DO $$ BEGIN
  ALTER TABLE "StudioPackage" ADD CONSTRAINT "StudioPackage_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "ContractTemplate" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "filePath" TEXT NOT NULL,
  "fileSize" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContractTemplate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ContractTemplate_tenantId_idx" ON "ContractTemplate"("tenantId");
DO $$ BEGIN
  ALTER TABLE "ContractTemplate" ADD CONSTRAINT "ContractTemplate_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "ClientContract" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "templateId" TEXT,
  "eventId" TEXT,
  "clientEmail" TEXT NOT NULL,
  "clientUserId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'sent',
  "signatureName" TEXT,
  "acceptedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClientContract_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ClientContract_tenantId_status_idx" ON "ClientContract"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "ClientContract_clientEmail_idx" ON "ClientContract"("clientEmail");
DO $$ BEGIN
  ALTER TABLE "ClientContract" ADD CONSTRAINT "ClientContract_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "ClientContract" ADD CONSTRAINT "ClientContract_templateId_fkey"
    FOREIGN KEY ("templateId") REFERENCES "ContractTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "ClientContract" ADD CONSTRAINT "ClientContract_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "Questionnaire" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "questions" JSONB NOT NULL DEFAULT '[]',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Questionnaire_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Questionnaire_tenantId_idx" ON "Questionnaire"("tenantId");
DO $$ BEGIN
  ALTER TABLE "Questionnaire" ADD CONSTRAINT "Questionnaire_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "QuestionnaireAssignment" (
  "id" TEXT NOT NULL,
  "questionnaireId" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "clientEmail" TEXT,
  "clientUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "QuestionnaireAssignment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "QuestionnaireAssignment_questionnaireId_idx" ON "QuestionnaireAssignment"("questionnaireId");
CREATE INDEX IF NOT EXISTS "QuestionnaireAssignment_eventId_idx" ON "QuestionnaireAssignment"("eventId");
DO $$ BEGIN
  ALTER TABLE "QuestionnaireAssignment" ADD CONSTRAINT "QuestionnaireAssignment_questionnaireId_fkey"
    FOREIGN KEY ("questionnaireId") REFERENCES "Questionnaire"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "QuestionnaireAssignment" ADD CONSTRAINT "QuestionnaireAssignment_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "QuestionnaireResponse" (
  "id" TEXT NOT NULL,
  "assignmentId" TEXT NOT NULL,
  "answers" JSONB NOT NULL,
  "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "QuestionnaireResponse_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "QuestionnaireResponse_assignmentId_key" ON "QuestionnaireResponse"("assignmentId");
DO $$ BEGIN
  ALTER TABLE "QuestionnaireResponse" ADD CONSTRAINT "QuestionnaireResponse_assignmentId_fkey"
    FOREIGN KEY ("assignmentId") REFERENCES "QuestionnaireAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "Booking" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "inquiryId" TEXT,
  "clientName" TEXT NOT NULL,
  "clientEmail" TEXT,
  "clientPhone" TEXT,
  "eventType" TEXT,
  "eventDate" TIMESTAMP(3),
  "packageId" TEXT,
  "eventId" TEXT,
  "agreedAmount" DECIMAL(10,2),
  "billId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'inquiry',
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Booking_tenantId_status_idx" ON "Booking"("tenantId", "status");
DO $$ BEGIN
  ALTER TABLE "Booking" ADD CONSTRAINT "Booking_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "Booking" ADD CONSTRAINT "Booking_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "Expense" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "eventId" TEXT,
  "category" TEXT NOT NULL,
  "amount" DECIMAL(10,2) NOT NULL,
  "vendor" TEXT,
  "notes" TEXT,
  "spentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Expense_tenantId_idx" ON "Expense"("tenantId");
CREATE INDEX IF NOT EXISTS "Expense_eventId_idx" ON "Expense"("eventId");
DO $$ BEGIN
  ALTER TABLE "Expense" ADD CONSTRAINT "Expense_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "Expense" ADD CONSTRAINT "Expense_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
