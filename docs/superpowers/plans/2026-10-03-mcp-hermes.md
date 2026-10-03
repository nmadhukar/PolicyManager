# MCP and Hermes Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan inline, task by task. The user approved the written design and inline execution without additional planning checkpoints on 2026-10-03.

**Goal:** Expose all 107 approved REST operations as authenticated MCP tools, with exhaustive coverage of the nine protocol exclusions and full Hermes documentation.

**Architecture:** A stateless NestJS MCP controller uses the official SDK and a reviewed named route registry. Every tool re-enters the existing guarded REST pipeline through a fixed loopback destination; supplemental audit records retain the actual MCP caller context.

**Tech Stack:** NestJS 10, TypeScript, official MCP SDK v1, AJV JSON schema validation, existing Prisma/PostgreSQL and S3/MinIO.

**Spec:** [Approved design](../specs/2026-10-03-mcp-hermes-design.md).

## Global Constraints

- MCP_ENABLED=false; MCP_ALLOWED_ORIGINS explicit; request/response defaults 16777216 bytes and hard maximum 80 MiB.
- MCP_MAX_CONCURRENT_CALLS=4; MCP_TOOL_TIMEOUT_MS=120000; aggregate decoded files maximum 50 MiB.
- JWT actions and API-client read scopes stay separate. No migrations, source-byte overwrites, unrestricted requests, or automatic mutation retries.
- Preserve REST guards, validation, interceptors, ACL/ownership enforcement, throttling, and existing audit events.
- At least 80 percent changed business-line coverage; record unavailable live verification honestly.

## Review Focus

- A malicious path segment containing slash/dot escapes must never change the selected route.
- An expired or revoked credential must fail on a later call without cached identity reuse.
- Two overlapping calls must never exchange identity, catalog, response, or audit metadata.
- A mutation that finishes before a delivery/timeout failure must return an uncertain outcome rather than be retried.
- A valid 50 MiB upload requires elevated MCP limits without enlarging ordinary REST JSON limits.

## Task 1: Reviewed registry and schemas (PM-MCP-01)

**Files:** `apps/api/src/mcp/mcp.routes.ts`, `mcp.catalog.ts`, `mcp.catalog.spec.ts`.

**Interfaces:** `MCP_ROUTES` and `MCP_EXCLUSIONS` identify exact methods/paths, stable names, audience, permissions/scopes, file mode, and response mode. `createCatalog(document: OpenAPIObject): CatalogTool[]` produces SDK tools plus private dispatch metadata and compiled validators.

- [x] Write tests proving exhaustive route metadata coverage, all 107 names, nine exclusions, body/path/query schemas, local-reference resolution, and credential/annotation selection.
- [x] Run focused Jest; observe missing implementation failure.
- [x] Add the registry and schema normalization with strict object fields and file overrides.
- [x] Run focused tests; observe pass and review generated schemas against controllers/DTOs.

## Task 2: Authenticated transport and dispatch (PM-MCP-02)

**Files:** `mcp.config.ts`, `mcp.guard.ts`, `mcp.controller.ts`, `mcp.service.ts`, `mcp.dispatch.ts`, `mcp.module.ts`, tests beside them; modify API bootstrap/AppModule.

**Interfaces:** guard binds `McpIdentity` to one request. `McpService.configure(document, portProvider)` installs catalog/fixed destination; `handle(request,response)` creates a per-request SDK transport. `dispatchTool(tool,args,identity,limits,signal)` returns bounded SDK content/error and status metadata.

- [x] Write tests for configuration bounds, identity selection/expiry, disabled/origin rejection, SDK handshake/discovery/calls, filtered catalogs, real downstream guards/validation, safe fixed destination and original caller audit.
- [x] Run focused Jest; observe failure.
- [x] Implement stateless transport and loopback dispatch without direct business-service invocation; record only safe audit metadata.
- [x] Exercise concurrent users, malicious path values, redirect responses, no-retry timeout, and live credential checks; run focused Jest and typecheck.

## Task 3: Multipart and binary transport (PM-MCP-03)

