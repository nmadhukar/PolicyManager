# Maintain the MCP adapter

`apps/api/src/mcp/` adds a stateless SDK transport over the existing API. It dispatches a reviewed named tool to the original REST controller through `127.0.0.1` and the actual server socket port. Guards, DTO pipes, upload interceptors, ACLs, ownership, transactions, storage and domain audit behavior remain owned by the REST application. Never replace dispatch with direct business-service calls without reviewing those contracts.

## Ownership and extension

| File | Responsibility |
| --- | --- |
| `mcp.routes.ts` | Explicit 107-route allow-list, stable names, credential audience, permissions/scopes and nine approved exclusions |
| `mcp.catalog.ts` | Swagger normalization, local refs, query/file overrides, AJV validation, discovery filtering, annotations |
| `mcp.guard.ts` | Enabled/Origin/credential checks and live request-bound identity |
| `mcp.service.ts` | SDK request handlers, isolated transport, concurrency, cancellation, supplemental audit |
| `mcp.dispatch.ts` | Fixed loopback URL, credential forwarding, deadline, bounded response and errors |
| `mcp.files.ts` | Canonical base64 decoding and existing multipart field contracts |
| `mcp.bootstrap.ts` | Dedicated MCP JSON parser plus unchanged ordinary REST parser limits |
| `mcp.controller.ts` / `mcp.module.ts` | Nest wiring and POST/405 protocol surface |

`main.ts` creates Nest with `bodyParser:false`, installs the parsers, creates the actual Swagger document and configures MCP before listening. The port provider reads the server-established address. Never use an argument, forwarded Host header or configurable arbitrary target URL for dispatch. Path IDs cannot introduce slash/dot traversal; redirects are blocked. Credentials exist only in one authenticated request's closures and dispatch headers. A new SDK server/transport is created per HTTP request, with no shared sessions or token cache.

For a new REST operation, write a failing route-coverage/schema test first, then add its explicit registry row or an approved protocol exclusion. Names are stable public integration contracts; changing a controller method name does not justify silently renaming the tool. Copy permission/scope requirements from actual decorators and inspect service access rules. Every mapped operation must exist in Swagger; Swagger-excluded real routes still participate in completeness checks. A new route cannot automatically become a tool merely because Swagger lists it.

Review body/path/query schemas against DTOs and controllers. Nullable union DTO fields need explicit Swagger `type` and `nullable` metadata because reflection sees `Object`; this change corrects those existing declarations. Arbitrary dictionary DTOs intentionally remain open, while declared objects reject unknown properties. Local refs are resolved; missing, cyclic and external refs fail closed. The three inline query contracts for RAG conversation paging and storage prefix listing need reviewed overrides. Add a regression for each new override. AJV does not validate format strings or replace Nest/class-validator constraints.

Read-only hints describe business-state behavior, even where GET issues editor credentials. Mutation hints are conservative; no automatic retries or idempotency promises. Password and API-client secret tools explicitly describe chat-history exposure. Do not log arguments/results. MCP audit document/version identifiers go in metadata rather than relational FKs so a nonexistent requested ID can still be audited.

## Reproducible checks

From the repository root (use `npm.cmd` on Windows):

```bash
npm ci
npm run prisma:generate
npm run build --workspace @policymanager/shared
npm run mcp:catalog
npm run mcp:catalog -- --check
npm test --workspace @policymanager/api -- --runInBand mcp --coverage --collectCoverageFrom="mcp/**/*.ts"
npm run typecheck
npm run lint
npm test -- --runInBand
npm run build
```

The Jest API root is `src`, so the coverage glob starts at `mcp/`, not `src/mcp/`. The catalog script creates Swagger from actual controllers with inert constructor dependencies: it does not connect to a database, start the API or mutate data. It exports [all tool schemas](../api/mcp-tools.json); `--check` fails when committed docs are stale.

Protocol integration tests use a real SDK client, real Nest guards/DTOs/interceptors and inert business services to isolate adapter behavior. They exercise identity isolation, live permission/revocation changes, origin/auth negatives, invalid input, multipart, binary, parser limits and concurrency. A DTO metadata reconciliation test checks that every validated field has Swagger metadata; it found and corrected seven missing evidence-binder options. Dispatch tests use a local HTTP server to exercise no-retry deadlines, redirects, oversized responses and upstream connection cleanup.

Live workflow acceptance is `npm run test:e2e:mcp --workspace @policymanager/api` with disposable PostgreSQL/S3 environment from the [runbook](../runbooks/mcp.md#live-workflow-tests). It uses actual services, login outside tools, Prisma and private storage; it creates isolated fixture users/roles/documents/API clients/import batches and removes only those rows. Source objects remain in disposable storage. It verifies create/upload/checksum/download, review/publish/export, view-before-acknowledge, all six API reads and scope/category/confidential/deleted/draft restrictions, wrong-owner denial, manifest/bulk/folder/ZIP imports, PDF/ZIP export integrity, immutable restore, soft delete and schema placement. No migration is added by this feature.

The dedicated MCP e2e command avoids the legacy global `--experimental-vm-modules` option, which conflicts with Jest's CommonJS transformation of the ESM sanitizer dependency on Node 24. It does not exercise background PDF extraction's dynamic worker import; conversion/OCR/editor/RAG/email providers retain their separate existing tests. CI runs the MCP workflow against pgvector PostgreSQL 16 and MinIO, and verifies the catalog alongside normal checks.
