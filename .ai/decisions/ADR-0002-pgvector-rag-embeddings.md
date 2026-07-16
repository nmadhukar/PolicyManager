# ADR-0002: pgvector + RAG Embedding Store for the ESS Portal Chatbot

- Status: Proposed (awaiting user approval)
- Date: 2026-07-16
- Deciders: User (product owner), Claude (architect)
- Phase: RAG Phase 1 (of 6)
- Supersedes: none
- Extends: ADR-0001 (OCR + full-text search) — reuses `extractedText` and the
  "rank via raw SQL → re-filter through ACL Prisma" retrieval seam.

## Context

We are building a **production RAG chatbot** so the ESS Portal can ask natural-
language questions against **published PolicyManager documents** and get grounded
answers with citations. (This reverses the 2026-07-14 essportal-only scoping; the
PolicyManager-corpus version is now the active plan, decided by the user
2026-07-16.)

ADR-0001 already gives us clean, per-version **`extractedText`** on
`DocumentVersion` (backfilled asynchronously by `DocumentExtractionService`), plus
a `tsvector` + GIN full-text index and a two-stage retrieval pattern
(`rankedSearchIds` → ACL re-filter). RAG needs a **semantic** index on top of that
text: chunk the extracted text, embed each chunk, store vectors, and retrieve by
similarity — then (Phase 2) fuse with the existing keyword search for hybrid
retrieval.

Verified constraints in the live environment (2026-07-16):

- DB is **PostgreSQL 16.14** in the `policytracker` schema.
- The current `postgres:16-alpine` Docker image **does not ship pgvector** —
  `CREATE EXTENSION vector` fails ("extension is not available"). This is a hard
  blocker for any vector column.
- Prisma runtime and CLI are both **6.19.3** (the `apps/api/package.json` range
  `^5.22.0` is stale vs. the installed 6.19.3 and will be corrected).
- No `openai`, `langchain`, or `pgvector` client is present yet.
- No real-DB test harness exists (services mock Prisma / `$queryRaw` by hand).

## Decision

### D1 — Vector store: pgvector in the same PostgreSQL, `policytracker` schema

Store embeddings in **pgvector**, colocated in the existing Postgres, not a
separate vector DB. Rationale: one datastore to operate/back up, transactional
consistency with `DocumentVersion`, and it reuses the ACL/soft-delete/visibility
model already enforced in SQL. Corpus scale (clinic P&P: hundreds–low thousands of
docs) is well inside pgvector's comfort zone.

**Extension placement (AGENTS.md §3 requires an ADR to justify anything in
`public`):** the `vector` extension's C library and its type/operator objects are
installed with `CREATE EXTENSION vector` **without a `SCHEMA` clause is disallowed
here**; we install it into a dedicated location and reference the type schema-
qualified. Concretely: `CREATE EXTENSION IF NOT EXISTS vector;` creates the
extension objects in the first schema on `search_path`. To keep `public` clean per
§3, we **create the extension in `policytracker`**:
`CREATE EXTENSION IF NOT EXISTS vector SCHEMA policytracker;`. All vector columns
use the schema-qualified type `policytracker.vector`. **This ADR is the explicit
approval that the `vector` extension lives in `policytracker`, not `public`.**

### D2 — Docker image: switch to `pgvector/pgvector:pg16`

Replace `postgres:16-alpine` with the official **`pgvector/pgvector:pg16`** image
(Postgres 16 + pgvector preinstalled). Same major version (16), same data
directory layout, drop-in for local/dev. The named volume `pgdata` is preserved.
Production deployment docs get the same requirement (managed PG must have pgvector
available, e.g. RDS/Aurora `CREATE EXTENSION vector`).

### D3 — Data model: a new `DocumentChunk` table (one row per chunk)

New table `policytracker."DocumentChunk"`:

