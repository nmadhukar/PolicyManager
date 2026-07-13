-- Phase 12+: policy compare/redline, compliance evidence binder, advanced search
-- saved searches, and notification center. Additive and policytracker-only.

CREATE TYPE "policytracker"."SavedSearchScope" AS ENUM ('private', 'role', 'global');
CREATE TYPE "policytracker"."EvidenceBinderFormat" AS ENUM ('zip', 'combined_pdf');
CREATE TYPE "policytracker"."EvidenceBinderStatus" AS ENUM ('completed', 'failed');
CREATE TYPE "policytracker"."AppNotificationType" AS ENUM (
  'review_assigned',
  'acknowledgment_due',
  'policy_published',
  'comment_resolved',
  'approval_requested'
);
CREATE TYPE "policytracker"."NotificationPriority" AS ENUM ('low', 'normal', 'high');
CREATE TYPE "policytracker"."NotificationDigestFrequency" AS ENUM ('daily', 'weekly');
CREATE TYPE "policytracker"."NotificationChannel" AS ENUM ('in_app', 'email_digest');
CREATE TYPE "policytracker"."NotificationDeliveryStatus" AS ENUM (
  'pending',
  'sent',
  'failed',
  'skipped'
);

CREATE TABLE "policytracker"."SavedSearch" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "scope" "policytracker"."SavedSearchScope" NOT NULL DEFAULT 'private',
  "roleName" TEXT,
  "filters" JSONB NOT NULL,
  "sort" JSONB,
  "lastRunAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SavedSearch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SavedSearch_ownerId_name_key"
  ON "policytracker"."SavedSearch"("ownerId", "name");
CREATE INDEX "SavedSearch_ownerId_idx" ON "policytracker"."SavedSearch"("ownerId");
CREATE INDEX "SavedSearch_scope_idx" ON "policytracker"."SavedSearch"("scope");

ALTER TABLE "policytracker"."SavedSearch"
  ADD CONSTRAINT "SavedSearch_ownerId_fkey"
  FOREIGN KEY ("ownerId")
  REFERENCES "policytracker"."User"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

CREATE TABLE "policytracker"."EvidenceBinderJob" (
  "id" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "versionId" TEXT,
  "requestedById" TEXT NOT NULL,
  "format" "policytracker"."EvidenceBinderFormat" NOT NULL,
  "status" "policytracker"."EvidenceBinderStatus" NOT NULL,
  "includedSections" JSONB NOT NULL,
  "fileName" TEXT NOT NULL,
  "checksum" TEXT,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "EvidenceBinderJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EvidenceBinderJob_documentId_idx"
  ON "policytracker"."EvidenceBinderJob"("documentId");
CREATE INDEX "EvidenceBinderJob_requestedById_idx"
  ON "policytracker"."EvidenceBinderJob"("requestedById");
CREATE INDEX "EvidenceBinderJob_createdAt_idx"
  ON "policytracker"."EvidenceBinderJob"("createdAt");

ALTER TABLE "policytracker"."EvidenceBinderJob"
  ADD CONSTRAINT "EvidenceBinderJob_documentId_fkey"
  FOREIGN KEY ("documentId")
  REFERENCES "policytracker"."Document"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

ALTER TABLE "policytracker"."EvidenceBinderJob"
  ADD CONSTRAINT "EvidenceBinderJob_versionId_fkey"
  FOREIGN KEY ("versionId")
  REFERENCES "policytracker"."DocumentVersion"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

ALTER TABLE "policytracker"."EvidenceBinderJob"
  ADD CONSTRAINT "EvidenceBinderJob_requestedById_fkey"
  FOREIGN KEY ("requestedById")
  REFERENCES "policytracker"."User"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

CREATE TABLE "policytracker"."Notification" (
  "id" TEXT NOT NULL,
  "recipientId" TEXT NOT NULL,
  "actorId" TEXT,
  "type" "policytracker"."AppNotificationType" NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "entityType" TEXT,
  "entityId" TEXT,
  "documentId" TEXT,
  "documentVersionId" TEXT,
  "priority" "policytracker"."NotificationPriority" NOT NULL DEFAULT 'normal',
  "metadata" JSONB,
  "dedupeKey" TEXT,
  "readAt" TIMESTAMP(3),
  "dismissedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Notification_dedupeKey_key"
  ON "policytracker"."Notification"("dedupeKey");
CREATE INDEX "Notification_recipientId_readAt_dismissedAt_createdAt_idx"
  ON "policytracker"."Notification"("recipientId", "readAt", "dismissedAt", "createdAt");
CREATE INDEX "Notification_documentId_idx" ON "policytracker"."Notification"("documentId");
CREATE INDEX "Notification_type_idx" ON "policytracker"."Notification"("type");

ALTER TABLE "policytracker"."Notification"
  ADD CONSTRAINT "Notification_recipientId_fkey"
  FOREIGN KEY ("recipientId")
  REFERENCES "policytracker"."User"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "policytracker"."Notification"
  ADD CONSTRAINT "Notification_actorId_fkey"
  FOREIGN KEY ("actorId")
  REFERENCES "policytracker"."User"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

CREATE TABLE "policytracker"."NotificationPreference" (
  "userId" TEXT NOT NULL,
  "inAppEnabled" BOOLEAN NOT NULL DEFAULT true,
  "emailDigestEnabled" BOOLEAN NOT NULL DEFAULT false,
  "digestFrequency" "policytracker"."NotificationDigestFrequency" NOT NULL DEFAULT 'daily',
  "digestTimeLocal" TEXT NOT NULL DEFAULT '08:00',
  "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
  "typeOverrides" JSONB,
  "lastDigestSentAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "policytracker"."NotificationPreference"
  ADD CONSTRAINT "NotificationPreference_userId_fkey"
  FOREIGN KEY ("userId")
  REFERENCES "policytracker"."User"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

CREATE TABLE "policytracker"."NotificationDelivery" (
  "id" TEXT NOT NULL,
  "notificationId" TEXT,
  "recipientId" TEXT NOT NULL,
  "channel" "policytracker"."NotificationChannel" NOT NULL,
  "status" "policytracker"."NotificationDeliveryStatus" NOT NULL DEFAULT 'pending',
  "subject" TEXT,
  "sentAt" TIMESTAMP(3),
  "errorMessage" TEXT,
  "providerMessageId" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "NotificationDelivery_recipientId_channel_createdAt_idx"
  ON "policytracker"."NotificationDelivery"("recipientId", "channel", "createdAt");
CREATE INDEX "NotificationDelivery_notificationId_idx"
  ON "policytracker"."NotificationDelivery"("notificationId");

ALTER TABLE "policytracker"."NotificationDelivery"
  ADD CONSTRAINT "NotificationDelivery_notificationId_fkey"
  FOREIGN KEY ("notificationId")
  REFERENCES "policytracker"."Notification"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

ALTER TABLE "policytracker"."NotificationDelivery"
  ADD CONSTRAINT "NotificationDelivery_recipientId_fkey"
  FOREIGN KEY ("recipientId")
  REFERENCES "policytracker"."User"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;
