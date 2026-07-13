# Phase 10 — OCR and Full-Text Search Indexing

Enhancement phase (post Phase 9 release). Makes **scanned documents and images
searchable** and upgrades retrieval to **PostgreSQL full-text search**.

Locked decisions: `.ai/decisions/ADR-0001-ocr-and-fulltext-search.md`.

- Engine: **self-hosted OCRmyPDF/Tesseract** (env-gated), not cloud.
- Extraction becomes **asynchronous** (upload never blocks on OCR).
- Search upgraded to **tsvector + GIN + `ts_rank`**, same API contract.

Guardrails carried from AGENTS.md: schema is `policytracker` only (§3); OCR text
obeys the same access scope as file download (§8); source bytes are never mutated
(§9); every migration is verified against a live DB (§3); UI shows loading/empty/
error/forbidden states (§10c); TDD-first with ≥80% changed-line coverage (§6).

Dependency order: **PM-1002 → PM-1001/PM-1003 → PM-1004 → PM-1005 → PM-1006 →
PM-1007 → PM-1008.** PM-1002 (async foundation) unblocks everything; PM-1005
(full-text) depends only on the existing `extractedText` column and can proceed in
parallel once PM-1002 lands.

---

## PM-1001 — OCR service container + env config

**Goal.** Add a self-hosted OCR capability (OCRmyPDF + Tesseract) to local Docker
Compose and define the env contract, mirroring the Gotenberg/OnlyOffice pattern.

**Scope.** docker-compose service; `.env.example` keys; documented resource sizing.
**Non-goals.** No app wiring (PM-1003), no cloud engine.

**Acceptance criteria.**
- [ ] Compose service starts and is reachable from the api container.
- [ ] Env keys defined & documented: `OCR_ENABLED` (default `false`),
      `OCR_LANGUAGES` (default `eng`), `OCR_MAX_PAGES`, `OCR_MAX_FILE_MB`,
      `OCR_TIMEOUT_MS`, plus endpoint/mode keys for the chosen invocation
      (HTTP sidecar vs. CLI-in-container).
- [ ] With `OCR_ENABLED=false`, the stack runs exactly as today (graceful no-op).
- [ ] README/admin doc notes CPU/RAM footprint and that OCR is optional.

**Data/API/UI/Audit impact.** None. **Storage impact.** None.
**Tests.** Compose smoke check in CI; env parsing/validation unit test.

---

## PM-1002 — Async extraction pipeline foundation

**Goal.** Decouple text extraction from the upload transaction so slow OCR never
blocks a write; introduce extraction status tracking.

**Scope.** `extractionStatus` (+ `extractionError?`, `ocrApplied Boolean`) on
`DocumentVersion`; background worker; upload sets `pending` and enqueues.
**Non-goals.** No OCR yet (PM-1003) — worker still runs existing pdf/docx/text
extractors, just off the write path.

**Acceptance criteria.**
- [ ] New enum `ExtractionStatus { pending, processing, done, failed, skipped }`
      in `policytracker`; `DocumentVersion.extractionStatus @default(pending)`.
- [ ] Upload commits the version WITHOUT waiting on extraction; a cheap inline
      fast path MAY set `done` synchronously for small text/docx/text-PDF files.
- [ ] A worker (`@nestjs/schedule` sweep or queue) picks up `pending`/`failed`
      (bounded retries) versions and backfills `extractedText`,
      `hasExtractedText`, `extractionStatus`.
- [ ] Extraction failure sets `failed` + `extractionError`; version bytes and the
      upload result are unaffected (best-effort contract preserved).
- [ ] Migration verified present in `policytracker`, absent from `public`.

**Data model impact.** `DocumentVersion` gains `extractionStatus`, `extractionError`,
`ocrApplied`; new `ExtractionStatus` enum.
**API impact.** Version/detail projections expose `extractionStatus` +
`hasExtractedText` (no text leakage — same scope rules).
**Audit impact.** Extraction completion/failure recorded as a system audit event
(no user principal) or logged; do not spam per-attempt.
**Tests.** Unit: upload no longer awaits extraction; worker transitions
pending→done and failure→failed with retry cap. Integration: upload returns before
extraction; row backfilled afterward. Negative: parser throw ⇒ `failed`, bytes
intact.

---

## PM-1003 — OcrService (images + scanned PDFs)

**Goal.** Implement the OCR engine wrapper the worker calls.

**Scope.** `OcrService` in `apps/api/src/documents/`: image bytes → text; scanned
PDF → text, optionally producing a **searchable-PDF rendition** stored under
`renditionS3Key` (never overwriting the original). Env-gated, best-effort,
timeouts + page/size caps enforced.
**Non-goals.** No routing logic (PM-1004); no search changes.

**Acceptance criteria.**
- [ ] Supported inputs: `png,jpg/jpeg,tiff,bmp` images and image-only PDFs.
- [ ] Respects `OCR_MAX_PAGES`, `OCR_MAX_FILE_MB`, `OCR_TIMEOUT_MS`; over-cap ⇒
      `skipped` with a reason, never a crash.
- [ ] `OCR_ENABLED=false` ⇒ service returns empty result (no external call).
- [ ] Output capped by existing `MAX_EXTRACTED_TEXT_CHARS`.
- [ ] Searchable-PDF rendition (if produced) is a **new S3 object**; original bytes
      untouched (AGENTS.md §9).

