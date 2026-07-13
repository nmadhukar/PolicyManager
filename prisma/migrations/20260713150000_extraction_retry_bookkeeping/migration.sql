-- Phase 10 fix: bounded-retry + stale-claim recovery for async extraction.
-- Additive and policytracker-only. No PolicyManager objects in public.

ALTER TABLE "policytracker"."DocumentVersion"
  ADD COLUMN "extractionAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "extractionStartedAt" TIMESTAMP(3);

-- Partial index for the worker's candidate scan (pending / retryable failed /
-- stale processing). Keeps the poll query off a full-table scan as the corpus grows.
CREATE INDEX "DocumentVersion_extraction_worker_idx"
  ON "policytracker"."DocumentVersion" ("extractionStatus", "extractionStartedAt");
