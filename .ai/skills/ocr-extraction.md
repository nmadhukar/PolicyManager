# Skill: OCR And Asynchronous Text Extraction

## Purpose

Make scanned images and image-only PDFs searchable by running OCR **off the upload
path** and backfilling the same `extractedText` column that already feeds search
and the public API — without mutating source bytes.

## Use When

- Adding OCR for images (`png/jpg/tiff/bmp`) or image-only/scanned PDFs.
- Moving text extraction out of the upload transaction.
- Wiring the OCR engine (`OcrService`) into extraction dispatch.

## Key Contracts (do not violate)

- **Best-effort, never blocks or crashes an upload.** Extraction failure sets
  `extractionStatus = failed`; the version and its bytes are unaffected.
- **Source bytes are immutable** (AGENTS.md §9). OCR may produce a *new* searchable-
  PDF rendition object under `renditionS3Key`; it never overwrites the original.
- **Same scope as download** (AGENTS.md §8). OCR text is only readable by principals
  who could download the file. `hasExtractedText` may be exposed; the text is not,
  except through the existing scoped content endpoints.
- **Env-gated.** `OCR_ENABLED=false` ⇒ image/scanned inputs resolve to empty text
  and `extractionStatus = skipped`, exactly as today (no external call).

## Procedure

1. **Upload writes fast.** Persist the `DocumentVersion` with
   `extractionStatus = pending`; do NOT await OCR inside the upload transaction.
   A cheap inline fast path MAY extract small text/docx/text-PDF files and commit
   `done` synchronously.
2. **Worker picks up work.** A `@nestjs/schedule` sweep (or queue consumer) claims
   `pending` (and `failed` under a bounded retry count) versions, sets
   `processing`, and runs extraction.
3. **Dispatch by type** (`selectExtractor`):
   - text-based PDF / DOCX / text ⇒ existing fast extractors, `ocrApplied=false`;
   - image mime/ext ⇒ `OcrService`, `ocrApplied=true`;
   - PDF whose text layer yields empty/very-low chars per page ⇒ OCR **fallback**,
     `ocrApplied=true`.
4. **Enforce limits in `OcrService`.** Honor `OCR_MAX_PAGES`, `OCR_MAX_FILE_MB`,
   `OCR_TIMEOUT_MS`; over-cap ⇒ `skipped` with a reason. Allow-list the OCR engine
   endpoint (no SSRF), like the OnlyOffice callback pattern.
5. **Cap and store.** Cap output at `MAX_EXTRACTED_TEXT_CHARS`; write
   `extractedText`, `hasExtractedText`, `ocrApplied`, and `extractionStatus=done`.
   If a searchable PDF was produced, store it as a new object and set
   `renditionS3Key` (never mutate the original).
6. **Search needs nothing extra.** The write to `extractedText` is what search
   indexes; if PM-1005 full-text is live, the tsvector updates from the same write.
7. **Surface status in the UI.** Show `pending/processing/failed/searchable` on the
   document/version so a fresh scan isn't a blank (AGENTS.md §10c).
8. **Record a system audit/log line** on completion/failure; do not spam per retry.
9. **Update docs and comments** for the async contract, failure modes, and the
   OCR env keys.

## Testing Notes

- Unit-test with a **mocked OCR engine** — no real binary in unit tests: image⇒text,
  scanned-PDF⇒text, timeout⇒skip, oversize⇒skip, disabled⇒empty, parser throw⇒failed.
- Assert upload returns **before** extraction completes and the row is backfilled
  afterward (integration).
- Keep existing extraction specs green; update the "PNG yields empty" test to the
  disabled-vs-enabled split.

## Required Companion Skills

- `.ai/skills/document-rendition-viewer.md` — rendition key/privacy rules.
- `.ai/skills/s3-storage-safety.md` — S3 key/privacy/audit rules.
- `.ai/skills/migration-safety.md` and `MIGRATION_CHECKLIST_OCR_SEARCH.md` — the
  `extractionStatus` + tsvector migrations.
- `.ai/skills/tdd-loop.md` — red→green→refactor.