**Storage impact.** May add a rendition object; deterministic key, private,
presigned-only. **Security.** OCR text obeys download scope (§8); OCR container
endpoint allow-listed (no SSRF), like the OnlyOffice callback pattern.
**Tests.** Unit with a mocked engine: image→text, scanned-PDF→text, timeout⇒skip,
oversize⇒skip, disabled⇒empty. No real OCR binary in unit tests.

---

## PM-1004 — Route OCR inside the extraction dispatch

**Goal.** Extend extraction dispatch so images and image-only PDFs go through OCR
while the existing fast paths are preserved.

**Scope.** Extend `selectExtractor`/`TextExtractionService` (or the worker) to:
route image mime/exts → `ocr`; detect **image-only PDFs** (text-layer extraction
yields empty/very-low character count per page) → `ocr`; keep `pdf`/`docx`/`text`
fast paths unchanged. Set `ocrApplied=true` when OCR ran.
**Non-goals.** No new engine; no search changes.

**Acceptance criteria.**
- [ ] Image upload ⇒ OCR path ⇒ `extractedText` populated, `ocrApplied=true`.
- [ ] Text-based PDF/DOCX ⇒ existing fast path, `ocrApplied=false` (no OCR cost).
- [ ] Scanned/image-only PDF (pdf-parse ~empty) ⇒ OCR fallback ⇒ text populated.
- [ ] The PNG-yields-empty test is updated to reflect OCR (or split: disabled⇒empty,
      enabled⇒text via mocked engine).

**Tests.** Unit: dispatch decisions (image⇒ocr, rich-PDF⇒pdf, empty-PDF⇒ocr
fallback) with a mocked OcrService. Regression: existing extraction specs stay
green.

---

## PM-1005 — PostgreSQL full-text search

**Goal.** Replace `ILIKE` matching with ranked full-text search, same API contract.

**Scope.** Add a `tsvector` over `title + extractedText` (generated column or
maintained column) + **GIN index** in `policytracker`; update the internal query
builder and public `/api/v1/search` to match with `@@` and order by `ts_rank`,
preserving all existing filters (category, owner, tag, status, accessLevel, review
dates) and pagination.
**Non-goals.** No embeddings/pgvector (deferred RAG). No response-shape change.

**Acceptance criteria.**
- [ ] tsvector column + GIN index created via migration, verified in
      `policytracker`; index is used (EXPLAIN shows GIN, not seq scan) on a seeded
      set.
- [ ] Internal library search and `/api/v1/search` return the same JSON shape as
      today; results ordered by relevance; existing filter tests still pass.
- [ ] Multi-word queries stem/normalize (`policies` matches `policy`); snippet
      logic still returns a highlight.
- [ ] Documented fallback: if full-text flag off, ILIKE path still works.

**Data model impact.** `DocumentVersion` (or a search-projection view) gains the
tsvector + GIN index. **API impact.** Same contract; Swagger note on ranking.
**Tests.** Unit: query builder emits full-text predicate + rank ordering.
Integration: seeded docs rank correctly; filters compose with search; stemming
case. Perf note: index present.

---

## PM-1006 — Backfill / reindex existing versions

**Goal.** Make already-uploaded content searchable under the new pipeline.

**Scope.** One-off, gated, audited admin task/endpoint (or CLI) that (a) sets
`extractionStatus` on legacy versions and **enqueues OCR** for image/scanned
versions that previously produced no text, and (b) ensures the tsvector is
populated for existing rows.
**Non-goals.** No destructive ops; idempotent and resumable.

**Acceptance criteria.**
- [ ] Reindex is idempotent (safe to re-run) and processes in bounded batches.
- [ ] Legacy image/scanned versions with empty text get `pending` and are OCR'd.
- [ ] tsvector populated for all existing rows after run.
- [ ] Gated by an admin permission (e.g. `storage.manage`/`api.manage`) and audited.

**Tests.** Integration: seed legacy rows (empty text, image mime) ⇒ run ⇒ enqueued
+ eventually `done`; re-run is a no-op. Negative: unauthorized ⇒ 403.

---

## PM-1007 — UI: search relevance + extraction/OCR status

**Goal.** Surface OCR/extraction state and use ranked search in the library.

**Scope.** Library search uses ranked results; document detail/version list shows
an extraction badge (`pending`/`processing`/`failed`/`searchable`); optional
"scanned — text extracted via OCR" indicator.
**Non-goals.** No re-OCR-from-UI button in v1 (can be a follow-up).

**Acceptance criteria.**
- [ ] Version/detail shows extraction status with clear affordance; `pending`/
      `failed` explained (not a blank).
- [ ] Search results reflect ranking; loading/empty/error states present (§10c).
- [ ] Accessible: labeled controls, keyboard nav, sufficient contrast.

**Tests.** Component: status badge renders each state; search list loading/empty/
error. A11y check on new controls.

---

## PM-1008 — Docs, ADR finalize, and skill

**Goal.** Keep developer/admin/user docs and the framework current.

**Scope.** Developer docs (async extraction + OCR pipeline + full-text search);
admin docs (enabling OCR, languages, sizing, disabling); user guide (scanned docs
become searchable, why a fresh scan is briefly "pending"); finalize ADR-0001; add
`.ai/skills/ocr-extraction.md`.
**Acceptance criteria.**
- [ ] Each of dev/admin/user docs updated; ADR status stays Accepted with any
      as-built deltas noted.
- [ ] New skill documents the OCR/extraction procedure for future agents.

**Tests.** Docs review via `.ai/commands/docs-check.md`; no behavior code.
