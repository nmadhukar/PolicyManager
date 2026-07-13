-- CreateEnum
CREATE TYPE "policytracker"."DocumentStatus" AS ENUM ('draft', 'in_review', 'approved', 'published', 'archived', 'retired');

-- CreateEnum
CREATE TYPE "policytracker"."AccessLevel" AS ENUM ('public', 'restricted', 'confidential');

-- CreateEnum
CREATE TYPE "policytracker"."ReviewCadence" AS ENUM ('none', 'quarterly', 'annual', 'custom');

-- CreateTable
CREATE TABLE "policytracker"."DocumentCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policytracker"."Document" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "documentNumber" TEXT,
    "categoryId" TEXT,
    "ownerId" TEXT NOT NULL,
    "description" TEXT,
    "tags" TEXT[],
    "status" "policytracker"."DocumentStatus" NOT NULL DEFAULT 'draft',
    "accessLevel" "policytracker"."AccessLevel" NOT NULL DEFAULT 'restricted',
    "currentVersionId" TEXT,
    "reviewCadence" "policytracker"."ReviewCadence" NOT NULL DEFAULT 'none',
    "nextReviewDate" TIMESTAMP(3),
    "effectiveDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policytracker"."DocumentVersion" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "s3Key" TEXT NOT NULL,
    "s3VersionId" TEXT,
    "renditionS3Key" TEXT,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "changeSummary" TEXT,
    "status" "policytracker"."DocumentStatus" NOT NULL DEFAULT 'draft',
    "extractedText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DocumentCategory_parentId_idx" ON "policytracker"."DocumentCategory"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "Document_documentNumber_key" ON "policytracker"."Document"("documentNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Document_currentVersionId_key" ON "policytracker"."Document"("currentVersionId");

-- CreateIndex
CREATE INDEX "Document_title_idx" ON "policytracker"."Document"("title");

-- CreateIndex
CREATE INDEX "Document_categoryId_idx" ON "policytracker"."Document"("categoryId");

-- CreateIndex
CREATE INDEX "Document_ownerId_idx" ON "policytracker"."Document"("ownerId");

-- CreateIndex
CREATE INDEX "Document_status_idx" ON "policytracker"."Document"("status");

-- CreateIndex
CREATE INDEX "Document_nextReviewDate_idx" ON "policytracker"."Document"("nextReviewDate");

-- CreateIndex
CREATE INDEX "DocumentVersion_documentId_idx" ON "policytracker"."DocumentVersion"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentVersion_documentId_versionNumber_key" ON "policytracker"."DocumentVersion"("documentId", "versionNumber");

-- AddForeignKey
ALTER TABLE "policytracker"."DocumentCategory" ADD CONSTRAINT "DocumentCategory_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "policytracker"."DocumentCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policytracker"."Document" ADD CONSTRAINT "Document_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "policytracker"."DocumentCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policytracker"."Document" ADD CONSTRAINT "Document_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "policytracker"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policytracker"."Document" ADD CONSTRAINT "Document_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "policytracker"."DocumentVersion"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "policytracker"."DocumentVersion" ADD CONSTRAINT "DocumentVersion_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "policytracker"."Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policytracker"."DocumentVersion" ADD CONSTRAINT "DocumentVersion_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "policytracker"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
