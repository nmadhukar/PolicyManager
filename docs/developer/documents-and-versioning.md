# Documents & Versioning (Phase 3)

How the document store, immutable versioning, S3/MinIO storage, and text
extraction fit together. Covers backlog tickets PM-0301..PM-0308, PM-0315,
PM-0316.

## Data model (`policytracker` schema)

All models live in the `policytracker` schema (never `public`).

- **`DocumentCategory`** — hierarchical folders via a self-relation
  (`parentId`). Arbitrary depth; orphans surface as roots when the tree is built.
- **`Document`** — the stable *logical* entity (e.g. "Seclusion & Restraint
  Policy", `PP-042`). Holds metadata: `title` (required), `documentNumber`
  (unique, optional), `categoryId`, `ownerId`, `description`, `tags[]`, `status`
  (`draft → in_review → approved → published → archived/retired`), `accessLevel`
  (`public|restricted|confidential`), `reviewCadence`, `nextReviewDate`,
  `effectiveDate`, and `currentVersionId` → the version currently surfaced.
- **`DocumentVersion`** — an **immutable** snapshot of file bytes. Fields:
  `versionNumber` (unique per document), `s3Key`, `s3VersionId`, `renditionS3Key`
  (the derived PDF for viewing — populated in Phase 3b, see
  [viewing-editing-and-storage.md](./viewing-editing-and-storage.md)), `fileName`,
  `mimeType`, `sizeBytes`, `checksum` (sha256), `uploadedById`, `changeSummary`,
  `status`, `extractedText`.

The `Document` ⇄ `DocumentVersion` cycle (`currentVersionId` ↔ `documentId`) is
broken by a nullable FK with `onDelete: NoAction` so Postgres accepts it.

Migration: `prisma/migrations/*_documents_versioning`. Verify placement with the
query in `AGENTS.md` §3 — Phase 3 adds 0 objects to `public`.

### Category creation UI

The web app exposes `POST /api/document-categories` through the shared
`CategorySelectWithCreate` control. It is used in the document create and
metadata edit flows so document writers can add missing root or child categories
without leaving the document workflow. The control invalidates the `category-tree`
query after creation and keeps the newly created option locally selected while
the tree refreshes.

### Initial schema bootstrap

The initial auth/RBAC migration creates the app-owned PostgreSQL schema with
`CREATE SCHEMA IF NOT EXISTS "policytracker"` before creating any types or
tables. This keeps `prisma migrate deploy` reliable on a completely empty
database and preserves the no-application-objects-in-`public` rule.

## Immutability & storage invariants (AGENTS.md §9)

- **Every upload creates a new `DocumentVersion` row + a new S3 object.** Prior
  version bytes are never overwritten.
- **Deterministic keys:** `${S3_PREFIX_DOCUMENTS}{documentId}/v{n}/{safeFileName}`
  (`storage/s3-key.util.ts`). File names are sanitized to a single safe path
  segment, so a malicious name (`../../x`) cannot escape the prefix.
- **Checksum** (sha256) and the S3 `versionId` are stored for every upload.
- Version numbers are monotonic: `computeNextVersionNumber(max)` = `max + 1`.

## `S3Service` (`storage/s3.service.ts`)

Env-driven so one image serves MinIO (local) and AWS/S3-compatible storage
(prod). Configuration: `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`,
`S3_ACCESS_KEY_ID/SECRET`, `S3_FORCE_PATH_STYLE`, `S3_PREFIX_DOCUMENTS`,
`S3_SSE`, `S3_KMS_KEY_ID`, `S3_AUTO_CREATE`.

- `onModuleInit`: when `S3_AUTO_CREATE=true`, `HeadBucket` → `CreateBucket` if
  missing, then enable **bucket versioning** and apply a public-access block.
  Failures log a warning (non-fatal). Production bucket/KMS/public-access changes
  stay gated behind explicit env flags.
- Development `minioadmin` credential defaults are allowed only for explicit local
  endpoints (`localhost`, `127.*`, `host.docker.internal`). Private/VPC endpoints
  must set `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` explicitly.
- `buildDocumentKey`, `putObject` (returns `{ versionId }`), and
  `getPresignedDownloadUrl(key, ttl=300, fileName?)`.
- The bucket is **never** made public. Bytes leave the system only through a
  short-lived presigned URL, and only after the service authorizes the caller.

## Text extraction (`documents/text-extraction.service.ts`)

Best-effort, RAG-ready plain-text extraction on upload:

- PDF → `pdf-parse` (pdf.js), DOCX → `mammoth`, TXT/MD/CSV → UTF-8. Everything
  else (images, legacy binary `.doc`) → empty.
- **Never crashes an upload**: any parser failure is logged and yields `''`.
- Output is capped at 1,000,000 chars.
- The extracted text is stored but **not returned** by these endpoints — the API
  exposes only `hasExtractedText: boolean`. Full-text access will obey the same
  scope as file download (AGENTS.md §8) when the public API ships (Phase 6).

> **pdf.js + Jest:** pdf.js loads its worker via an ESM dynamic import, which
> needs `--experimental-vm-modules` under Jest. It is baked into the `test:e2e`
> script (`cross-env NODE_OPTIONS=--experimental-vm-modules`). The real Node
> runtime needs no flag.

## HTTP API (internal, JWT + RBAC)

Reads require `document.read`; writes/uploads require `document.write`. Guards
enforce this server-side (`JwtAuthGuard` + `PermissionsGuard`): missing/invalid
token → `401`, authenticated-but-unpermitted → `403`.

| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| POST | `/api/documents` | `document.write` | `title` required; owner = caller. |
| GET | `/api/documents` | `document.read` | Paginated/filterable/sortable (below). |
| GET | `/api/documents/:id` | `document.read` | Detail + full version history (newest first). |
| PATCH | `/api/documents/:id` | `document.write` | Partial metadata; `tags` replaces the set; dates accept `null`. |
| POST | `/api/documents/:id/versions` | `document.write` | Multipart `file` (+ `changeSummary`); creates the next immutable version. |
| GET | `/api/documents/:id/versions/:versionId/download` | `document.read` | Returns `{ url, expiresIn, fileName }` (presigned, ≤300s). |
| GET | `/api/document-categories` | `document.read` | Category tree. |
| POST | `/api/document-categories` | `document.write` | Create (optional `parentId`). |

**List query params:** `q` (free text over title/number/description),
`categoryId`, `ownerId`, `tag`, `status`, `accessLevel`, `reviewBefore`,
`reviewAfter`, `page` (default 1), `pageSize` (default 20, max 100), `sort`
(`title|createdAt|nextReviewDate|status`), `order` (`asc|desc`). Response:
`{ items, total, page, pageSize }`. Query building is a pure, unit-tested
function (`documents/document-query.ts`); the `sort` field is whitelisted to
prevent ordering by arbitrary columns. Swagger is published at `/api/docs`.

## Testing

- **Unit** (`*.spec.ts`, `npm test -w @policymanager/api`): S3 key builder +
  sanitization, checksum, version increment, list filter/sort/pagination query
  building, text-extraction dispatch, category-tree assembly, and
  `DocumentsService` create/update/list/upload/download logic (Prisma mocked).
- **E2E** (`test/documents.e2e-spec.ts`, `npm run test:e2e`): against live
  Postgres + MinIO — title-required (400), PDF upload (stored + correct
  checksum + extracted text), list-with-filters, presigned download, and 401
  without a token.

## Phase 3b — viewing, editing, storage admin

PDF renditions, the in-browser viewer, OnlyOffice/TipTap editing, and the Storage
Admin UI (PM-0309..PM-0314) are documented in
[viewing-editing-and-storage.md](./viewing-editing-and-storage.md).

## Not in this phase (follow-ups)

- `AuditEvent` on document access/state changes — **Phase 4** (Access Control &
  Audit). Not wired here.
