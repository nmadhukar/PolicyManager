# Ticket: RAG-P2 — Version Handling, Superseded Chunks & Hybrid Retrieval

## Goal

Turn the Phase 1 embedding index into a usable, correct retrieval layer: only the
current published version's chunks are retrievable (superseded chunks never
pollute results), and a `RetrieverService` blends pgvector similarity with the
existing tsvector full-text search (hybrid, RRF-fused), re-filtered through the
existing ACL/visibility seam. Returns ranked chunks with document context — the
input the Phase 3 agent tool will consume.

## Phase

RAG Phase 2 of 6. Governed by ADR-0002; extends ADR-0001's retrieval seam.

## Background

Phase 1 built `DocumentChunk` (pgvector `vector(1536)`, HNSW cosine) + an
`EmbeddingService` that embeds a version's `extractedText`. Grounding for Phase 2
(code-verified):
- Both existing FTS paths (`DocumentsService.rankedSearchIds`,
  `PublicDocumentsService.search`) already scope to the current version via
  `JOIN DocumentVersion v ON v.id = d.currentVersionId`. Old versions' text is
  never searched.
- Versions are immutable/additive; `currentVersionId` advances on every new/
  restored version (`writeVersion`, `restoreVersion`). Publish sets
  `Document.status='published'` (via `DocumentApprovalService.approve` or a direct
  `update`).
- ACL seam: `DocumentAccessService.buildListWhere(user)` builds the confidential/
  grant visibility WHERE (Admins → `{}`); soft-delete/status come from the list
  query. Public floor: `status='published' AND deletedAt IS NULL AND accessLevel
  <> 'confidential'` + client `allowedCategoryIds`.
- `EmbeddingProvider.embed(string[])` works for a single query (`embed([q])[0]`).

## Scope

1. **Superseded-chunk correctness (filter strategy).** Retrieval only returns
   chunks whose `versionId = document.currentVersionId` AND the document is
   published + not deleted. No deletion of old chunks (matches immutability); the
   filter is self-correcting when `currentVersionId` advances.
