# Ticket: RAG-P7 — Generic Structural Metadata Model (schema only)

## Goal

Add a **document-type-neutral structural metadata model** so RAG chunks can later
carry section/page provenance — closing the audited gaps for exact-identifier
retrieval, section-level context assembly, section/page citations, and same-identifier
disambiguation. This ticket is **SCHEMA ONLY**: it adds the columns and indexes where
structure will live; it does **not** build the structure detector, change retrieval,
or change citations. All new fields ship empty and are populated by a later phase.

## Phase

RAG remediation Phase 7 (of the accepted 2026-07-16 conformance audit) — the first,
**unblocking** phase; governed by **ADR-0004**. Structure-aware ingestion, retrieval
diversity, disambiguation, and the multi-type fixture corpus are separate later
tickets that depend on this one.

## Background

See **ADR-0004** for the full decision. The audit found `DocumentChunk` stores only
`content` / `chunkIndex` / `embedding` / `searchVector` and carries no structural
metadata, making four requirement clusters structurally impossible. ADR-0004 chose
**Option A — inline structural columns on `DocumentChunk`** (over a normalized
`DocumentSection` table, Option B, and a hybrid, Option C) because this is a
schema-only phase with no detector yet: the decisive axis is **reversibility**, and
inline columns are the expensive-to-retrofit piece (best added now, for free via the
wholesale re-index path), while a `DocumentSection` table is the cheap-to-add-later
piece (deferred to the detector phase, non-breakingly — ADR-0004 D5).

Verified facts this ticket relies on:

- `DocumentChunk` rows are written **only** by `EmbeddingService.replaceChunks`
  (`apps/api/src/rag/embedding.service.ts`), via one raw SQL `DELETE`-then-`INSERT`
  per version (Prisma cannot write `Unsupported("vector")`). Re-index is wholesale;
  there is no in-place chunk `UPDATE`.
- Both retrieval legs (`vectorSearch`, `ftsSearch` in `retriever.service.ts`) are raw
  `$queryRaw` selecting scalar `dc.*` and joining only `Document`. They MUST NOT change
  in this ticket.
- The schema is single-tenant (no organization/tenant column) — so disambiguation
  (a later phase) is on title/date/version, and there is no tenant field to add here.

## Scope

1. **Prisma schema** (`prisma/schema.prisma`, all `@@schema("policytracker")`):
   - `DocumentChunk`: add `sectionType String?`, `sectionIdentifier String?`,
     `normalizedSectionIdentifier String?`, `sectionTitle String?`,
     `headingPath String[] @default([])`, `pageStart Int?`, `pageEnd Int?`,
     `metadata Json @default("{}")`.
   - `Document`: add `documentType String?` and `metadata Json @default("{}")`.
   - Add `@@index` lines matching the partial indexes below (Prisma cannot express
     partial-index predicates, so the *filtered* indexes are raw-SQL in the migration;
     add plain `@@index([documentId, normalizedSectionIdentifier])` / `@@index([sectionType])`
     only if Prisma drift-check requires a representation — otherwise document the raw
     indexes as `/// managed in migration` like `searchVector`/`embedding`).
2. **Migration** (`prisma/migrations/<ts>_rag_structural_metadata/migration.sql`,
   additive, `policytracker`-only, raw SQL for the partial indexes + CHECK):
   - `ALTER TABLE "policytracker"."DocumentChunk" ADD COLUMN ...` (the 8 columns;
     `headingPath TEXT[] NOT NULL DEFAULT '{}'`, `metadata JSONB NOT NULL DEFAULT '{}'::jsonb`,
     the rest nullable).
   - `ALTER TABLE "policytracker"."Document" ADD COLUMN "documentType" TEXT,
     ADD COLUMN "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb`.
   - `CHECK ("pageStart" IS NULL OR "pageEnd" IS NULL OR "pageEnd" >= "pageStart")`.
   - Three **partial** btree indexes (ADR-0004 D4):
     `("documentId","normalizedSectionIdentifier") WHERE normalizedSectionIdentifier IS NOT NULL`,
     `("normalizedSectionIdentifier") WHERE normalizedSectionIdentifier IS NOT NULL`,
     `("sectionType") WHERE sectionType IS NOT NULL`.
