# Ticket: PDF_WORKER_MIME - Fix nginx PDF preview worker MIME

## Goal / Phase
Repair the user-reported deployed document preview; implementation bugfix in the approved MCP/demo delivery.

## Scope / Non-goals
Serve the bundled `.mjs` PDF worker as JavaScript in the web nginx image. Preserve standard MIME mappings. No application behavior, dependencies, migrations, API, RBAC or source-byte changes.

## Acceptance Criteria
- Real Chrome preview test fails before the fix on the reported document.
- nginx config passes validation and serves the worker with application/javascript; existing JS/CSS/image types still work.
- Chrome renders the PDF directly and inside the native DSH sidebar using the default sandbox.

## Data Model / API / UI / RBAC / Audit / Storage Impact
No data-model or API change. UI preview resumes rendering. Existing permission enforcement, view-ticket audit, short-lived private presigned URLs and immutable source versions are unchanged. No changed business-behavior lines; coverage gate is not applicable to this deployment-only fix.

## Documentation Impact
Update viewing/storage developer guidance and deployment runbook with `.mjs` MIME requirements and hard refresh troubleshooting. Existing user viewing workflow is unchanged.

## Tests Required / Commands
Real browser canvas RED/GREEN and sidebar preview regression in sibling PolicyManager-DeepSeek tests/e2e/preview.mjs, browser.mjs and sidebar.mjs. Validate original nginx configuration against the current web image; web unit suite, lint and typecheck. `git diff --check`.

## Rollback Plan
Revert nginx configuration and rebuild the web image only. Preserve application data and volumes.

## Done Evidence
Files changed: apps/web/nginx.conf, developer viewing/storage guide, deployment runbook and this ticket.

On 2026-10-04, the reported URL /library/6b38abf9-aa0e-4c89-b0bd-52c89aef10bb reproduced a200 view ticket followed by a200 application/octet-stream worker rejected by Chrome. The real browser canvas regression failed before config changes and passed after web redeployment; worker now returns application/javascript and rendition200 application/pdf. Existing document and source bytes were not modified.

Original nginx configuration passed `nginx -t` in a disposable container. Real responses verified JavaScript, CSS and module-worker MIME mappings. Sibling full acceptance passed direct chat-uploaded document preview and default-sandbox native sidebar preview. Web unit suite126/126, web lint/typecheck and git diff check passed. An independent scoped review found no blocking findings. No migration or business-behavior coverage change.

Risk/follow-up: already-open browsers may retain the cached bad worker response; hard refresh before reopening View. No further fix is required within this ticket.