2. **Republish handling.** When a document is (re)published or a new current
   version appears, its current version must get embedded so it's retrievable.
   Add a hook: on publish (`DocumentApprovalService.approve` with `publish=true`)
   and on new current version, ensure the current version is queued/embedded
   (best-effort, env-gated, reusing Phase 1's `EmbeddingService`). Old versions'
   chunks remain but are filtered out by (1).
3. **`RetrieverService`** (new, in `RagModule`, exported): `retrieve(query, opts)`:
   - Gate on `provider.isConfigured()` — empty result + no egress when RAG off.
   - Embed the query once; run a pgvector KNN over current-version published chunks
     → candidate (documentId, chunkId, content, vectorScore).
   - Run the existing tsvector ranking for the same query → (documentId, ftsRank).
   - **Fuse with Reciprocal Rank Fusion (RRF)** into a ranked document/chunk list.
   - Re-filter the fused documentIds through the caller's ACL seam
     (`buildListWhere(user)` for internal; the published/non-confidential/
     category floor for public) so only visible docs survive.
   - Return typed hits: ranked chunks with `{ documentId, versionId, chunkId,
     chunkIndex, content, score, documentTitle, documentNumber }` — enough for
     Phase 3 context + citations.
4. **RagConfig retrieval getters:** `retrievalTopK` (default 8),
   `retrievalCandidatePool` (KNN/FTS candidate cap, default 40),
   `rrfK` (RRF constant, default 60) — via the existing `Number(config.get ?? d)`
   pattern.
5. **Tests** (unit + a real-DB hybrid smoke) per Testing Requirements.

## Non-Goals

- No agent/tool/chat/LLM answer generation (Phase 3/4) — retrieval returns chunks,
  it does not synthesize.
- No change to the public `ApiSearchHit {document, score, snippet}` contract; the
  public API keeps working unchanged (RetrieverService is additive; wiring the
  public/internal search to *call* it is Phase 3+ unless trivial).
- No re-embedding of historical non-current versions (they stay indexed but
  filtered out; a prune is a later optimization).
- No deletion of superseded chunks.

## User Workflow

(Still operator/integration-facing.) With RAG enabled: publish a document →
current version embedded → `RetrieverService.retrieve("question", {user})` returns
the most relevant chunks from that document's current version, ranked by hybrid
score, never from old versions, never from docs the user can't see.

## Acceptance Criteria

- [ ] AC1: `RetrieverService.retrieve` returns **only** chunks where
      `versionId = currentVersionId` and the document is `status='published'` and
      `deletedAt IS NULL`. A chunk from a superseded (old) version is never
      returned even though its rows still exist. (unit + real-DB test)
- [ ] AC2: Hybrid fusion — given a query that a doc matches semantically but not
      lexically (and vice-versa), both surface; RRF ranks a doc that scores in
      both above one that scores in only one. (unit test with queued vector+FTS
      candidate lists)
- [ ] AC3: ACL re-filter — a confidential document the user lacks a grant for is
      excluded from results even if it's the top vector/FTS match; an Admin sees
      it. Reuses `DocumentAccessService.buildListWhere`. (unit test)
- [ ] AC4: Egress/gating — when `provider.isConfigured()` is false, `retrieve`
      returns `[]` and makes ZERO embed calls and ZERO vector SQL. (unit test)
- [ ] AC5: Empty/no-match — empty query or no candidates → `[]`, no throw.
- [ ] AC6: `retrievalTopK` bounds the result count; `retrievalCandidatePool`
      bounds each retriever's candidate set; `rrfK` is used in the RRF formula.
- [ ] AC7: Republish/version hook — publishing a document (approve publish=true)
      or writing a new current version triggers best-effort embedding of the
      current version (env-gated, non-blocking, never fails the publish/upload).
      (unit test at the hook seam)
- [ ] AC8: The KNN SQL uses the cosine operator against the HNSW index and is
      schema-safe (operator resolves under the app's `policytracker` search_path;
      query vector cast via `toSql(...)::"policytracker"."vector"`). Verified by a
      real-DB smoke test that inserts 2+ chunks and asserts ranking order.
- [ ] AC9: No regression — existing `DocumentsService.list` /
      `PublicDocumentsService.search` and their specs still pass unchanged; the
      `ApiSearchHit` contract is untouched.
- [ ] AC10: `tsc`, `eslint --max-warnings 0`, and `jest` pass in `apps/api`;
      changed-line coverage ≥ 80% or documented exception.

## Data Model Impact

None. No new tables/columns — reuses Phase 1 `DocumentChunk` + `currentVersionId`.
(Superseded handling is a query filter, not a schema change.)

## API Impact

None required in Phase 2 (RetrieverService is internal; no new HTTP route). The
`ApiSearchHit` contract is preserved for when Phase 3 wires it in.

## UI Impact

None in Phase 2.

## Security / RBAC Impact

Retrieval MUST re-filter through the same ACL/visibility seam as document access
(AGENTS.md §8: extracted-text scope = download scope). Internal callers pass the
`AuthUser` → `buildListWhere`; public callers get the published/non-confidential/
category floor. Only published, non-deleted, in-scope, current-version chunks are
ever returned. Query embedding is gated on `provider.isConfigured()`.

## Audit Impact

Optional: a lightweight `retrieval` debug metric is out of scope; no new audit
action required for Phase 2 (retrieval is read-only and high-volume). Phase 4 chat
will audit at the conversation level.

## Storage Impact

None. Retrieval reads chunks from Postgres; no S3.

## Documentation Impact

- Developer docs: extend `docs/developer/rag-embedding-pipeline.md` with a
  "Retrieval (Phase 2)" section — superseded-chunk filter, hybrid RRF, ACL reuse,
  the republish hook, config getters.
- Code comments: RRF formula + why filter-not-delete for superseded chunks.

## Tests Required

- Unit: RetrieverService (current-version filter, RRF fusion, ACL re-filter,
  gating/zero-egress, topK/pool/rrfK, empty/no-match), RagConfig new getters,
  republish/version hook non-blocking.
- Integration/real-DB: a smoke test inserting chunks for a current + a superseded
  version and asserting only current-version chunks rank; KNN operator resolves.
- Regression: existing documents.service + public-documents.service specs pass.
- Security: confidential-exclusion + gating.

## Commands To Run

```
cd apps/api && npx tsc --noEmit
npm run lint
npm test
# real-DB hybrid smoke against the running pgvector Postgres
```

## Rollback Plan

RetrieverService is additive and unused by production routes in Phase 2; disabling
`RAG_ENABLED` makes it inert. Revert the republish hook (it's a guarded optional
call) to fully remove behavior. No schema/bytes touched.

## Agents / Skills

- Skills: `.ai/skills/public-api-contract.md` (preserve the hit contract),
  `.ai/skills/migration-safety.md` (n/a — no migration).

## Review Checklist

- [ ] Scope stayed inside ticket.
- [ ] Tests written first where behavior changed.
- [ ] RBAC re-filter verified (confidential exclusion + Admin).
- [ ] No DB schema change; current-version filter correct.
- [ ] Public contract untouched; existing search specs pass.
- [ ] Docs + code comments updated.
- [ ] Commands recorded.

## Done Evidence

- Files changed:
  - NEW: `apps/api/src/rag/retriever.service.ts` (+ `retriever.service.spec.ts`)
  - MODIFIED: `rag-config.service.ts` (+ spec) — retrievalTopK/candidatePool/rrfK
    getters; `rag.module.ts` (RetrieverService provider/export, forwardRef
    DocumentsModule); `documents.module.ts` (forwardRef RagModule);
    `attestation/document-approval.service.ts` (+ spec) — optional EmbeddingService
    + republish hook; `attestation.module.ts` (import RagModule);
    `.env.example` + `.env` (retrieval config); `docs/developer/
    rag-embedding-pipeline.md` (Retrieval section).
- Tests/commands run: `tsc --noEmit` (0); `eslint --max-warnings 0` (0);
  `jest src/rag src/attestation/document-approval.service.spec.ts` (63/63);
  full `jest` (617/619); real-DB superseded-chunk + cosine smoke; `nest build`;
  API container restart → clean bootstrap (forwardRef cycle resolves at runtime).
- Results:
  - AC1 ✓ (real-DB proven): retrieval returns ONLY current-version chunks; a
    superseded-version chunk with an even-closer vector is excluded by the
    `versionId = currentVersionId` filter.
  - AC2/AC3/AC4/AC5/AC6/AC8 ✓: 8 RetrieverService unit tests (RRF fusion, ACL
    confidential-exclusion, zero-egress gating, empty/no-match, topK cap,
    schema-qualified operator + current-version SQL).
  - AC7 ✓: 4 republish-hook tests (triggers on publish, not on approve-only,
    non-blocking on failure, no-op without RAG).
  - AC8 ✓ (real-DB): `OPERATOR("policytracker".<=>)` resolves regardless of
    search_path (fixes the Phase 1 latent risk); ranks correctly.
  - AC9 ✓: full suite 617/619 (the 2 failures are the SAME pre-existing,
    RAG-unrelated ones from Phase 1 — azure-oidc env-bleed + zip-bomb 5s timeout).
  - AC10 ✓: tsc 0, eslint 0, all new tests pass; app boots (0 build errors).
- Risks:
  - Retrieval is not yet wired into any user-facing route (by design — Phase 3
    wires it into the agent tool + chat). It's dead code until then, but fully
    tested and DI-registered.
  - `score = 1 - cosineDistance ∈ [-1,1]` (not [0,1]); comments corrected to say
    so. Phase 4 may normalize for display.
  - Still no automated real-DB test harness — vector recall validated by manual
    smoke this phase (as in Phase 1); a harness remains a good follow-up.
- Follow-ups: Phase 3 (Agent layer + SearchPolicyDocuments tool wrapping
  RetrieverService + context builder); consider a real-DB integration harness.