3. **`TextChunk` interface** (`chunking.service.ts`): add the structural fields as
   **optional** (`sectionType?`, `sectionIdentifier?`, `normalizedSectionIdentifier?`,
   `sectionTitle?`, `headingPath?`, `pageStart?`, `pageEnd?`, `metadata?`). The current
   chunker does not populate them (that's the detector phase); they default to
   null/empty. This is the seam the detector will later fill.
4. **`replaceChunks` raw INSERT** (`embedding.service.ts`): widen the column list and
   `VALUES` to write the eight new chunk columns, reading them off `chunk` with safe
   defaults (`${chunk.sectionType ?? null}`, `${chunk.headingPath ?? []}`,
   `${chunk.metadata ?? {}}::jsonb`, …). Because the detector doesn't exist yet, every
   value is null/empty at runtime — but the write path is complete, so the detector
   phase only has to *populate* `TextChunk`, never touch this INSERT again.
5. **Shared types** (`packages/shared/src/index.ts`): if a `DocumentChunk` DTO/type is
   exported, extend it with the new optional fields for forward-compatibility. Do
   **not** yet add section/page to `RagCitation` / `RetrievedChunk` — surfacing them in
   citations is a later ticket (keeps "preserve existing citation behavior" true).
6. **Docs**: extend `docs/developer/rag-embedding-pipeline.md` with a "Structural
   metadata model" section (the fields, the type-neutral vocabulary, the null-degrades
   contract, and the ADR-0004 D5 evolution path).

## Non-Goals

- **No structure detector.** The chunker/extractor is unchanged; it still emits flat
  chunks with null structural fields. Detecting headings/sections/pages is a later
  phase.
- **No retrieval change.** `vectorSearch` / `ftsSearch` / `fuseChunks` / ACL re-filter
  / `hydrateDocuments` are untouched. No exact-identifier boost, no section assembly,
  no adjacent-chunk expansion in this ticket.
- **No citation change.** `RagCitation` / `RetrievedChunk` keep today's fields;
  section/page in citations is a later ticket.
- **No `DocumentSection` table, no `sectionId` FK, no self-referential tree** (ADR-0004
  D5 — added later, non-breakingly, if/when a detector needs it).
- **No Postgres enum** for `documentType`/`sectionType` (ADR-0004 D2 — free strings).
- No re-embedding, no re-chunking of existing documents in this ticket (backfill of
  *values* happens in the detector phase; see Backfill Strategy).
- No API, UI, or Swagger change.

## User Workflow

Operator-invisible in this phase. With the columns present but unwritten, uploading,
extracting, embedding, retrieving, and citing behave exactly as today. The value is
unlocked by later phases that populate and read the fields.

## Acceptance Criteria

- [ ] AC1: `npx prisma migrate` applies cleanly; the AGENTS.md §3 verification query
      shows the new `DocumentChunk`/`Document` columns and the three partial indexes
      under `policytracker` and **nothing new in `public`**.
- [ ] AC2: `prisma generate` succeeds with the new columns; `tsc --noEmit` passes for
      `apps/api` and `packages/shared`.
- [ ] AC3: The migration is **additive only** — no `DROP`, no `ALTER COLUMN ... SET NOT
      NULL` on existing data, no data rewrite. Existing `DocumentChunk`/`Document` rows
      remain valid with `NULL`/`{}`/`[]` in the new fields (verified by applying the
      migration against a DB that already has chunk rows).
- [ ] AC4: `documentType` and `sectionType` are `TEXT` (free string), **not** a
      Postgres `ENUM` (grep the migration; assert no `CREATE TYPE`).
- [ ] AC5: `headingPath` is `TEXT[] NOT NULL DEFAULT '{}'`; a chunk written with no
      heading path stores `[]`, not `NULL` (unit-tested through `replaceChunks`).
- [ ] AC6: The `pageStart`/`pageEnd` CHECK rejects `pageEnd < pageStart` and accepts
      both-null / either-null (unit or integration test asserting the constraint).
