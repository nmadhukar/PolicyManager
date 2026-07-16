-- RAG Phase 1: generic structural metadata model (ADR-0004, Option A).
-- Additive and policytracker-only; NO public objects, NO new table, NO enum, NO FK.
-- Every column is nullable / defaulted, so existing DocumentChunk and Document rows
-- stay valid as a clean "unstructured" state and the structure-aware chunker (a later
-- phase) fills the values lazily through the normal wholesale re-index.

-- --- Document: type discriminator + type-specific metadata ---------------------
ALTER TABLE "policytracker"."Document"
  ADD COLUMN "documentType" TEXT,
  ADD COLUMN "metadata"     JSONB NOT NULL DEFAULT '{}'::jsonb;

-- --- DocumentChunk: inline structural provenance ------------------------------
ALTER TABLE "policytracker"."DocumentChunk"
  ADD COLUMN "sectionType"                 TEXT,
  ADD COLUMN "sectionIdentifier"           TEXT,
  ADD COLUMN "normalizedSectionIdentifier" TEXT,
  ADD COLUMN "sectionTitle"                TEXT,
  ADD COLUMN "headingPath"                 TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN "pageStart"                   INTEGER,
  ADD COLUMN "pageEnd"                     INTEGER,
  ADD COLUMN "metadata"                    JSONB  NOT NULL DEFAULT '{}'::jsonb;

-- Page span sanity (mirrors the chunkIndex/tokenCount CHECKs from migration 120000).
-- Permits both-null and either-null; only rejects a genuinely inverted span.
ALTER TABLE "policytracker"."DocumentChunk"
  ADD CONSTRAINT "DocumentChunk_pageSpan_chk"
  CHECK ("pageStart" IS NULL OR "pageEnd" IS NULL OR "pageEnd" >= "pageStart");

-- Exact-identifier retrieval (ADR-0004 D4): PARTIAL btree indexes holding ONLY the
-- classified subset, so an unstructured corpus's NULLs never bloat them. Prisma emits
-- plain indexes of these names from the schema; we DROP-and-recreate them here as
-- partial so the on-disk shape matches the intent (idempotent via IF EXISTS).

-- "within this document, jump to Clause 8.3" + doc-scoped exact-match boost.
DROP INDEX IF EXISTS "policytracker"."DocumentChunk_documentId_normalizedSectionIdentifier_idx";
CREATE INDEX "DocumentChunk_documentId_normalizedSectionIdentifier_idx"
  ON "policytracker"."DocumentChunk" ("documentId", "normalizedSectionIdentifier")
  WHERE "normalizedSectionIdentifier" IS NOT NULL;

-- cross-corpus "find Policy 705 anywhere the user can see" (current-version filtering
-- still done by the retrieval JOIN on Document.currentVersionId).
DROP INDEX IF EXISTS "policytracker"."DocumentChunk_normalizedSectionIdentifier_idx";
CREATE INDEX "DocumentChunk_normalizedSectionIdentifier_idx"
  ON "policytracker"."DocumentChunk" ("normalizedSectionIdentifier")
  WHERE "normalizedSectionIdentifier" IS NOT NULL;

-- low-cardinality section-class filter, only over classified chunks.
DROP INDEX IF EXISTS "policytracker"."DocumentChunk_sectionType_idx";
CREATE INDEX "DocumentChunk_sectionType_idx"
  ON "policytracker"."DocumentChunk" ("sectionType")
  WHERE "sectionType" IS NOT NULL;
