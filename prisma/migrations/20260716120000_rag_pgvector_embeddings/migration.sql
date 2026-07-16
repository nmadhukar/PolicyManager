-- RAG Phase 1: pgvector extension + DocumentChunk + embedding lifecycle (ADR-0002).
-- Additive and policytracker-only. No PolicyManager objects in public.
-- The `vector` extension is installed INTO the policytracker schema (AGENTS.md §3;
-- ADR-0002 D1 is the explicit approval), so the vector type is referenced
-- schema-qualified as policytracker.vector.

CREATE EXTENSION IF NOT EXISTS vector SCHEMA "policytracker";

-- Embedding lifecycle enum (mirrors ExtractionStatus).
CREATE TYPE "policytracker"."EmbeddingStatus" AS ENUM (
  'pending',
  'processing',
  'done',
  'failed',
  'skipped'
);

-- Embedding lifecycle columns on the (otherwise immutable) DocumentVersion.
ALTER TABLE "policytracker"."DocumentVersion"
  ADD COLUMN "embeddingStatus"    "policytracker"."EmbeddingStatus" NOT NULL DEFAULT 'pending',
  ADD COLUMN "embeddingError"     TEXT,
  ADD COLUMN "embeddingAttempts"  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "embeddingStartedAt" TIMESTAMP(3),
  ADD COLUMN "embeddedAt"         TIMESTAMP(3);

CREATE INDEX "DocumentVersion_embeddingStatus_idx"
  ON "policytracker"."DocumentVersion"("embeddingStatus");

-- One row per embedded chunk. `embedding` is pgvector's vector(1536)
-- (OpenAI text-embedding-3-small); Prisma types it Unsupported("vector").
CREATE TABLE "policytracker"."DocumentChunk" (
  "id"             TEXT NOT NULL,
  "documentId"     TEXT NOT NULL,
  "versionId"      TEXT NOT NULL,
  "chunkIndex"     INTEGER NOT NULL,
  "content"        TEXT NOT NULL,
  "tokenCount"     INTEGER NOT NULL,
  "embedding"      "policytracker"."vector"(1536),
  "embeddingModel" TEXT NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DocumentChunk_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DocumentChunk_chunkIndex_nonneg_chk" CHECK ("chunkIndex" >= 0),
  CONSTRAINT "DocumentChunk_tokenCount_positive_chk" CHECK ("tokenCount" > 0)
);

-- Contiguous, unique chunk ordinals within a version (idempotent re-index).
CREATE UNIQUE INDEX "DocumentChunk_versionId_chunkIndex_key"
  ON "policytracker"."DocumentChunk"("versionId", "chunkIndex");

CREATE INDEX "DocumentChunk_documentId_idx"
  ON "policytracker"."DocumentChunk"("documentId");

CREATE INDEX "DocumentChunk_versionId_idx"
  ON "policytracker"."DocumentChunk"("versionId");

-- HNSW index for cosine similarity search (Phase 2/3 retrieval).
CREATE INDEX "DocumentChunk_embedding_idx"
  ON "policytracker"."DocumentChunk"
  USING hnsw ("embedding" "policytracker"."vector_cosine_ops");

ALTER TABLE "policytracker"."DocumentChunk"
  ADD CONSTRAINT "DocumentChunk_documentId_fkey"
  FOREIGN KEY ("documentId")
  REFERENCES "policytracker"."Document"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "policytracker"."DocumentChunk"
  ADD CONSTRAINT "DocumentChunk_versionId_fkey"
  FOREIGN KEY ("versionId")
  REFERENCES "policytracker"."DocumentVersion"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;