- `id uuid pk`
- `documentId uuid` (fk → Document, for ACL joins & cascade-on-doc-delete semantics)
- `versionId uuid` (fk → DocumentVersion, the chunk's source version)
- `chunkIndex int` (ordinal within the version)
- `content text` (the chunk text — used for citations/snippets & context building)
- `tokenCount int` (for context-window budgeting)
- `embedding policytracker.vector(1536)` — declared `Unsupported("vector")?` on the
  Prisma model; the column DDL + HNSW index are raw SQL (mirrors ADR-0001's
  generated-tsvector pattern).
- `embeddingModel text` (e.g. `text-embedding-3-small`) — so a model change is
  detectable and re-embeddable.
- `createdAt timestamptz default now()`
- Indexes: `@@unique([versionId, chunkIndex])`; btree on `versionId`, `documentId`;
  **HNSW** on `embedding` with `vector_cosine_ops`.

Dimension `1536` = OpenAI `text-embedding-3-small`. Stored per-row in
`embeddingModel` and configured via `EMBEDDING_DIMENSIONS` so a future model swap
is a migration + re-embed, not a code rewrite.

### D4 — Embedding lifecycle: hang off the existing extraction worker

Embedding runs **after** extraction succeeds, reusing `DocumentExtractionService`'s
proven async/claim design rather than a parallel poller:

- Input is `DocumentVersion.extractedText` (already persisted, capped at 1M chars) —
  **no S3 re-fetch needed**.
- A new `EmbeddingService` (own provider, injected into the extraction flow) chunks
  + embeds + upserts `DocumentChunk` rows for a version, transactionally replacing
  any prior chunks for that version (idempotent re-index).
- Track state with new columns on `DocumentVersion`: `embeddingStatus`
  (`pending|processing|done|failed|skipped`) + `embeddingError` + `embeddedAt`,
  and a compare-and-swap claim mirroring `claimableConditions()` (since
  `DocumentVersion` has no `@updatedAt`).
- **Best-effort & env-gated**: gated behind `RAG_ENABLED` + a configured
  `OPENAI_API_KEY` (mirrors `OcrService.isConfigured()`); when unset, embedding is
  a no-op (`skipped`) and nothing else changes — exactly how OCR degrades.

### D5 — LLM/embedding provider: OpenAI via LangChain (user-approved)

Use **OpenAI embeddings** (`text-embedding-3-small`, 1536-dim) and **LangChain** as
the orchestration layer, per explicit user decision (2026-07-16). The provider is
wrapped behind a narrow `EmbeddingProvider` interface (SOLID/DIP) so a different
model/vendor is an adapter swap, not a caller change — the same containment ADR-
0001 applied to OCR/Textract.

## Consequences

- **New external dependency + data egress**: chunk text is sent to OpenAI for
  embedding. This is a material change from the "self-hosted, never send bytes to a
  vendor" posture of OCR. It MUST be env-gated (`RAG_ENABLED`, default off) and
  documented; environments without a key simply don't embed. A future self-hosted
  embedding adapter remains possible behind the same interface.
- **Docker image change** (`pgvector/pgvector:pg16`) — a one-line compose change +
  a re-create of the pg container; `pgdata` volume and all existing tables are
  preserved (same PG16 cluster format).
- **Migration** adds the extension (in `policytracker`), the `DocumentChunk` table,
  and the embedding-lifecycle columns — **verified in `policytracker`, never
  `public`** (AGENTS.md §3), additive and droppable.
- **Backfill** needed to embed already-`done` versions of published docs (Phase 1
  provides the mechanism; a bounded backfill command like `reindexAll`).
- **Test harness gap**: vector similarity SQL isn't covered by the mock-only
  harness. Phase 1 unit-tests the chunker/provider/claim logic with mocks (the
  `document-extraction.service.spec.ts` pattern); the raw vector query is exercised
  by a thin integration test that mocks `$queryRaw`, with a documented note that
  true end-to-end vector recall is validated in Phase 2/3 against the real DB.
- **Security**: chunk retrieval MUST obey the same ACL/visibility scope as document
  download (AGENTS.md §8 — "access to extracted text obeys the same scope as file
  download"). Phase 1 stores chunks with `documentId`/`versionId` so Phase 2/3
  retrieval can re-filter through the existing `access.buildListWhere(user)` seam.
  Only **published**, non-deleted, in-scope documents are ever surfaced to the bot.

## Rollout / rollback

- Ship behind `RAG_ENABLED` (default off). With the flag off, no embedding runs, no
  OpenAI calls are made, and the app behaves exactly as today.
- Rollback = disable `RAG_ENABLED`; the `DocumentChunk` table and vector index are
  additive and droppable; no `DocumentVersion` bytes are ever mutated.
- Image rollback = revert the compose image to `postgres:16-alpine` (only if the
  vector feature is abandoned; the chunk table would be dropped first).

## Related

- ADR-0001 (OCR + FTS) — reuses `extractedText`, the retrieval seam, and the async
  best-effort extraction pattern.
- AGENTS.md §2 (stack change needs ADR), §3 (schema placement), §8 (extracted-text
  scope = download scope), §9 (immutable versions), §12 (task format).
- PLAN.md Phase 7 (RAG, previously deferred — now active).
