-- Phase 10/11: OCR/search status and review annotations.
-- Additive and policytracker-only. No PolicyManager objects in public.

CREATE TYPE "policytracker"."ExtractionStatus" AS ENUM (
  'pending',
  'processing',
  'done',
  'failed',
  'skipped'
);

CREATE TYPE "policytracker"."AnnotationType" AS ENUM (
  'comment',
  'issue',
  'suggested_change'
);

CREATE TYPE "policytracker"."AnnotationStatus" AS ENUM (
  'open',
  'resolved'
);

ALTER TABLE "policytracker"."DocumentVersion"
  ADD COLUMN "extractionStatus" "policytracker"."ExtractionStatus" NOT NULL DEFAULT 'pending',
  ADD COLUMN "extractionError" TEXT,
  ADD COLUMN "ocrApplied" BOOLEAN NOT NULL DEFAULT false;

-- Stored generated tsvector for current and future search backends. It is
-- derived only from version-local metadata/text; document metadata is still
-- searched in query SQL so the column stays immutable without cross-table
-- triggers.
ALTER TABLE "policytracker"."DocumentVersion"
  ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("fileName", '')), 'B') ||
    setweight(to_tsvector('english', coalesce("extractedText", '')), 'C')
  ) STORED;

UPDATE "policytracker"."DocumentVersion"
SET "extractionStatus" = CASE
  WHEN "hasExtractedText" THEN 'done'::"policytracker"."ExtractionStatus"
  ELSE 'pending'::"policytracker"."ExtractionStatus"
END;

CREATE INDEX "DocumentVersion_extractionStatus_idx"
  ON "policytracker"."DocumentVersion"("extractionStatus");

CREATE INDEX "DocumentVersion_searchVector_idx"
  ON "policytracker"."DocumentVersion"
  USING GIN ("searchVector");

CREATE TABLE "policytracker"."DocumentAnnotation" (
  "id" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "versionId" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "type" "policytracker"."AnnotationType" NOT NULL DEFAULT 'comment',
  "status" "policytracker"."AnnotationStatus" NOT NULL DEFAULT 'open',
  "pageNumber" INTEGER NOT NULL,
  "x" DECIMAL(6,5) NOT NULL,
  "y" DECIMAL(6,5) NOT NULL,
  "width" DECIMAL(6,5) NOT NULL,
  "height" DECIMAL(6,5) NOT NULL,
  "body" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "resolvedAt" TIMESTAMP(3),
  "resolvedById" TEXT,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "DocumentAnnotation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DocumentAnnotation_page_positive_chk" CHECK ("pageNumber" > 0),
  CONSTRAINT "DocumentAnnotation_rect_bounds_chk" CHECK (
    "x" >= 0 AND "x" <= 1 AND
    "y" >= 0 AND "y" <= 1 AND
    "width" > 0 AND "width" <= 1 AND
    "height" > 0 AND "height" <= 1 AND
    ("x" + "width") <= 1 AND
    ("y" + "height") <= 1
  )
);

CREATE INDEX "DocumentAnnotation_documentId_versionId_status_idx"
  ON "policytracker"."DocumentAnnotation"("documentId", "versionId", "status");

CREATE INDEX "DocumentAnnotation_authorId_idx"
  ON "policytracker"."DocumentAnnotation"("authorId");

CREATE INDEX "DocumentAnnotation_resolvedById_idx"
  ON "policytracker"."DocumentAnnotation"("resolvedById");

CREATE INDEX "DocumentAnnotation_deletedAt_idx"
  ON "policytracker"."DocumentAnnotation"("deletedAt");

ALTER TABLE "policytracker"."DocumentAnnotation"
  ADD CONSTRAINT "DocumentAnnotation_documentId_fkey"
  FOREIGN KEY ("documentId")
  REFERENCES "policytracker"."Document"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "policytracker"."DocumentAnnotation"
  ADD CONSTRAINT "DocumentAnnotation_versionId_fkey"
  FOREIGN KEY ("versionId")
  REFERENCES "policytracker"."DocumentVersion"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "policytracker"."DocumentAnnotation"
  ADD CONSTRAINT "DocumentAnnotation_authorId_fkey"
  FOREIGN KEY ("authorId")
  REFERENCES "policytracker"."User"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

ALTER TABLE "policytracker"."DocumentAnnotation"
  ADD CONSTRAINT "DocumentAnnotation_resolvedById_fkey"
  FOREIGN KEY ("resolvedById")
  REFERENCES "policytracker"."User"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
