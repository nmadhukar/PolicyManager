-- CreateEnum
CREATE TYPE "policytracker"."AclPrincipalType" AS ENUM ('role', 'user');

-- CreateEnum
CREATE TYPE "policytracker"."AclPermission" AS ENUM ('view', 'download', 'edit', 'approve');

-- CreateEnum
CREATE TYPE "policytracker"."AuditSource" AS ENUM ('web', 'api', 'system');

-- CreateTable
CREATE TABLE "policytracker"."DocumentAcl" (
    "id" TEXT NOT NULL,
    "documentId" TEXT,
    "categoryId" TEXT,
    "principalType" "policytracker"."AclPrincipalType" NOT NULL,
    "principalId" TEXT NOT NULL,
    "permission" "policytracker"."AclPermission" NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentAcl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policytracker"."AuditEvent" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT,
    "apiClientId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "documentId" TEXT,
    "versionId" TEXT,
    "source" "policytracker"."AuditSource" NOT NULL DEFAULT 'web',
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DocumentAcl_documentId_idx" ON "policytracker"."DocumentAcl"("documentId");

-- CreateIndex
CREATE INDEX "DocumentAcl_categoryId_idx" ON "policytracker"."DocumentAcl"("categoryId");

-- CreateIndex
CREATE INDEX "DocumentAcl_principalType_principalId_idx" ON "policytracker"."DocumentAcl"("principalType", "principalId");

-- CreateIndex
CREATE INDEX "AuditEvent_documentId_idx" ON "policytracker"."AuditEvent"("documentId");

-- CreateIndex
CREATE INDEX "AuditEvent_actorUserId_idx" ON "policytracker"."AuditEvent"("actorUserId");

-- CreateIndex
CREATE INDEX "AuditEvent_createdAt_idx" ON "policytracker"."AuditEvent"("createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_action_idx" ON "policytracker"."AuditEvent"("action");

-- AddForeignKey
ALTER TABLE "policytracker"."DocumentAcl" ADD CONSTRAINT "DocumentAcl_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "policytracker"."Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policytracker"."DocumentAcl" ADD CONSTRAINT "DocumentAcl_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "policytracker"."DocumentCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policytracker"."DocumentAcl" ADD CONSTRAINT "DocumentAcl_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "policytracker"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policytracker"."AuditEvent" ADD CONSTRAINT "AuditEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "policytracker"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policytracker"."AuditEvent" ADD CONSTRAINT "AuditEvent_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "policytracker"."Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
