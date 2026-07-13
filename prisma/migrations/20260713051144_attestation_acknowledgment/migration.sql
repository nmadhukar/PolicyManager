-- CreateEnum
CREATE TYPE "policytracker"."AttestationAction" AS ENUM ('reviewed', 'approved', 'acknowledged');

-- CreateEnum
CREATE TYPE "policytracker"."AckStatus" AS ENUM ('pending', 'completed', 'overdue', 'cancelled');

-- CreateTable
CREATE TABLE "policytracker"."Attestation" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "versionId" TEXT,
    "reviewTaskId" TEXT,
    "acknowledgmentAssignmentId" TEXT,
    "userId" TEXT NOT NULL,
    "action" "policytracker"."AttestationAction" NOT NULL,
    "signatureName" TEXT NOT NULL,
    "signatureRole" TEXT,
    "comments" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attestation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policytracker"."AcknowledgmentAssignment" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "assigneeId" TEXT NOT NULL,
    "assignedById" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3),
    "status" "policytracker"."AckStatus" NOT NULL DEFAULT 'pending',
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AcknowledgmentAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Attestation_documentId_idx" ON "policytracker"."Attestation"("documentId");

-- CreateIndex
CREATE INDEX "Attestation_versionId_idx" ON "policytracker"."Attestation"("versionId");

-- CreateIndex
CREATE INDEX "Attestation_userId_idx" ON "policytracker"."Attestation"("userId");

-- CreateIndex
CREATE INDEX "Attestation_action_idx" ON "policytracker"."Attestation"("action");

-- CreateIndex
CREATE INDEX "AcknowledgmentAssignment_documentId_idx" ON "policytracker"."AcknowledgmentAssignment"("documentId");

-- CreateIndex
CREATE INDEX "AcknowledgmentAssignment_assigneeId_idx" ON "policytracker"."AcknowledgmentAssignment"("assigneeId");

-- CreateIndex
CREATE INDEX "AcknowledgmentAssignment_status_idx" ON "policytracker"."AcknowledgmentAssignment"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AcknowledgmentAssignment_versionId_assigneeId_key" ON "policytracker"."AcknowledgmentAssignment"("versionId", "assigneeId");

-- AddForeignKey
ALTER TABLE "policytracker"."Attestation" ADD CONSTRAINT "Attestation_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "policytracker"."Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policytracker"."Attestation" ADD CONSTRAINT "Attestation_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "policytracker"."DocumentVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policytracker"."Attestation" ADD CONSTRAINT "Attestation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "policytracker"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policytracker"."Attestation" ADD CONSTRAINT "Attestation_reviewTaskId_fkey" FOREIGN KEY ("reviewTaskId") REFERENCES "policytracker"."ReviewTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policytracker"."Attestation" ADD CONSTRAINT "Attestation_acknowledgmentAssignmentId_fkey" FOREIGN KEY ("acknowledgmentAssignmentId") REFERENCES "policytracker"."AcknowledgmentAssignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policytracker"."AcknowledgmentAssignment" ADD CONSTRAINT "AcknowledgmentAssignment_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "policytracker"."Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policytracker"."AcknowledgmentAssignment" ADD CONSTRAINT "AcknowledgmentAssignment_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "policytracker"."DocumentVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policytracker"."AcknowledgmentAssignment" ADD CONSTRAINT "AcknowledgmentAssignment_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "policytracker"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policytracker"."AcknowledgmentAssignment" ADD CONSTRAINT "AcknowledgmentAssignment_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "policytracker"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
