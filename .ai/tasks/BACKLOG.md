# PolicyManager Backlog

This backlog is phase-ordered. Do not implement a later phase until prior gates are accepted unless the user explicitly approves.

## Phase 0A: Repo Isolation And Framework

Status: in progress.

Tickets:

- PM-0001 - Confirm repo isolation status.
- PM-0002 - Complete vibe coding framework.
- PM-0003 - Create initial project docs skeleton.
- PM-0004 - Create stack ADR skeleton.
- PM-0005 - User approval checkpoint for Phase 0A.

Acceptance gate:

- Framework files exist.
- `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md` point to one source of truth.
- `.ai/agents`, `.ai/skills`, `.ai/commands`, and `.ai/tasks` exist.
- Repo isolation blocker is documented.

## Phase 0B: Technical Scaffold

Status: blocked until Phase 0A approval and repo root isolation.

Tickets:

- PM-0010 - Initialize project-local git root safely.
- PM-0011 - Scaffold monorepo package structure.
- PM-0012 - Scaffold NestJS API.
- PM-0013 - Scaffold React/Vite/Tailwind web app.
- PM-0014 - Add shared TypeScript package.
- PM-0015 - Add Docker Compose with PostgreSQL, MinIO, and MailHog.
- PM-0016 - Add Prisma baseline with `policytracker` schema.
- PM-0017 - Add health checks.
- PM-0018 - Add baseline CI scripts.
- PM-0019 - Verify scaffold.

## Phase 1: Product Contract

Tickets:

- PM-0101 - Finalize PRD.
- PM-0102 - Define domain glossary.
- PM-0103 - Define document lifecycle.
- PM-0104 - Define role matrix.
- PM-0105 - Define permission matrix.
- PM-0106 - Define review workflow.
- PM-0107 - Define attestation evidence.
- PM-0108 - Define public API v1 scope.
- PM-0109 - Define user/admin/developer guides outline.

## Phase 2: Auth And RBAC

Tickets:

- PM-0201 - Add user/role/permission models.
- PM-0202 - Add seed roles and permissions.
- PM-0203 - Add local login.
- PM-0204 - Add JWT access/refresh.
- PM-0205 - Add RBAC guard and decorator.
- PM-0206 - Add admin user-management UI.
- PM-0207 - Add RBAC negative tests.
- PM-0208 - Write auth developer and admin docs.
- PM-0209 - Design OIDC implementation ADR.

## Phase 3: Documents And Versioning

Tickets:

- PM-0301 - Add category/document/version models.
- PM-0302 - Add upload service with checksum.
- PM-0303 - Add S3/MinIO storage abstraction.
- PM-0304 - Add presigned download after authorization.
- PM-0305 - Add document library UI.
- PM-0306 - Add document detail and version history UI.
- PM-0307 - Add text extraction.
- PM-0308 - Write document/version developer docs and user guide.
- PM-0309 - Add PDF rendition generation (Gotenberg) on upload for uniform viewing and cover-page prepend.
- PM-0310 - Add in-browser document viewer (pdf.js/react-pdf) using the PDF rendition; view-only users never receive an editor.
- PM-0311 - Add OnlyOffice edit-in-browser for docx/xlsx/pptx; save-back callback creates a new immutable `DocumentVersion`; gated by `document.write`.
- PM-0312 - Add TipTap native editor for in-app-authored documents; save creates a new immutable version.
- PM-0313 - Add Storage Admin UI (create/list buckets and prefixes/folders) behind `storage.manage`; no destructive object/bucket ops in v1.
- PM-0314 - Add Gotenberg + OnlyOffice services to Docker Compose and env config.
- PM-0315 - Add quick tags and classification: inline tag add/remove on documents, classification via category tree, and filter/search by tag + category in the library UI.
- PM-0316 - Require a title on every document. Add library search + filters: free-text search by title/name, and filters by classification/category, owner, tag, status, and last-review / next-review date range. Server-side paginated + sortable list endpoint; debounced search UI with clear/active-filter chips.

## Phase 4: Access Control And Audit

Tickets:

- PM-0401 - Add document/category ACL model.
- PM-0402 - Add access-level enforcement.
- PM-0403 - Add audit event model.
- PM-0404 - Audit document view/download/upload/update.
- PM-0405 - Add audit report UI.
- PM-0406 - Add RBAC/access matrix tests.
- PM-0407 - Write audit and access-control docs.

## Phase 5: QC Review And Email

Tickets:

- PM-0501 - Add review schedule model.
- PM-0502 - Add review task model.
- PM-0503 - Add due review cron.
- PM-0504 - Add reminder email abstraction.
- PM-0505 - Add review dashboard.
- PM-0506 - Add overdue tracking.
- PM-0507 - Add review workflow tests.
- PM-0508 - Write review/admin/user docs.
- PM-0509 - Add SMTP Admin UI (configure host/port/credentials/from, send test email, toggle reminder categories, view `NotificationLog`) behind `smtp.manage`; secrets referenced from env, never shown in plaintext.

## Phase 6: Attestation And Cover Page

Tickets:

- PM-0601 - Add attestation model.
- PM-0602 - Add review/approve/acknowledge actions.
- PM-0603 - Add attestation UI.
- PM-0604 - Add cover page generation.
- PM-0605 - Add export with cover page.
- PM-0606 - Add attestation and export tests.
- PM-0607 - Write survey evidence and user docs.
- PM-0608 - Add staff read-and-acknowledge distribution: `AcknowledgmentAssignment` model, assign published version to users/roles with due date, completion tracking, and auto re-trigger on new published version.
- PM-0609 - Add acknowledgment dashboard (completion %, overdue) and acknowledgment tests.

## Phase 7: Public API

Tickets:

- PM-0701 - Add API client model.
- PM-0702 - Add API key hashing and scopes.
- PM-0703 - Add read-only `/api/v1/documents`.
- PM-0704 - Add extracted text endpoint.
- PM-0705 - Add keyword search endpoint.
- PM-0706 - Add Swagger/OpenAPI docs.
- PM-0707 - Add API scope tests.
- PM-0708 - Write integration API developer guide.

## Phase 8: Import And Consolidation

Tickets:

- PM-0801 - Add CSV manifest parser.
- PM-0802 - Add bulk upload.
- PM-0803 - Add duplicate detection.
- PM-0804 - Add import report UI.
- PM-0805 - Add import tests.
- PM-0806 - Write import user/admin docs.

## Phase 9: Hardening And Release

Tickets:

- PM-0901 - Full e2e regression.
- PM-0902 - Security review.
- PM-0903 - Accessibility pass.
- PM-0904 - Backup/restore runbook.
- PM-0905 - Coolify deployment guide.
- PM-0906 - Release checklist.
- PM-0907 - Final documentation review.
