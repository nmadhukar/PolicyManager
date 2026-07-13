# Public API v1

Human-readable integration notes for the PolicyManager public API (Phase 7). The
machine-readable contract is the OpenAPI/Swagger document served at `/api/docs`
(tag **public-api-v1**, security scheme **api-key**).

## Principles

- **Read-only.** Every route is `GET`; there are no write routes under `/api/v1`.
- **Scoped by API client.** A client holds a subset of scopes and, optionally, a
  category allow-list.
- **Audited.** Every call writes an `AuditEvent` with `source=api` and the
  `apiClientId`.
- **Versioned** under `/api/v1`, separate from the JWT-guarded internal API.

## Authentication

Clients are managed by an administrator (`api.manage`) under
**Admin → API Clients** in the web app. Creating (or rotating) a client returns a
`clientId.secret` **credential exactly once** — only its Argon2 hash is stored, so
it can never be retrieved again (rotate to get a new one).

Send the credential as either header:

```
Authorization: Bearer <clientId>.<secret>
X-Api-Key: <clientId>.<secret>
```

- Missing / invalid / disabled / revoked credential → `401`.
- Authenticated but missing the route's scope → `403`.

## Scopes

| Scope            | Unlocks                                             |
| ---------------- | --------------------------------------------------- |
| `documents:read` | list, detail, and version metadata (baseline)       |
| `content:read`   | extracted text and extracted-text search snippets   |
| `download`       | `GET /documents/:id/download` (presigned file URL)  |

## Visibility

A client only ever sees documents that are **published**, **not soft-deleted**,
**not confidential** (public/restricted only), and — when the client has a
non-empty allow-list — **within an allowed category**. A `categoryId` filter can
only narrow within that allow-list, never widen it. Documents outside the scope
read as `404` (their existence is not disclosed).

## Endpoints

| Method & path                          | Scope            | Returns                                             |
| -------------------------------------- | ---------------- | -------------------------------------------------- |
| `GET /api/v1/documents`                | `documents:read` | Paginated list. Filters: `q`, `categoryId`, `tag`, `updatedSince`, `page`, `pageSize`. |
| `GET /api/v1/documents/:id`            | `documents:read` | One document (metadata).                            |
| `GET /api/v1/documents/:id/content`    | `content:read`   | Current version's extracted text (RAG-ready).       |
| `GET /api/v1/documents/:id/download`   | `download`       | Short-lived (≤300s) presigned download URL.         |
| `GET /api/v1/documents/:id/versions`   | `documents:read` | Version history metadata (newest first).            |
| `GET /api/v1/search?q=`                | `documents:read` + `content:read` | Keyword hits over title + extracted text; each hit carries `score` + `snippet`. |

## Search & the RAG seam

Search uses PostgreSQL full-text ranking over document metadata and the current
version's extracted/OCR text. Because snippets can include extracted text,
`/api/v1/search` requires both `documents:read` and `content:read`. The response shape (`{ query, total, page, pageSize, items:[{ document, score, snippet }] }`)
is deliberately stable so a future pgvector/semantic backend can replace the match
predicate behind the **same contract** — existing integrations do not change.
