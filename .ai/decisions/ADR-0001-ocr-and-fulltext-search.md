# ADR-0001: OCR and Full-Text Search Indexing

- Status: Accepted
- Date: 2026-07-13
- Deciders: User (product owner), Claude (architect)
- Phase: 10
- Supersedes: none

## Context

PolicyManager stores document **bytes in S3/MinIO** and all **metadata + extracted
text in PostgreSQL (`policytracker`)**. Search runs against Postgres, not S3:
`extractedText @db.Text` on `DocumentVersion` is populated at upload time by
`TextExtractionService`, and both the internal library search and the public
`/api/v1/search` match against it.

Two gaps exist today:

1. **No OCR.** `TextExtractionService.extract()` handles text-based PDF, DOCX, and
   plain text only. **Image uploads and image-only (scanned) PDFs yield `''`**, so
   scanned intake — a core DMS expectation for a clinic consolidating paper P&P —
   is invisible to search and to the AI/EMR API.
2. **Search is substring `ILIKE`.** Adequate for a small corpus, but it has no
   ranking and degrades as OCR adds large volumes of indexed text.

## Decision

### D1 — OCR engine: self-hosted Tesseract via OCRmyPDF

Use **self-hosted OCR in a Docker container**, consistent with the existing
self-hosted fleet (MinIO, Gotenberg, OnlyOffice). **OCRmyPDF** (which wraps
Tesseract and can add a searchable text layer to a scanned PDF) is the primary
path for scanned PDFs; **Tesseract** handles standalone image uploads.

Rejected: **AWS Textract**. Higher accuracy on handwriting, but adds per-page
cost, couples the app to AWS, and sends document content to an external OCR
service. The `OcrService` interface is kept narrow so a Textract adapter can be
added later behind an env flag without touching callers.

### D2 — Extraction becomes asynchronous

OCR is slow (seconds per page); a 30-page scan cannot block the upload
transaction. Extraction is **decoupled from the upload write path**:

- Upload persists the version immediately with `extractionStatus = pending`
  (cheap text formats MAY still extract inline and commit `done`).
- A background worker performs extraction/OCR and **backfills** `extractedText`,
  `hasExtractedText`, and `extractionStatus`.
- Extraction remains **best-effort**: a failure sets `extractionStatus = failed`
  with an error note and NEVER affects the stored version bytes or the upload
  result.

### D3 — Search upgraded to PostgreSQL full-text

Add a **`tsvector`** representation over `title + extractedText` with a **GIN
index** in the `policytracker` schema, and rank results with `ts_rank`. The
internal query builder and public `/api/v1/search` adopt it **behind the same API
contract** (same request/response shape, same filters). No pgvector/embeddings
here — that stays the deferred RAG phase, behind this same contract.

## Consequences

- **Search "just works" on OCR output**: OCR writes to the existing
  `extractedText` column, which already feeds both search surfaces. No search
  callers change their contract.
- New `extractionStatus` (and `ocrApplied`) columns on `DocumentVersion` require a
  migration, **verified in `policytracker`, never `public`** (AGENTS.md §3).
- Upload latency drops (no inline OCR); document detail must surface extraction
  status (pending/failed) so users understand why a fresh scan isn't yet
  searchable — an explicit UI state (AGENTS.md §10c).
- New infra dependency (OCR container) with CPU/memory cost; must be **env-gated**
  (`OCR_ENABLED`) so environments without it degrade gracefully to "no OCR",
  exactly as today.
- A **backfill** is needed for pre-existing image/scanned versions and to populate
  the tsvector for existing rows.

## Rollout / rollback

- Ship behind `OCR_ENABLED` (default off) and a search feature flag; the ILIKE
  path stays as the documented fallback until full-text is verified.
- Rollback = disable the flags; no version bytes are ever mutated by OCR, and the
  tsvector/GIN objects are additive and droppable.

## Related

- `PLAN.md` (Phase 7 deferred — RAG), AGENTS.md §3 (schema), §8 (scope: OCR text
  obeys download scope), §9 (storage), §10c (UI states).
- Skills: `.ai/skills/document-rendition-viewer.md`, `add-prisma-model.md`,
  `migration-safety.md`, `public-api-contract.md`.
