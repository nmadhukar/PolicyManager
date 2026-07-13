-- CreateEnum
CREATE TYPE "policytracker"."ImportItemStatus" AS ENUM ('pending', 'created', 'duplicate', 'error', 'skipped');

-- CreateTable
CREATE TABLE "policytracker"."ImportBatch" (
    "id" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "fileName" TEXT,
    "totalRows" INTEGER NOT NULL,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "duplicateCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policytracker"."ImportItem" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "title" TEXT,
    "documentNumber" TEXT,
    "categoryName" TEXT,
    "fileName" TEXT,
    "status" "policytracker"."ImportItemStatus" NOT NULL DEFAULT 'pending',
    "documentId" TEXT,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportBatch_createdById_idx" ON "policytracker"."ImportBatch"("createdById");

-- CreateIndex
CREATE INDEX "ImportBatch_createdAt_idx" ON "policytracker"."ImportBatch"("createdAt");

-- CreateIndex
CREATE INDEX "ImportItem_batchId_idx" ON "policytracker"."ImportItem"("batchId");

-- AddForeignKey
ALTER TABLE "policytracker"."ImportBatch" ADD CONSTRAINT "ImportBatch_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "policytracker"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policytracker"."ImportItem" ADD CONSTRAINT "ImportItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "policytracker"."ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policytracker"."ImportItem" ADD CONSTRAINT "ImportItem_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "policytracker"."Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