- [ ] AC7: `replaceChunks` writes all eight new columns; re-indexing a version is still
      idempotent and `chunkIndex` stays contiguous; a chunk with no structural fields
      persists as `NULL`/`[]`/`{}` (unit-tested against the existing mock-Prisma
      pattern, extended to assert the new columns appear in the INSERT).
- [ ] AC8: **Retrieval is byte-identical.** `retriever.service.spec.ts` passes
      unchanged; the generated `vectorSearch`/`ftsSearch` SQL strings are unchanged
      (assert no new column/JOIN leaked into the hot legs). ACL, fusion, versioning,
      and `hydrateDocuments` outputs are unchanged.
- [ ] AC9: **Citations are byte-identical.** `context-builder.service.spec.ts` passes
      unchanged; `RagCitation` shape is unchanged (no section/page yet).
- [ ] AC10: The partial indexes are used for an exact-identifier probe: an integration
      (or documented manual) `EXPLAIN` of
      `SELECT ... WHERE "normalizedSectionIdentifier" = $1` shows the partial index, and
      a row with `NULL` identifier is absent from the index (index size ≈ classified
      rows only).
- [ ] AC11: `npm run lint`, `npm run typecheck`, `npm test` pass in `apps/api`,
      `packages/shared`, and at repo root (`--workspaces`). Changed-line coverage ≥ 80%
      (AGENTS.md §6) or a documented exception (thin glue).
- [ ] AC12: `docs/developer/rag-embedding-pipeline.md` documents the structural model,
      the type-neutral vocabulary, the null-degrades contract, and the ADR-0004 D5
      evolution path; `docs/developer/README.md` index still resolves.

## Data Model Impact

New nullable/defaulted columns on `DocumentChunk` (8) and `Document` (2); three partial
btree indexes; one CHECK constraint. All in `policytracker`. **No** new table, enum,
FK, or self-relation. `DocumentVersion` bytes/immutability untouched. No existing
column altered.

## API Impact

None. No new/changed HTTP routes. Swagger unchanged.

## UI Impact

None.

## Security / RBAC Impact

None new. No new routes to guard. The new columns are metadata on rows already scoped
by the existing ACL/visibility seam; retrieval is unchanged, so the AGENTS.md §8
"extracted-text scope = download scope" guarantee is preserved verbatim. No new egress
(no detector, no model calls). `metadata` JSON must never store secrets — documented in
code comments; it holds structural extras only.

## Audit Impact

None in this phase (no new state transition or access path). The later detector phase
that populates these fields will re-use the existing `embedding.indexed` audit event on
re-index; no new audit action is added here.

## Storage Impact

No S3 change. Small per-row growth on `DocumentChunk` (section text + a `text[]` + a
`jsonb`), bounded and tiny next to the existing 1536-dim vector. No version bytes
mutated.

## Documentation Impact

- Developer docs: `docs/developer/rag-embedding-pipeline.md` gains a "Structural
  metadata model (ADR-0004)" section (fields, vocabulary, null-degrades contract,
  evolution path).
- User guide: none (no user-facing behavior).
- Admin/operator docs: none (no new flag/infra).
- Code comments needed: on each new schema field (the `searchVector`/`embedding`
  comment style); on the widened `replaceChunks` INSERT (why every value is null in
  this phase and where the detector will fill it); on the migration (additive,
  policytracker-only, partial-index rationale).

## Tests Required

- Unit:
  - `ChunkingService` — `TextChunk` now allows optional structural fields; existing
    determinism/edge tests still pass; a chunk built without structural fields has them
    `undefined` (they become `NULL`/`[]`/`{}` at the DB via `replaceChunks`).
  - `EmbeddingService.replaceChunks` — the INSERT includes the eight new columns; a
    chunk with no structural fields writes `NULL`/`[]`/`{}`; idempotent re-index still
    holds; `chunkIndex` contiguous. (Extend the existing mock-Prisma spec.)
  - Negative: a chunk with `pageEnd < pageStart` is rejected (constraint or a guard —
    prefer the DB CHECK, tested via integration).
