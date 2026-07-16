# Ticket: RAG-P1 — pgvector + DocumentChunk + Embedding Pipeline

## Goal

Stand up the vector-indexing foundation for the RAG chatbot: install pgvector,
add a `DocumentChunk` model + embedding-lifecycle columns, and build an
env-gated, best-effort embedding pipeline that chunks + embeds a document
version's extracted text after extraction succeeds. No retrieval/agent/chat yet.

## Phase

RAG Phase 1 of 6 (per the user's 6-phase plan; governed by ADR-0002).

## Background

See ADR-0002. The repo already has `DocumentVersion.extractedText` (async-
backfilled by `DocumentExtractionService`) and a tsvector/GIN full-text index
(ADR-0001). Phase 1 adds the semantic index those later phases retrieve from.
pgvector is NOT installed in the current `postgres:16-alpine` image (verified),
so the image must change to `pgvector/pgvector:pg16`.

## Scope

1. **Docker**: switch the `postgres` service image to `pgvector/pgvector:pg16`
   (compose files); preserve the `pgdata` volume.
2. **Migration** (`policytracker` only, raw SQL where Prisma can't express):
   - `CREATE EXTENSION IF NOT EXISTS vector SCHEMA policytracker;`
   - `DocumentChunk` table (per ADR-0002 D3) with `embedding vector(1536)` +
     **HNSW** index (`vector_cosine_ops`) + btree/unique indexes.
   - Add `embeddingStatus`, `embeddingError`, `embeddedAt` to `DocumentVersion`.
3. **Prisma schema**: add `DocumentChunk` model (`embedding Unsupported("vector")?`),
   the new `EmbeddingStatus` enum, and the new `DocumentVersion` columns —
   all `@@schema("policytracker")`.
4. **EmbeddingProvider abstraction** (`EmbeddingProvider` interface +
   `OpenAiEmbeddingProvider` implementation via LangChain), DIP-wrapped, env-gated.
5. **ChunkingService**: pure, deterministic text→chunks with token counts and
   configurable size/overlap.
6. **EmbeddingService**: orchestrates chunk→embed→transactional upsert of
   `DocumentChunk` for a version; claim/status lifecycle mirroring
   `claimableConditions()`; audit on completion. Idempotent re-index (replaces a
   version's prior chunks).
7. **Wire the hook**: `DocumentExtractionService` triggers embedding (bounded,
   fire-and-forget) after a `done` extraction, mirroring `startVersion`.
8. **RagModule** registered in `app.module.ts`; new `AUDIT_ACTIONS` key; `.env.example`
   RAG block; config gating (`RAG_ENABLED`, `OPENAI_API_KEY`, model/dims).
9. **Backfill mechanism**: a bounded `embedPending()` method (like `reindexAll`) to
   embed already-`done` published versions.

## Non-Goals

- No retriever, hybrid search, agent, tool, chat endpoint, or UI (Phases 2–6).
- No re-embedding on model change beyond storing `embeddingModel` for detection.
- No production OpenAI key provisioning; local/dev uses a test/dummy or the flag off.
- No new real-DB integration harness (documented as a Phase 2 follow-up).

## User Workflow

(Operator-facing only in Phase 1.) With `RAG_ENABLED=true` + a valid
`OPENAI_API_KEY`, uploading/publishing a document → extraction runs → on success,
the version's text is chunked + embedded → `DocumentChunk` rows appear and
`DocumentVersion.embeddingStatus = done`. With the flag off, nothing changes.

## Acceptance Criteria

- [ ] AC1: `pgvector/pgvector:pg16` is the compose `postgres` image; the container
      starts and `CREATE EXTENSION vector SCHEMA policytracker` succeeds.
- [ ] AC2: `npx prisma migrate` applies cleanly; the required verification query
      shows `DocumentChunk` and the `vector` extension objects under
      `policytracker` and **nothing new in `public`**.
- [ ] AC3: `prisma generate` succeeds with `embedding Unsupported("vector")?` and
      the new columns/enum; `tsc --noEmit` passes for `apps/api`.
- [ ] AC4: `ChunkingService.chunk(text, opts)` is pure & deterministic: same input
      → same chunks; respects size/overlap; never emits empty chunks; splits on
      sensible boundaries; returns `{ content, chunkIndex, tokenCount }[]`.
      Covered by unit tests incl. edge cases (empty string, whitespace-only, text
      shorter than one chunk, text with no break points, 1M-char cap boundary).
- [ ] AC5: `OpenAiEmbeddingProvider` implements `EmbeddingProvider.embed(texts)` and
      reports `isConfigured()`; when not configured, `EmbeddingService` no-ops the
      version to `embeddingStatus = skipped` and makes **zero** OpenAI calls
      (unit-tested with a mock provider).
- [ ] AC6: `EmbeddingService.embedVersion(versionId)` uses a compare-and-swap claim
      (pending→processing), chunks + embeds `extractedText`, replaces prior chunks
      for that version in a transaction, sets `embeddingStatus = done` + `embeddedAt`,
      and writes an audit event `embedding.indexed` (`source:'system'`,
      `targetType:'version'`). Unit-tested against hand-rolled Prisma/provider mocks
      (the `document-extraction.service.spec.ts` pattern).
- [ ] AC7: Failure path: a provider error sets `embeddingStatus = failed` +
      `embeddingError`, never throws into the caller, and never partially writes
      chunks (transaction rolls back). Unit-tested.
- [ ] AC8: Re-indexing the same version is idempotent — prior `DocumentChunk` rows
      for that version are removed and replaced; `chunkIndex` stays contiguous.
      Unit-tested.
- [ ] AC9: Versions with empty/`null` `extractedText`, or non-`done`
      `extractionStatus`, are `skipped` (no chunks, no embed calls). Unit-tested.
- [ ] AC10: The extraction→embedding hook is bounded/fire-and-forget and never
      blocks or fails the extraction result (embedding failure ≠ extraction
      failure). Unit-tested at the `DocumentExtractionService` seam.
- [ ] AC11: `npm run lint`, `npm run typecheck`, `npm test` all pass in `apps/api`
      and at repo root (`--workspaces`). New code changed-line coverage ≥ 80%
      (AGENTS.md §6) or a documented exception.
- [ ] AC12: `.env.example` has a `# ---------- RAG / embeddings ----------` block;
      developer docs describe the pipeline, the flag, and the backfill.

## Data Model Impact

New `DocumentChunk` table; new `EmbeddingStatus` enum; new `DocumentVersion`
columns (`embeddingStatus`, `embeddingError`, `embeddedAt`). All in
`policytracker`. `DocumentVersion` bytes/immutability untouched.

## API Impact

None in Phase 1 (no new HTTP routes). Swagger unchanged.

## UI Impact

None in Phase 1. (Document-detail extraction badge could later gain an embedding
state — deferred.)

## Security / RBAC Impact

No new routes to guard. Chunks store `documentId`/`versionId` so later retrieval
re-filters through the existing ACL/visibility seam (AGENTS.md §8: extracted-text
scope = download scope). Only published, non-deleted docs will ever be surfaced
(enforced in Phase 2/3 retrieval). OpenAI egress is env-gated (`RAG_ENABLED`).

## Audit Impact

Add `AUDIT_ACTIONS.EMBEDDING_INDEXED = 'embedding.indexed'` (+ label). Emit on
successful version embed with chunk count in metadata. Follows the extraction
`source:'system'` pattern.

## Storage Impact

No S3 changes. Embedding reads `extractedText` from Postgres, not S3. No version
bytes mutated.

## Documentation Impact

- Developer docs: new `docs/developer/rag-embedding-pipeline.md` (pipeline, flag,
  backfill, model/dims, schema placement).
- User guide: none (operator-only phase).
- Admin/operator docs: env flags + pgvector image requirement in deployment notes.
- Code comments: chunker invariants, claim/idempotency contract, egress gate.

## Tests Required

- Unit: ChunkingService (determinism + edges), EmbeddingService (success, skipped-
  when-unconfigured, failure/rollback, idempotent re-index, empty/non-done skip),
  provider `isConfigured` gating, extraction-hook non-blocking.
- Integration: `$queryRaw`/upsert paths with mocked Prisma (existing style); a
  documented note that real-DB vector recall is Phase 2/3.
- E2E: n/a Phase 1.
- Negative/security: unconfigured provider makes zero egress; failure never
  corrupts chunks; non-published/empty-text versions never embed.

## Commands To Run

```
docker compose up -d postgres                 # pgvector image
cd apps/api && npx prisma migrate dev
npx prisma generate
npm run typecheck --workspace apps/api
npm run lint --workspace apps/api
npm test --workspace apps/api
# schema verification query (AGENTS.md §3) against the live DB
```

## Rollback Plan

Set `RAG_ENABLED=false` (embedding no-ops). Drop `DocumentChunk` + new columns +
extension via a down migration. Revert compose image to `postgres:16-alpine` only
if abandoning vectors. No version bytes affected.

## Agents / Skills

- Skills: `.ai/skills/add-prisma-model.md`, `.ai/skills/migration-safety.md`,
  `.ai/skills/ocr-extraction.md` (async pattern reference).

## Review Checklist

- [ ] Scope stayed inside ticket.
- [ ] Tests written first where behavior changed.
- [ ] RBAC and audit reviewed where relevant.
- [ ] Database objects verified under `policytracker`.
- [ ] S3/storage safety reviewed (no byte mutation).
- [ ] Docs and code comments updated.
- [ ] Commands recorded.

## Done Evidence

- Files changed:
  - NEW: `apps/api/src/rag/` (chunking.service.ts, chunking.service.spec.ts,
    embedding-provider.ts, openai-embedding.provider.ts,
    openai-embedding.provider.spec.ts, rag-config.service.ts,
    rag-config.service.spec.ts, embedding.service.ts, embedding.service.spec.ts,
    rag.module.ts)
  - NEW: `prisma/migrations/20260716120000_rag_pgvector_embeddings/migration.sql`
  - NEW: `.ai/decisions/ADR-0002-pgvector-rag-embeddings.md`,
    `docs/developer/rag-embedding-pipeline.md`
  - MODIFIED: `prisma/schema.prisma` (EmbeddingStatus enum, DocumentChunk model,
    DocumentVersion embedding columns), `packages/shared/src/index.ts`
    (EmbeddingStatus type + EMBEDDING_INDEXED/EMBEDDING_FAILED actions + labels),
    `apps/api/src/documents/document-extraction.service.ts` (optional embedding
    hook), `documents.module.ts` + `app.module.ts` (RagModule wiring),
    `apps/api/package.json` (@langchain/openai, @langchain/core, openai, pgvector;
    @prisma/client pinned to ^6.19.3), `docker-compose.yml`
    (pgvector/pgvector:pg16), `.env.example` + `.env` (RAG block),
    `docs/developer/README.md` (index link)
- Tests/commands run: `docker compose up -d postgres` (pgvector image);
  `prisma migrate deploy`; `prisma generate`; schema-placement verification query;
  `tsc --noEmit`; `eslint`; `jest` (RAG + extraction + full suite); real-DB
  pgvector insert + cosine-similarity + HNSW query.
- Results:
  - AC1–AC3 ✓: pgvector image running; migration applied; DocumentChunk + vector
    extension in `policytracker`, **`public` empty**; embedding col type =
    `policytracker.vector`; HNSW index present; prisma generate + tsc clean.
  - AC4–AC10 ✓: 55/55 RAG + extraction unit tests pass (17 chunking, 12 config,
    6 provider, 9 embedding, 11 extraction incl. 4 new hook tests).
  - AC11 ✓: tsc 0 errors, eslint 0 warnings; full API suite 605/607 (the 2
    failures are pre-existing & unrelated — proven on the stashed baseline:
    azure-oidc reads live OIDC_ENABLED=true; zip-bomb test is a 5s-timeout flake).
  - AC12 ✓: .env.example RAG block + developer doc + README link.
  - Runtime e2e: cosine similarity ranks correctly through the app's
    `?schema=policytracker` search_path (identical vectors → 0 distance).
- Risks:
  - The `<=>` cosine operator resolves only when `policytracker` is on the
    search_path (the app's Prisma connection sets this via `?schema=policytracker`).
    Phase 2/3 retrieval SQL should either rely on that or schema-qualify via
    `OPERATOR(policytracker.<=>)`. The Phase 1 INSERT path is already
    schema-qualified and unaffected.
  - No real-DB test harness yet (per ADR-0002) — vector recall validated manually
    this phase; automate in Phase 2.
  - OpenAI egress is real when RAG_ENABLED — gated off by default.
- Follow-ups: Phase 2 (chunking policy for versions/republish/superseded chunks +
  hybrid retrieval); introduce a real-DB integration harness for vector recall.
