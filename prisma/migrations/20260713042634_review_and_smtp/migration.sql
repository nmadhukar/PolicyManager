-- CreateEnum
CREATE TYPE "policytracker"."ReviewTaskStatus" AS ENUM ('pending', 'in_progress', 'completed', 'overdue', 'cancelled');

-- CreateTable
CREATE TABLE "policytracker"."ReviewAssignment" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "ReviewAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policytracker"."ReviewTask" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "versionId" TEXT,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "assignedToId" TEXT NOT NULL,
    "status" "policytracker"."ReviewTaskStatus" NOT NULL DEFAULT 'pending',
    "completedAt" TIMESTAMP(3),
    "completedById" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policytracker"."SmtpConfig" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "secure" BOOLEAN NOT NULL DEFAULT false,
    "username" TEXT,
    "passwordEncrypted" TEXT,
    "fromAddress" TEXT NOT NULL,
    "fromName" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "SmtpConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policytracker"."NotificationLog" (
    "id" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "toUserId" TEXT,
    "subject" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "reviewTaskId" TEXT,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReviewAssignment_documentId_idx" ON "policytracker"."ReviewAssignment"("documentId");

-- CreateIndex
CREATE INDEX "ReviewAssignment_reviewerId_idx" ON "policytracker"."ReviewAssignment"("reviewerId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewAssignment_documentId_reviewerId_key" ON "policytracker"."ReviewAssignment"("documentId", "reviewerId");

-- CreateIndex
CREATE INDEX "ReviewTask_documentId_idx" ON "policytracker"."ReviewTask"("documentId");

-- CreateIndex
CREATE INDEX "ReviewTask_assignedToId_idx" ON "policytracker"."ReviewTask"("assignedToId");

-- CreateIndex
CREATE INDEX "ReviewTask_status_idx" ON "policytracker"."ReviewTask"("status");

-- CreateIndex
CREATE INDEX "ReviewTask_dueDate_idx" ON "policytracker"."ReviewTask"("dueDate");

-- CreateIndex
CREATE INDEX "NotificationLog_createdAt_idx" ON "policytracker"."NotificationLog"("createdAt");

-- CreateIndex
CREATE INDEX "NotificationLog_type_idx" ON "policytracker"."NotificationLog"("type");

-- AddForeignKey
ALTER TABLE "policytracker"."ReviewAssignment" ADD CONSTRAINT "ReviewAssignment_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "policytracker"."Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policytracker"."ReviewAssignment" ADD CONSTRAINT "ReviewAssignment_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "policytracker"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policytracker"."ReviewAssignment" ADD CONSTRAINT "ReviewAssignment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "policytracker"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policytracker"."ReviewTask" ADD CONSTRAINT "ReviewTask_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "policytracker"."Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policytracker"."ReviewTask" ADD CONSTRAINT "ReviewTask_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "policytracker"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policytracker"."ReviewTask" ADD CONSTRAINT "ReviewTask_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "policytracker"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