- Integration:
  - Apply the migration to a DB seeded with pre-existing chunk rows; assert existing
    rows are valid and unchanged, new columns default correctly (AC3).
  - `EXPLAIN` the exact-identifier probe uses the partial index and excludes NULLs
    (AC10). If the real-DB harness is still absent (per ADR-0002), document this as a
    manual verification with the exact commands, mirroring the Phase-1 note.
- E2E: n/a (no user-facing flow).
- Negative/regression: `retriever.service.spec.ts` and `context-builder.service.spec.ts`
  pass **unchanged** (AC8/AC9) — the strongest guard that existing retrieval and citation
  behavior is preserved.

## Commands To Run

```
cd apps/api && npx prisma migrate dev --name rag_structural_metadata
npx prisma generate
npm run typecheck --workspace apps/api
npm run typecheck --workspace packages/shared
npm run lint --workspace apps/api
npm test --workspace apps/api
npm test --workspace packages/shared
# AGENTS.md §3 schema-placement verification query against the live DB
# (confirm new columns/indexes under policytracker, public untouched)
# Manual: EXPLAIN the normalizedSectionIdentifier probe to confirm partial-index use
```

## Rollback Plan

Down migration drops the eight `DocumentChunk` columns, the two `Document` columns, the
three partial indexes, and the CHECK — all additive and unreferenced, so the drop is
safe at any time. No `DocumentVersion` bytes affected. No feature flag needed: the
columns are inert until a later phase writes/reads them, so shipping them changes no
runtime behavior and rolling them back changes none either.

## Agents / Skills

- Agents: `db-migration`, `backend-dev`, `documentation-maintainer`.
- Skills: `.ai/skills/add-prisma-model.md`, `.ai/skills/migration-safety.md`,
  `.ai/skills/documentation-update.md`.

## Review Checklist

- [ ] Scope stayed inside ticket (schema only — no detector, retrieval, or citation
      change).
- [ ] Tests written first where behavior changed (the `replaceChunks` INSERT).
- [ ] RBAC and audit reviewed (confirmed none new).
- [ ] Database objects verified under `policytracker`; `public` untouched.
- [ ] S3/storage safety reviewed (no byte mutation).
- [ ] Existing retrieval + citation specs pass unchanged (regression guard).
- [ ] Docs and code comments updated.
- [ ] Commands recorded.

## Done Evidence

- Files changed:
  - MODIFIED: `prisma/schema.prisma` (DocumentChunk + Document columns/indexes),
    `apps/api/src/rag/chunking.service.ts` (TextChunk optional structural fields),
    `apps/api/src/rag/embedding.service.ts` (widened replaceChunks INSERT),
    `packages/shared/src/index.ts` (chunk DTO fields, if exported),
    `docs/developer/rag-embedding-pipeline.md`, `docs/developer/README.md`
  - NEW: `prisma/migrations/<ts>_rag_structural_metadata/migration.sql`,
    `.ai/decisions/ADR-0004-generic-structural-metadata-model.md`
- Tests/commands run: `prisma migrate dev`; `prisma generate`; schema-placement
  verification query; `tsc --noEmit` (api + shared); `eslint`; `jest` (RAG +
  extraction + full suite); migration-on-populated-DB check; partial-index `EXPLAIN`.
- Results: (to be filled by the implementer — ACs above, one line each with evidence)
- Risks: (fill — e.g. Prisma partial-index representation drift; real-DB harness gap
  per ADR-0002)
- Follow-ups: structure-detector phase populates these fields; retrieval phase adds
  exact-identifier boost + section assembly + adjacent expansion; citation phase
  surfaces section/page/versionNumber; the `DocumentSection` normalized tree per
  ADR-0004 D5 if/when a detector needs true hierarchy.
```

## Definition Of Ready

- [x] Goal is clear (schema-only structural metadata; ADR-0004 governs).
- [x] Phase is known (RAG remediation Phase 7, first/unblocking).
- [x] Scope and non-goals are explicit (no detector/retrieval/citation change).
- [x] Acceptance criteria are testable (AC1–AC12).
- [x] Security/RBAC impact is stated (none new; existing scope preserved).
- [x] Documentation impact is stated.
- [x] Verification commands are known.
- [ ] **User approval of ADR-0004 + this task before implementation** (per CLAUDE.md:
      no implementation code until reviewed and approved).
