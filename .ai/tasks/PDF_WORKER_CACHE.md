# Ticket: PDF_WORKER_CACHE - Recover previews in existing browser caches

## Goal / Phase
Repair the user's persistent preview error after the approved MIME fix; implementation follow-up.

## Scope / Non-goals
Give the module worker a fresh cache key so old application/octet-stream responses are bypassed after ordinary app reload. No PDF dependency, API, model, migration, permission, audit, source-byte or editor changes.

## Acceptance Criteria / Tests Required
- Real Chrome first caches the pre-fix worker MIME and continues failing after ordinary reload even when the server MIME is corrected.
- The actual deployed viewer's worker URL recovers without clearing browser data.
- The reported document renders; direct/sidebar acceptance and relevant unit/lint/type checks remain green.

## Data Model / API / RBAC / Audit / Storage Impact
None. Existing private presigned URLs and access auditing remain authoritative.

## UI / Documentation Impact
Existing users reload the app to obtain the new worker URL; no cache deletion is required. Update viewer developer docs and deployment runbook.

## Commands To Run
Sibling `node tests/e2e/preview-cache.mjs` and full acceptance, web tests/lint/typecheck, web Docker rebuild/recreate, git diff check.

## Rollback
Revert worker URL change and rebuild web only; keep all volumes and document versions.

## Done Evidence
On 2026-10-04, fresh browser rendering passed but actual Chrome HTTP cache retained the prior immutable bad MIME across reload. Added regression failed RED with the deployed unchanged URL, after proving the old request was served from cache rather than contacting the corrected server. It passed GREEN after the worker query change and web Docker rebuild/force-recreate; the deployed worker loaded under its new cache key without clearing browser data. This is thin viewer configuration, not changed business behavior; real browser coverage applies.

Full sibling end-to-end run exited0: direct preview, cached-response recovery, native default-sandbox sidebar preview, chat/MCP upload/export and5 live API regressions. Web tests126/126, web lint/typecheck and git diff check passed. Plugin tests15/15, lint/typecheck and docs links passed. Deployment health/framing/loopback checks passed and the test model was disabled again. Independent scoped review found no blocking issues. Files changed: viewer worker URL/comment, developer/viewing docs, deployment runbook and this ticket. Existing app tabs must reload to load the new bundle; no cache deletion or storage change is required.