**Files:** `mcp.files.ts`, `mcp.results.ts`, focused tests; integrate dispatch and parser limits.

**Interfaces:** file encoding accepts only filename/MIME/base64 objects; response encoding emits structured JSON, empty success, or intact bounded embedded resources. No filesystem/URL input primitive.

- [x] Write tests for version/manifest/bulk file fields, strict canonical base64, aggregate/file limits, empty/JSON/PDF/ZIP responses, and oversized post-mutation outcome.
- [x] Observe RED; implement bounded file/result conversion; observe GREEN.
- [x] Run real Nest interceptor upload and SDK export integrity assertions; confirm the dedicated MCP parser cap does not enlarge ordinary REST routes.

## Task 4: Acceptance, documentation, and review (PM-MCP-04)

**Files:** API MCP e2e tests, CI job, smoke/catalog scripts, env/Compose settings, developer/API/user/admin/runbook guides and indexes, ADR, tickets and inventory.

- [x] Write SDK tests for create/version/read/review/approve/acknowledge/restore workflows and API-client restrictions; observe RED where adapter integration is absent.
- [x] Provision disposable local PostgreSQL/MinIO when possible; run live tests, inspect audit/version/checksum evidence, and never target production data.
- [x] Run root typecheck/lint/tests/build and focused MCP coverage with fresh command evidence.
- [x] Regenerate inventory with final tool names and exclusions; document tested Hermes configuration, operational limits, secrets, examples, uncertain outcomes, and rollback.
- [x] Run documentation link/content checks and repository quality/security review; obtain one fresh independent code review and address important findings with RED/GREEN verification.
- [x] Leave reviewable changes on `feat/mcp-hermes`; do not push, merge, or deploy. Update tickets with exact evidence and remaining external checks.

## Execution ledger

- Approved design and inline execution: user message “go now approved”, 2026-10-03.
- Workspace: original checkout on feature branch `feat/mcp-hermes`; planning files preserved. No further worktree checkpoint because the user approved inline execution in this workspace.
- No commits/push/merge/deployment steps are required for the requested deliverable; retain changes for review.

- Task 1: complete — explicit 107-tool/nine-exclusion contract, exhaustive route/permission and validated-field reconciliation; reviewed query, dictionary and nullable overrides pass.
- Task 2: complete — authenticated isolated SDK transport, fixed loopback dispatch, cancellation/concurrency/audit and no-retry negative tests pass.
- Task 3: complete — all three multipart contracts, exact PDF/ZIP resources, decoded/encoded limits and stream cleanup pass; live checksum/storage/version proofs pass.
- Task 4: complete within documented local boundary — five live workflow tests, built-main two-mode SDK smoke, full API905/web126 regressions, rootlint/typecheck/build, generated catalog and full documentation. Fresh independent review findings addressed with RED/GREEN. See [delivery evidence](../../../.ai/tasks/MCP_INTEGRATION.md) for exact evidence and rollout checks.
- Ruling: retain this plan/ledger without commits or deletion — user approved inline reviewable implementation, not repository publishing — cost: reviewer assesses working-tree changes instead of a commit range.
- Ruling: local native PostgreSQL/S3 emulator with disabled vector provider substitutes for unavailable Docker/MinIO — full unchanged migrations also proven on PGlite with pgvector — cost: native vector/MinIO/proxy/Hermes deployment evidence remains external.
- Final: fixed secret rotation warning/filter mismatch — real catalog/config regression RED→GREEN.
- Final: fixed oversized advertised response cleanup — unfinished upstream connection regression RED→GREEN.
- Final: expanded actual service acceptance — all six public reads, visibility/ownership, multipart imports and ZIP export byte/checksum proof pass.
- Final: required pooled loopback throttle quota documentation checked missing→present; no security bypass.
- Final review: one fresh independent reviewer; no remaining critical/high findings or deferred minors. No second review dispatched.

- Subsequent authorization (2026-10-03): the user requested "merge with main and git push". Commit the verified implementation, integrate it into `main`, and push to `origin`; this supersedes the earlier local-only publishing rulings. Production activation remains outside this repository integration.
