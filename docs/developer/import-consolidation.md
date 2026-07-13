# Import & Consolidation (Phase 8)

How the bulk importer onboards scattered documents into PolicyManager via a CSV
manifest or a manifest-less file upload, with duplicate detection, per-row error
isolation, and an import report. Covers backlog tickets PM-0801..PM-0806.

## Design principle: reuse, don't duplicate

The importer never re-implements storage or versioning. Each new document is
created through `DocumentsService.create` and its first file is stored through
`DocumentsService.addVersion` — the SAME path the library upload uses, so S3
storage, the sha256 checksum, text extraction, and the PDF rendition all happen
exactly once and identically (AGENTS.md §9). `ImportsService` only orchestrates:
parse → dedupe → resolve → delegate → record.

## Data model (`policytracker` schema)

Migration `prisma/migrations/*_imports` — adds 0 objects to `public` (verify with
the query in `AGENTS.md` §3).

- **`ImportBatch`** — one import run. `createdById`, `fileName?` (the manifest name;
  null for bulk), `totalRows`, rollup counters `createdCount`/`duplicateCount`/
  `errorCount`, `status` (`processing|completed|failed`), `completedAt?`. The
  counters are authoritative — they equal the number of `ImportItem`s in each
  terminal state.
- **`ImportItem`** — the immutable per-row report line. Records the source row's key
  fields (`rowNumber`, `title?`, `documentNumber?`, `categoryName?`, `fileName?`)
  even when nothing was created, plus `status` (`ImportItemStatus`), `documentId?`
  (the created OR matched document), and a human `message`. Cascade-deleted with its
  batch; `documentId` is `SetNull` if the document is ever removed.
- **`ImportItemStatus`** enum — `pending|created|duplicate|error|skipped`.

## Manifest format (`manifest.ts`, pure + unit-tested)

Columns (header matched case-insensitively; unknown columns ignored):

```
fileName,title,category,documentNumber,owner,tags,accessLevel,reviewCadence,description
```

- **`title` is required.** A blank title is a per-row **error**, not a whole-file
  failure. A missing `title` COLUMN, unparseable CSV, or exceeding
  `MAX_MANIFEST_ROWS` (5000) is a whole-file `400`.
- `tags` are separated by `;` or `|` inside the one cell (comma is the field
  delimiter); trimmed + de-duplicated.
- `category` is a `/`-separated path (`Policies & Procedures/Clinical`).
- `accessLevel` / `reviewCadence`, when present, must be valid enum values — an
  invalid value is a per-row **error** (isolated; the rest of the batch proceeds).
- A downloadable **sample manifest** (`SAMPLE_MANIFEST_CSV`, shared package) keeps
  the template header in lock-step with the columns.

## Duplicate detection (`dedupe.ts`, pure + unit-tested)

Before creating anything, up to three lookups run against **non-deleted** documents;
`findDuplicate` applies a strict precedence and the first hit wins:

1. **`documentNumber`** — same controlled number (strongest identity);
2. **`checksum`** — an existing `DocumentVersion` with the same sha256 (identical
   bytes) — this is what makes re-imports idempotent even without a number;
3. **`title+fileName`** — a document with the same title AND a version with the same
   file name.

A match records the row as `duplicate` (creation skipped) referencing the existing
`documentId`. Keeping the decision pure makes the precedence trivially testable and
identical for the manifest and bulk paths. A lost race on the unique document-number
constraint (`ConflictException` from `create`) is also surfaced as `duplicate`.

## Row processing & isolation (`imports.service.ts`)

Rows are processed **sequentially** (so intra-batch duplicates are caught — the
second row referencing a just-created number/checksum dedupes against the first) and
each is wrapped so **one bad row never fails the batch** — it becomes an `error`
item and processing continues.

Per manifest row:

1. **Match the file** by name. A referenced-but-unuploaded file → `error`. A row with
   no `fileName` creates a metadata-only document.
2. **Dedupe** (number / checksum / title+fileName) → `duplicate` if matched.
3. **Resolve category** — `resolveCategoryPath` find-or-creates each path segment,
   reusing existing categories so re-imports never create duplicate folders
   (idempotent; a per-batch cache avoids redundant lookups/creates).
4. **Resolve owner** — by email (case-insensitive); unknown/blank → the importer.
5. **Create** via `DocumentsService.create`, **upload** the first version via
   `addVersion` **while the importer still owns the document** (so the edit-access
   check holds), then transfer ownership if a different owner was resolved.

Bulk mode (`POST /imports/bulk`): each file becomes a document titled from its file
name (`titleFromFileName`), de-duplicated by checksum (+ title/fileName).

Finally the batch counters are rolled up, `status` set to `completed`, and one
`import.completed` audit event is written with the summary (AGENTS.md §7).

## API surface & RBAC

Every route is gated by **`document.write`** (JwtAuthGuard + PermissionsGuard) —
importing creates documents, so the whole controller is a write surface.
Unauthenticated → `401`; authenticated without `document.write` → `403`.

| Method & path | Body | Returns |
| --- | --- | --- |
| `POST /api/imports` | multipart: `manifest` (CSV) + `files[]` | The import report (batch + per-row items). |
| `POST /api/imports/bulk` | multipart: `files[]` | The import report. |
| `GET /api/imports` | — | Paginated batch history (newest first). |
| `GET /api/imports/:id` | — | One batch + its full per-row report. |

Per-file cap 50 MB, max 200 files/request. Audit action added: `import.completed`.
Server-side enforcement only — UI hiding is never the boundary (AGENTS.md §8).

## Web

- **`/library/import`** (nav "Import", `document.write`): a CSV-manifest tab (manifest
  file + referenced files, with a pre-submit preview showing detected columns/row
  count and a missing-`title` hint) and a "Files only" bulk tab, a
  **Download sample manifest** button, and — after a run — the **report** table
  (per-row status badge + message, links to created/matched documents) with summary
  tiles. A **Recent imports** list loads any past batch's report on demand. Full
  loading / empty / error / forbidden states (AGENTS.md §10c).

## Tests

- Unit (mocked Prisma / DocumentsService / audit): `manifest.spec` (header detection,
  required-title, per-row validation isolation, tag & path parsing, guardrails),
  `dedupe.spec` (precedence + no-match), `imports.service.spec` (counter rollup, error
  isolation, missing-file error, category idempotency, owner resolve + transfer, bulk
  checksum dedupe, empty-input 400s).
- e2e (`test/imports.e2e-spec.ts`, live Postgres + MinIO): a 3-row manifest → 1
  created / 1 duplicate / 1 error with correct counters → the created document is a
  real, retrievable v1 with the right checksum + auto-created category → `GET
  /imports/:id` report → re-running the same manifest creates nothing (idempotent) →
  bulk create then checksum-dedupe → 401/403 → schema proof.
