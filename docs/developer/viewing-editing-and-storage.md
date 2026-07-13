# Viewing, Editing & Storage Admin (Phase 3b)

How uniform PDF renditions, the read-only in-browser viewer, in-place editing
(OnlyOffice + TipTap), and the Storage Admin UI fit together. Covers backlog
tickets PM-0309..PM-0314. Builds on
[documents-and-versioning.md](./documents-and-versioning.md).

## Core invariants (AGENTS.md §10a)

- **Renditions never mutate the source.** A version's immutable source bytes are
  never converted in place; the PDF rendition is a *separate* derived object at a
  disjoint key.
- **Every editor save-back = a NEW immutable `DocumentVersion`** (new object, new
  checksum), never an overwrite. `currentVersionId` advances; history grows.
- **View-only users never get an editor.** The viewer is read-only; editing
  requires `document.write` (enforced server-side).

## PDF renditions (`documents/rendition.service.ts`)

On every version write (upload, TipTap save, OnlyOffice save-back) a uniform PDF
rendition is generated **best-effort** via a self-hosted Gotenberg instance and
stored at a deterministic key
(`${S3_PREFIX_RENDITIONS}{documentId}/v{n}/rendition.pdf`), recorded as
`renditionS3Key`.

Dispatch (`renditionStrategyFor`, pure + unit-tested):

| Source | Strategy | Pipeline |
| --- | --- | --- |
| PDF | `passthrough` | none — the source PDF is viewed directly |
| image/\* | `image` | none — rendered natively in the browser |
| html | `html` | Gotenberg **Chromium** `/forms/chromium/convert/html` |
| docx/doc/xlsx/xls/pptx/ppt/odt/ods/odp/rtf/txt/md/csv | `office` | Gotenberg **LibreOffice** `/forms/libreoffice/convert` |
| anything else | `none` | download-only |

**Failure policy:** any conversion/storage error is logged and yields
`renditionS3Key: null` — it must never fail the upload/version write. The original
stays downloadable, and a rendition can be regenerated on demand
(`POST /versions/:versionId/rendition`). Env: `GOTENBERG_URL`,
`GOTENBERG_TIMEOUT_MS`.

## In-browser viewer (`web/src/ui/DocumentViewer.tsx`)

`GET /versions/:versionId/view-url` (`document.read`) authorizes then returns a
short-lived (≤300s) **inline** presigned URL to the PDF rendition, the source PDF,
or a source image — never the raw office bytes. Office/text sources without a
rendition yet return `404` (regenerate first). The web viewer renders PDFs with
`react-pdf`/pdf.js (text/annotation layers off) and images natively. It is
code-split (lazy) so pdf.js is only loaded when a preview is opened.

## OnlyOffice editing (`documents/onlyoffice.service.ts`)

Editing docx/xlsx/pptx uses a self-hosted OnlyOffice DocumentServer.

- `GET /:id/editor-config` (`document.write`) resolves the **current** version,
  rejects non-editable types (`400`), and returns a **signed** (HS256,
  `ONLYOFFICE_JWT_SECRET`) config. `document.key` is the immutable version id, so
  the Docs cache invalidates when the version changes.
- **Server-to-server routes** (no user JWT — the Docs server calls them directly)
  live on a guardless controller (`documents-editor.controller.ts`) and are
  authenticated by short-lived, purpose-scoped signed tokens:
  - `GET /:id/versions/:versionId/content?token=…` streams the source bytes
    (scoped `content` token).
  - `POST /:id/editor-callback?token=…` receives the save callback (scoped
    `callback` token that also carries the edited versionId + editor user). The
    Docs server's own JWT signature over the body is **also** verified.
- On a save status (`2` ready-to-save / `6` force-save) the edited bytes are
  downloaded and written as a **new** version (`changeSummary: "Edited in
  OnlyOffice"`); other statuses just ack `{ error: 0 }`.

> ⚠️ **Networking (Docker Desktop / Windows).** The Docs *container* reaches this
> API via **`host.docker.internal`**, not `localhost`. All content + callback
> URLs are built from `ONLYOFFICE_API_INTERNAL_URL`
> (default `http://host.docker.internal:3000`). On Linux, the `onlyoffice`
> service in `docker-compose.yml` maps `host.docker.internal` to `host-gateway`.
> The `body.url` the Docs server returns for the edited file is built from *its*
> view of the network; ensure the API can reach that origin (or front both behind
> one hostname) in production.

