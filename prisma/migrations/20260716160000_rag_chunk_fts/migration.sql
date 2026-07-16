-- RAG: chunk-level full-text search, required for true hybrid retrieval.
-- Full-text search previously only ranked Document/DocumentVersion metadata
-- (title, documentNumber, description, whole-version searchVector), so it could
-- only ever say "this document is lexically relevant" -- never surface a
-- specific chunk independently of vector search. This column lets FTS retrieve
-- chunks on its own, the same way DocumentVersion.searchVector already does for
-- documents (same GENERATED ALWAYS ... STORED pattern, no cross-table trigger).

ALTER TABLE "policytracker"."DocumentChunk"
  ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', "content")) STORED;

CREATE INDEX "DocumentChunk_searchVector_idx"
  ON "policytracker"."DocumentChunk"
  USING GIN ("searchVector");
