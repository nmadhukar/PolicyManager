-- Data-integrity hardening (findings D1, D2, D3/C4, D7, D9/C2, D10, D12/C10).
-- Additive, policytracker-only. No PolicyManager objects in `public`.

-- ---------------------------------------------------------------------------
-- D1: attestation/acknowledgment evidence must survive a raw document/version
-- DELETE. Swap the Cascade FKs for RESTRICT so a purge fails loudly instead of
-- silently erasing immutable compliance sign-offs.
-- ---------------------------------------------------------------------------
-- DropForeignKey
ALTER TABLE "policytracker"."AcknowledgmentAssignment" DROP CONSTRAINT "AcknowledgmentAssignment_documentId_fkey";

-- DropForeignKey
ALTER TABLE "policytracker"."AcknowledgmentAssignment" DROP CONSTRAINT "AcknowledgmentAssignment_versionId_fkey";

-- DropForeignKey
ALTER TABLE "policytracker"."Attestation" DROP CONSTRAINT "Attestation_documentId_fkey";

-- ---------------------------------------------------------------------------
-- D3/C4: replace the plain documentNumber unique with a PARTIAL unique scoped
-- to live documents (below), so a re-import of a number whose only holder is
-- soft-deleted succeeds instead of colliding with the trashed row.
-- ---------------------------------------------------------------------------
-- DropIndex
DROP INDEX "policytracker"."Document_documentNumber_key";

-- ---------------------------------------------------------------------------
-- D2 + D10: persisted hasExtractedText flag (so reads never load @db.Text just
-- to compute a boolean) and sizeBytes widened to BIGINT.
-- ---------------------------------------------------------------------------
-- AlterTable
ALTER TABLE "policytracker"."DocumentVersion" ADD COLUMN     "hasExtractedText" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "sizeBytes" SET DATA TYPE BIGINT;

-- D2 backfill: derive the flag from existing text before it stops being read on hot paths.
UPDATE "policytracker"."DocumentVersion"
SET "hasExtractedText" = true
WHERE "extractedText" IS NOT NULL AND length("extractedText") > 0;

-- ---------------------------------------------------------------------------
-- D12/C10: no two sibling categories share a name. The compound unique covers
-- non-root rows; a partial unique (below) covers roots (parentId IS NULL), where
-- Postgres would otherwise treat NULLs as distinct.
-- ---------------------------------------------------------------------------
-- CreateIndex
CREATE UNIQUE INDEX "DocumentCategory_name_parentId_key" ON "policytracker"."DocumentCategory"("name", "parentId");

-- CreateIndex (D7 — dedup checksum lookup hot path)
CREATE INDEX "DocumentVersion_checksum_idx" ON "policytracker"."DocumentVersion"("checksum");

-- AddForeignKey (D1 — RESTRICT)
ALTER TABLE "policytracker"."Attestation" ADD CONSTRAINT "Attestation_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "policytracker"."Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (D1 — RESTRICT)
ALTER TABLE "policytracker"."AcknowledgmentAssignment" ADD CONSTRAINT "AcknowledgmentAssignment_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "policytracker"."Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (D1 — RESTRICT)
ALTER TABLE "policytracker"."AcknowledgmentAssignment" ADD CONSTRAINT "AcknowledgmentAssignment_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "policytracker"."DocumentVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Raw PARTIAL indexes (Prisma cannot express filtered indexes in the schema).
-- ---------------------------------------------------------------------------

-- D3/C4: documentNumber unique among LIVE documents only.
CREATE UNIQUE INDEX "Document_documentNumber_active_key"
  ON "policytracker"."Document" ("documentNumber")
  WHERE "deletedAt" IS NULL;

-- D9/C2: at most one OPEN review task per (document, assignee). Makes the review
-- sweep's check-then-create atomic — a concurrent double sweep cannot duplicate.
CREATE UNIQUE INDEX "ReviewTask_open_document_assignee_key"
  ON "policytracker"."ReviewTask" ("documentId", "assignedToId")
  WHERE "status" IN ('pending', 'in_progress', 'overdue');

-- D12/C10: root category names unique (companion to the compound unique above).
CREATE UNIQUE INDEX "DocumentCategory_name_root_key"
  ON "policytracker"."DocumentCategory" ("name")
  WHERE "parentId" IS NULL;