## TipTap native authoring (`web/src/ui/TipTapEditor.tsx`)

App-authored rich text. `POST /:id/versions/html` (`document.write`) stores the
HTML as a new version (`document.html`, `text/html`) and generates a PDF rendition
via the Gotenberg Chromium route. `GET /:id/versions/:versionId/html`
(`document.read`) returns the HTML for editing. Save == new version.

## Storage Admin (`storage-admin/`, `web/src/pages/StorageAdminPage.tsx`)

All routes require `storage.manage`. **Non-destructive in v1** — create + list
only, no delete surface (AGENTS.md §9).

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/storage/config` | Default bucket + prefixes (read-only). |
| GET | `/api/storage/buckets` | List buckets (flags the default). |
| POST | `/api/storage/buckets` | Create a **private + versioned** bucket. Name validated (DNS-style); `409` if it exists. |
| GET | `/api/storage/prefixes?bucket=` | List immediate folders (common prefixes). |
| POST | `/api/storage/prefixes` | Create a zero-byte folder marker. |

Created buckets get versioning enabled and a public-access block (best-effort —
MinIO ignores the block but is private by default). Bucket-name and folder-name
validation are pure, unit-tested helpers in `storage/s3-key.util.ts`.

## Endpoint summary (Phase 3b additions)

| Method | Path | Permission / auth |
| --- | --- | --- |
| GET | `/api/documents/:id/versions/:versionId/view-url` | `document.read` |
| POST | `/api/documents/:id/versions/:versionId/rendition` | `document.write` |
| GET | `/api/documents/:id/versions/:versionId/html` | `document.read` |
| POST | `/api/documents/:id/versions/html` | `document.write` |
| GET | `/api/documents/:id/editor-config` | `document.write` |
| GET | `/api/documents/:id/versions/:versionId/content` | scoped `content` token |
| POST | `/api/documents/:id/editor-callback` | scoped `callback` token + Docs JWT |
| GET/POST | `/api/storage/{config,buckets,prefixes}` | `storage.manage` |

## Environment

```
GOTENBERG_URL=http://localhost:3001
GOTENBERG_TIMEOUT_MS=60000
ONLYOFFICE_URL=http://localhost:8080                     # browser loads DocsAPI here
ONLYOFFICE_JWT_SECRET=change-me-onlyoffice               # editor + callback signing
ONLYOFFICE_API_INTERNAL_URL=http://host.docker.internal:3000  # Docs container → API
S3_PREFIX_RENDITIONS=renditions/
VITE_ONLYOFFICE_URL=http://localhost:8080                # web build
```

`docker-compose.yml` runs `gotenberg` (`:3001→3000`) and `onlyoffice`
(`:8080→80`, JWT enabled, `host.docker.internal` mapped).

## Testing

- **Unit** (`npm test -w @policymanager/api`): rendition dispatch (which types
  convert; failure ⇒ null but the write still succeeds) + the Gotenberg multipart
  contract; OnlyOffice token signing/scoping, editor-config building, callback
  status handling + signature verification; `DocumentsService` view-url
  authorization, editor-config resolution, save-callback ⇒ new-version, HTML save,
  rendition regeneration (Prisma/S3/Gotenberg mocked); Storage Admin bucket/prefix
  validation + conflict mapping; bucket-name/folder pure validators.
- **Web** (`npm test -w @policymanager/web`): Storage Admin RBAC + create/list
  flows; detail-page View/Edit/New-text affordance gating (heavy surfaces
  stubbed).
- **E2E** (`test/phase3b.e2e-spec.ts`, `npm run test:e2e`): against live Postgres
  + MinIO + **real Gotenberg** — .txt and .docx rendition + view-url; a
  JWT-signed OnlyOffice save callback (status 2) creating a new version and
  advancing `currentVersionId`; forged/invalid callback tokens ⇒ 401; Storage
  Admin bucket/prefix create+list; `403` for a user without `storage.manage`.
