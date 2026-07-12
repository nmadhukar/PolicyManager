# PolicyManager — Design + Vibe Coding Framework

> **Two-part plan.** Part 1 is *what we're building* (the product). Part 2 is *how we'll build it* — a disciplined, tool-agnostic AI-development framework (global rules, agents, skills, commands, tasks, TDD) so the project can be delivered phase-by-phase by Claude, Codex, or Gemini with consistent quality.

---

# PART 1 — Product Design

## Context

The clinic's controlled documents — **policies & procedures, job descriptions, and IOP/PHP curriculums** — are scattered across file shares, SharePoint, personal drives, and email. No single source of truth, no version control, no proof of who reviewed/approved a policy or when it's next due — the exact evidence **CARF and Joint Commission** surveyors demand.

We are building **PolicyManager**, a purpose-built **Document Management System (DMS)**: a single, versioned, access-controlled, **S3-backed** repository with a built-in **QC review workflow** (quarterly/annual scheduling + sign-off), a **compliance cover page** on every document, and a clean **REST API** so an EMR or AI chatbot can query/ingest the policies.

**Greenfield.** `PolicyManager` is empty and not yet its own git repo (currently absorbed into the home-folder `nmadhukar/MongoDB` repo) — **`git init` inside `PolicyManager` is action #1.**

### Decisions locked with the user
- **Frontend:** React + Tailwind (Vite).
- **DB:** PostgreSQL — the app owns a **dedicated schema `policytracker`** (never `public`), matching your `census` / `taskmanagement` convention.
- **Auth:** Standalone RBAC core **+ pluggable OpenID Connect / SSO federation** (local login *and* "Sign in with <IdP>").
- **S3:** Env-driven and **self-provisioning** — bucket, region, prefixes, credentials from env; app creates bucket + prefixes on boot if missing. **Plus an admin UI** to create/manage buckets & folders.
- **Email:** **SMTP integration with an admin UI** to configure the server and send review-reminder emails.
- **AI:** Clean REST API in v1, but data model is **RAG-ready** (text extraction + search endpoint) for later embeddings.
- **Sign-off:** Internal **e-attestation** (name + role + timestamp + IP in an immutable audit trail) — sufficient for CARF/JC internal P&P evidence.

## Recommended Architecture

| Layer | Choice | Why |
|---|---|---|
| Backend | **NestJS + Prisma + PostgreSQL (dedicated `policytracker` schema)** | Matches existing EMR stack; all tables namespaced in `policytracker`, never `public` |
| Object storage | **AWS S3** — versioning ON, SSE-KMS, public access blocked, **env-driven + self-provisioning + admin UI** | Presigned URLs only; bucket/prefixes auto-created; folders manageable from UI |
| Frontend | **React + Vite + Tailwind + TanStack Query + React Router** | Per decision |
| Auth | **JWT (access+refresh) + Argon2 local login + openid-client OIDC/SSO** | Standalone RBAC, federatable |
| Email | **Nodemailer SMTP**, config stored in DB + admin UI, secrets in env | Reminders + notifications |
| Jobs | **@nestjs/schedule** cron (daily review sweep) | No extra infra to start |
| Text extraction | **pdf-parse / mammoth** on upload → `extractedText` | API + search now, RAG later |
| Doc → PDF rendition | **Gotenberg (LibreOffice, Docker)** converts docx/xlsx/pptx → PDF on upload | Uniform in-browser viewing + cover-page prepend regardless of source format |
| In-browser **viewers** | **pdf.js / react-pdf** (PDF rendition), native (images) | View without downloading; original stays source of truth |
| In-browser **editing** | **OnlyOffice Docs** (self-hosted, Docker) for docx/xlsx/pptx edit-in-place; **TipTap** for in-app-authored docs | True Office editing in the browser; **every save-back = new immutable version** |
| Local dev storage | **MinIO** (S3-compatible) via docker-compose | Test S3 without AWS |
| Local dev email | **MailHog** | Catch reminder emails locally |
| Deploy | **Docker + Coolify** | Existing fleet pattern |

**Monorepo layout:**
```
PolicyManager/
  apps/api/            # NestJS
  apps/web/            # React + Vite
  packages/shared/     # shared TS DTOs/types
  prisma/              # schema + migrations
  docker-compose.yml   # postgres + minio + mailhog + gotenberg + onlyoffice (local dev)
  .ai/                 # the Vibe Coding Framework (Part 2)
  AGENTS.md            # canonical global rules (Part 2)
```

## Database: dedicated `policytracker` schema

All tables live in a **`policytracker`** Postgres schema, isolated from `public` (mirrors `census`/`taskmanagement`). Prisma is configured with `schemas = ["policytracker"]` (multiSchema preview) and `@@schema("policytracker")` on every model; the datasource `search_path` points at it. The connection URL is env-driven (`DATABASE_URL` with `?schema=policytracker`). If the app ever shares a Postgres instance with another system: use a **dedicated role** scoped to this schema, and keep `CREATE SCHEMA policytracker` in the *initial* migration (drop it only when deploying onto a pre-provisioned shared DB, per your shared-DB migration lesson).

## Codex addendum: execution guardrails

These guardrails tighten the plan and should be treated as controlling rules if an AI agent tries to move too fast.

1. **Phase 0 is two-step, not one large jump.** First isolate the repo and commit the AI framework/docs (`AGENTS.md`, `.ai/`, task templates, ADR skeletons). Only after that is approved should the NestJS/React scaffold be generated.
2. **Build models by phase, not all at once.** The Prisma model list below is the target shape, but migrations should be introduced in vertical slices: auth/RBAC first, then documents/versioning, then audit/access, then review/attestation/API.
3. **Schema verification is mandatory.** Every migration task must run a live database check proving app objects exist under `policytracker` and not `public`.
4. **S3 self-provisioning must be environment-gated.** Local MinIO can auto-create buckets/prefixes. Production AWS bucket/KMS/public-access changes require explicit env flags, least-privilege credentials, and review.
5. **Storage Admin UI must avoid dangerous defaults.** Bucket/folder creation is fine behind `storage.manage`; destructive bucket/object operations should be absent in v1 unless a separate approved task adds them with strong confirmation and audit.
6. **Cover-page access summaries are opt-in.** Approval chain, version, next review date, and revision history are core. Recent-access summaries can expose internal access patterns and should be configurable, not default.
7. **No code without task boundaries.** Each generated ticket needs acceptance criteria, tests required, commands to run, rollback notes, and Definition of Done evidence.

## Core Design: Document + Version model

**Logical document ≠ file bytes.**
- **`Document`** = stable logical entity (e.g. "Seclusion & Restraint Policy", #PP-042), with one *current* published version.
- **`DocumentVersion`** = **immutable** snapshot. Every upload = new version row + new S3 object (never overwrite). Key: `{S3_PREFIX_DOCUMENTS}{documentId}/v{n}/{filename}`; store S3 `versionId` as backstop.

### Prisma models (summary)
- `User`, `Role`, `Permission`, `UserRole` — RBAC. Seed roles: **Admin, Compliance Officer, Manager/Owner, Staff, Auditor (read-only)**; granular permissions (`document.read/write/approve`, `review.manage`, `user.manage`, `storage.manage`, `smtp.manage`, `api.manage`).
- `UserIdentity` — `userId, provider (local|azure|google|okta|cognito…), subject, email, linkedAt` — OIDC/SSO federation + account linking.
- `DocumentCategory` — hierarchical (`parentId`) folders: *Policies & Procedures, Job Descriptions, IOP Curriculum, PHP Curriculum, Forms…*
- `Document` — `title, documentNumber, categoryId, ownerId, description, tags[], status (draft→in_review→approved→published→archived/retired), accessLevel (public/restricted/confidential), currentVersionId, reviewCadence (none/quarterly/annual/custom), nextReviewDate, effectiveDate`.
- `DocumentVersion` — `documentId, versionNumber, s3Key, s3VersionId, fileName, mimeType, sizeBytes, checksum(sha256), uploadedById, changeSummary, status, extractedText, renditionS3Key (PDF for viewing), createdAt`.
- `AcknowledgmentAssignment` — `documentId, versionId, assigneeId(user|role), assignedById, dueDate, status (pending/completed/overdue), completedAt` — staff read-and-acknowledge distribution (attestation recorded in `Attestation` with action=acknowledged).
- `DocumentAcl` — `(documentId|categoryId), principalType (role|user), principalId, permission (view/download/edit/approve)`.
- `ReviewSchedule` — `documentId, cadence, nextDueDate, leadTimeDays, assignedReviewerIds[], gracePeriodDays`.
- `ReviewTask` — `documentId, versionId, dueDate, assignedToId, status (pending/in_progress/completed/overdue), completedAt`.
- `Attestation` (sign-off) — `documentId, versionId, reviewTaskId, userId, action (reviewed/approved/acknowledged), signatureName, role, signedAt, ipAddress, userAgent, comments`. **Compliance evidence.**
- `AuditEvent` — `userId|apiClientId, documentId, versionId, action, source (web|api), timestamp, ipAddress, userAgent`.
- `ApiClient` — `name, clientId, secretHash, scopes[], allowedCategoryIds[]` for machine access (EMR/AI).
- `StorageConfig` — managed buckets/prefixes registered/created via UI (`name, bucket, region, endpoint, prefixes, isDefault`).
- `SmtpConfig` — `host, port, secure, username, secretRef, fromAddress, fromName, enabled` (secret in env/secret store, not plaintext DB).
- `NotificationLog` — sent reminders (`toUserId, reviewTaskId, sentAt, status, error`).

## Feature modules (NestJS + React)

1. **Auth, SSO & Users** — see Authentication section. Local login + OIDC/SSO, unified RBAC, user-management UI, optional TOTP MFA for Admin/Compliance.
2. **Documents** — CRUD, category tree, upload → new `DocumentVersion`, download via **short-lived presigned URL**, version history, restore/supersede, retire. Text extraction on upload.
2a. **Formats, Viewing & Editing** — supported types: **PDF, DOCX/DOC, XLSX/XLS, PPTX/PPT, images, TXT/MD**. On upload, generate a **PDF rendition** (Gotenberg) for uniform in-browser **viewing** (pdf.js) and cover-page prepend. **Editing in the browser** via self-hosted **OnlyOffice Docs** for Word/Excel/PowerPoint (full formulas/multi-sheet for spreadsheets), and **TipTap** for docs authored natively in the app. **Every save-back or edit creates a new immutable `DocumentVersion`** (original untouched, full history preserved) — so versioning, audit, and attestation integrity always hold. Edit access gated by RBAC/ACL (`document.write`); view-only users get the rendition, never an editor.
3. **Access Control** — role defaults + per-document/category ACL + 3 access levels, enforced at **API, UI, and presigned-URL issuance**; every access writes an `AuditEvent`.
4. **QC / Review** — cadence + reviewers per doc; **daily cron** finds due docs, creates `ReviewTask`s, emails reviewers; reviewer completes → attests → optional new version → `nextReviewDate` auto-advances. **Calendar + list dashboard**, overdue tracking, **compliance report** (% current, overdue count).
5. **Sign-off / Attestation** — two attestation flows, both immutable:
   - **Reviewer/approver sign-off** — one-click "I reviewed / I approve" (part of the QC cycle) capturing name+role+timestamp+IP.
   - **Staff read-and-acknowledge (distribution)** — assign a published policy version to specific users/roles with a due date; staff **view the document then attest "I have read and understand"**. Tracks per-version acknowledgment (who/when), completion %, and overdue — the core evidence surveyors want for policy distribution & staff training. Re-triggers automatically when a new version is published.
6. **Cover Page** — generated **on demand** with **pdf-lib** from live metadata: title, doc #, version, effective date, owner, **approval chain**, **next review date**, **revision history table**, distribution, recent-access. UI panel + prepended page on export.
7. **Storage Admin UI** — manage S3: list configured buckets, **create a bucket** (+ enable versioning/SSE/block-public), **create/browse folders (prefixes)**, set the default bucket/prefixes. Backed by `StorageConfig` + `S3Service`. All destructive ops gated by `storage.manage`.
8. **Email/SMTP Admin UI** — configure SMTP host/port/credentials/from, **send a test email**, toggle reminder categories, view `NotificationLog`. Backed by `SmtpConfig`. Gated by `smtp.manage`; secrets referenced from env, never shown in plaintext.
9. **Public API (`/api/v1`)** — API-key (client-credentials) auth, scoped, read-only: `GET /documents`, `/documents/:id`, `/documents/:id/content` (extractedText for AI), `/documents/:id/download` (presigned), `/documents/:id/versions`, `/search?q=` (keyword now; semantic later, same contract). Every hit audited; OpenAPI/Swagger published.
10. **Ingestion/Consolidation** — bulk multi-file upload + **CSV manifest importer** (`filepath,title,category,documentNumber,owner,cadence`) to onboard scattered docs. (SharePoint pull via M365 MCP possible later.)

## S3: env-driven, self-provisioning + UI-managed

`S3Service` (`apps/api/src/storage/`) reads **everything from env** so one image serves MinIO (local) and AWS (prod):
```
S3_ENDPOINT=                 # blank for AWS; http://minio:9000 local
S3_REGION=us-east-2
S3_BUCKET=policymanager-docs
S3_ACCESS_KEY_ID=… / S3_SECRET_ACCESS_KEY=…
S3_FORCE_PATH_STYLE=true     # true for MinIO
S3_PREFIX_DOCUMENTS=documents/   S3_PREFIX_COVERPAGES=coverpages/   S3_PREFIX_IMPORTS=imports/
S3_SSE=aws:kms   S3_KMS_KEY_ID=…
S3_AUTO_CREATE=true          # create bucket + versioning + block-public if missing
```
On `onModuleInit`: if `S3_AUTO_CREATE`, `HeadBucket` → `CreateBucket` if absent, enable **versioning**, apply **block-public-access** + SSE. "Folders" = consistent env prefixes (optional zero-byte markers). The **Storage Admin UI** exposes create-bucket / create-folder / set-default on top of this same service.

## Authentication: standalone RBAC + pluggable OIDC/SSO

RBAC (Postgres roles/permissions) is the **single authorization core**, independent of *how* a user authenticates. Two env-toggleable paths:
- **Local** — email + Argon2, JWT access+refresh, reset, optional TOTP MFA.
- **OIDC/SSO** — **openid-client + Passport** (generic OIDC → Azure/Entra, Google, Okta, Auth0, Cognito), Auth-Code + PKCE, multiple providers at once.

Behaviors: **JIT provisioning** (first SSO login creates `User` + `UserIdentity`), **group→role mapping** via config (`OIDC_GROUP_MAP`), **account linking** by verified email, **uniform tokens** (app issues its own JWT; guards/RBAC/audit are source-agnostic). Cognito federation later is "just another provider block."

## Security & compliance guardrails
- Private bucket, **block all public access**, **SSE-KMS**, TLS, **presigned URLs, short TTL** only.
- **Immutable versions** (new version = new row + new object); optional **S3 Object Lock** for retention.
- **Full audit trail** on every view/download/change/API call; exportable.
- RBAC enforced server-side on every route; UI hides but never trusts. SMTP/S3 secrets from env/secret store, never plaintext DB.

---

# PART 2 — The Vibe Coding Framework

**Goal:** make PolicyManager buildable by *any* capable AI coding agent (Claude Code, Codex, Gemini) in disciplined, verifiable phases — where each unit of work is small, test-first, and has an explicit Definition of Done. The framework is committed to the repo so context travels with the code, not the chat.

## Framework repo layout
```
AGENTS.md                 # canonical global rules — the "constitution"
CLAUDE.md -> AGENTS.md    # Claude Code reads this (symlink/include)
GEMINI.md -> AGENTS.md    # Gemini reads this
.ai/
  rules/                  # granular rule files (security, tdd, style, prisma, git)
  agents/                 # specialized agent definitions (role + tools + prompt)
  skills/                 # reusable step-by-step procedures
  commands/               # slash-command specs (/build-ticket, /tdd, /review …)
  tasks/                  # the phased backlog: epics → tickets w/ acceptance criteria
  templates/              # PR, ticket, ADR, test templates
  decisions/              # ADRs (architecture decision records)
```
`AGENTS.md` is canonical; Claude/Gemini variants **include** it so a single source of truth serves all three tools. Codex reads `AGENTS.md` natively.

## 1. Global rules (`AGENTS.md` — the constitution)
Non-negotiables every agent must obey:
- **Stack fences:** NestJS + Prisma + Postgres (api), React + Vite + Tailwind (web); no adding frameworks without an ADR. **All DB objects live in the `policytracker` schema — never `public`.**
- **TDD mandate:** no production code without a failing test first (red→green→refactor). Coverage gate ≥ 80% on changed lines.
- **Security/compliance:** never expose the S3 bucket; presigned URLs only; every doc access audited; no secrets in code or DB plaintext; immutable versions.
- **Definition of Done** (below) must pass before a ticket is "complete."
- **Small diffs:** one ticket = one focused PR; no drive-by refactors.
- **Conventional Commits** + branch naming `phase-N/<ticket-id>-slug`.
- **Ask, don't assume:** if acceptance criteria are ambiguous, stop and ask (or write an ADR).
- **No PHI in this system** (policies, not patient data) — but treat it as a compliance-audited app.

## 2. Agent roster (`.ai/agents/`)
Specialized roles, each with scoped tools + a focused system prompt:
- **architect** — turns epics into tickets + ADRs; owns schema/API contracts. (read-only + docs)
- **backend-dev** — implements NestJS modules/services TDD-first.
- **frontend-dev** — implements React features + Tailwind UI, component tests.
- **test-engineer** — writes/expands unit, integration, e2e tests; guards coverage.
- **db-migration** — Prisma schema + migrations, seed data; verifies against a live DB before trusting migration files.
- **security-reviewer** — audits each PR against the security rules + RBAC/audit coverage.
- **code-reviewer** — correctness/simplicity/reuse review before merge.
- **code-quality-reviewer** — maintainability, readability, boundaries, comments, and developer ergonomics review.
- **backend-quality-reviewer** — NestJS/Prisma/API/query/transaction quality review.
- **frontend-quality-reviewer** — React workflow, state, accessibility, and responsive UI review.
- **performance-reviewer** — pagination, indexing, query volume, payload size, and batch processing review.
- **documentation-maintainer** — developer docs, user guides, admin guides, runbooks, API docs, and code-comment standards.

## 3. Skills library (`.ai/skills/`)
Reusable, parameterized procedures agents invoke so patterns stay identical repo-wide:
- `scaffold-nest-module` — controller/service/module/DTO/test skeleton.
- `add-prisma-model` — model + migration + repository + factory + tests.
- `s3-service-pattern` — env-driven client, bootstrap, presigned URL, audit hook.
- `oidc-provider` — wire a new OIDC/SSO provider + group→role map + JIT test.
- `rbac-guard` — add `@RequirePermission`, seed permission, negative-path test.
- `smtp-notification` — Nodemailer send + `NotificationLog` + MailHog test.
- `cover-page` — pdf-lib generation from metadata.
- `write-e2e-test` — supertest flow against docker-compose stack.
- `documentation-update` — keep developer docs, user guides, admin docs, runbooks, API docs, and code comments current.
- `code-quality-review` — review maintainability, readability, testability, performance risk, and extension points.
- `document-rendition-viewer` — Gotenberg PDF rendition + pdf.js viewer; source bytes never mutated.
- `onlyoffice-edit` — edit docx/xlsx/pptx in-browser; save-back creates a new immutable version.
- `acknowledgment-distribution` — assign staff read-and-acknowledge, track completion, re-trigger on new version.
- `verify-phase` — run the phase's acceptance checks end-to-end.

## 4. Commands (`.ai/commands/`)
Slash commands that orchestrate the above:
- `/plan-phase N` — architect expands Phase N epics into tickets with acceptance criteria.
- `/build-ticket <id>` — pick a ticket, run the **TDD loop**, open a PR when DoD passes.
- `/tdd <target>` — red→green→refactor micro-loop for one unit.
- `/review <pr>` — code-reviewer + security-reviewer pass.
- `/quality-check` — code quality, backend/frontend quality, and performance review.
- `/docs-check` — documentation and code-comment completeness review.
- `/migrate` — db-migration skill against docker Postgres, verify live schema.
- `/verify-phase N` — run `verify-phase` skill; block sign-off on failure.
- `/adr <title>` — capture a decision.

## 5. Task system (`.ai/tasks/`)
Backlog structured as **Epics → Tickets**. Each ticket is a markdown file:
```
id, title, phase, epic, depends_on[]
Goal:              (one paragraph — the "why")
Acceptance criteria: (checklist, testable)
Files to touch:     (paths)
Tests required:     (unit/integration/e2e list)
Definition of Done: (inherits global DoD + ticket specifics)
Assigned agent:     backend-dev | frontend-dev | …
```
Tickets are sized to ~½–1 day of agent work and are independently verifiable.

## 6. TDD workflow (the core loop)
Every ticket follows **red → green → refactor**:
1. **Red** — test-engineer/dev writes the failing test that encodes an acceptance criterion.
2. **Green** — minimal code to pass.
3. **Refactor** — clean up under green; code-reviewer skill.
**Test pyramid:** many unit (services/guards/pdf/S3-key logic) → integration (controllers + Prisma against docker Postgres) → few e2e (full flows: upload→version→download, review→attest→cover page, SSO login, API-key fetch). CI runs all on every PR; coverage gate enforced.

## 7. Definition of Done (quality gate)
A ticket/PR is done only when: tests written first & passing • lint + typecheck clean • coverage ≥ 80% changed lines • RBAC + audit covered for any new data access • no secret/bucket exposure • Swagger updated if API changed • migration reversible & verified against live schema • `/verify-phase` acceptance checks green • Conventional-Commit PR with linked ticket.

## 8. CI/CD
GitHub Actions: install → lint → typecheck → unit+integration (Postgres+MinIO+MailHog service containers) → e2e → coverage gate → build Docker images. Branch protection requires green CI + one review pass. Coolify deploys from the release branch (mirrors your existing fleet flow).

## 9. Multi-tool portability
`AGENTS.md` is the single source; `CLAUDE.md`/`GEMINI.md` include it. Skills/commands are written as plain-markdown procedures so Codex/Gemini can execute them even without Claude's native skill runner. This lets you switch or parallelize across Claude, Codex, and Gemini without re-teaching the project.

---

# Phased Delivery Roadmap
Each phase = an epic broken into tickets by `/plan-phase`; each phase ends with `/verify-phase`.
- **Phase 0 — Foundations:** `git init`; monorepo scaffold (NestJS + Prisma + React); docker-compose (Postgres + MinIO + MailHog); CI; **commit the Vibe Coding Framework (`AGENTS.md`, `.ai/`)**.
- **Phase 1 — Auth & RBAC:** users, roles, permissions, guards, local login, seed roles, user-management UI; **OIDC/SSO** (openid-client + JIT + group→role) here or early Phase 2.
- **Phase 2 — Documents & Versioning + Viewers/Editors + Storage UI:** env-driven self-provisioning `S3Service`, **Storage Admin UI (create bucket/folder)**, categories, upload/download, immutable versions, history UI, text extraction, **Gotenberg PDF renditions + pdf.js viewer + OnlyOffice edit-in-browser (docx/xlsx/pptx, save-back = new version) + TipTap native editor**.
- **Phase 3 — Access Control & Audit:** ACLs, access levels, `AuditEvent` on every access.
- **Phase 4 — QC/Review + Email:** schedules, tasks, daily cron; **SMTP Admin UI + reminders + `NotificationLog`**; calendar/list dashboard; compliance report.
- **Phase 5 — Sign-off, Acknowledgment & Cover Page:** reviewer e-attestation + approval chain; **staff read-and-acknowledge distribution** (assignments, completion tracking, re-trigger on new version); pdf-lib cover generation.
- **Phase 6 — Public API:** API clients/keys, `/api/v1`, Swagger, `/search` (keyword).
- **Phase 7 (deferred) — RAG:** pgvector + embeddings behind the existing `/search` contract.

# Verification (end-to-end, per the framework)
Run `docker-compose up` (Postgres + MinIO + MailHog), `prisma migrate dev` + seed, start api + web, then walk the compliance loop — this is also the `verify-phase` script content:
1. **Auth/RBAC + SSO:** local Admin login; create Staff + Auditor; Auditor edit → 403; Staff can't see a *confidential* doc. With `OIDC_ENABLED=true` (mock OIDC container), "Sign in with <IdP>" JIT-creates user + `UserIdentity` + mapped role.
2. **Storage UI + versioning:** start empty MinIO; from the **Storage UI create a bucket + folder** (and confirm `S3_AUTO_CREATE` boot path); upload a PDF → v1 under the prefix + `DocumentVersion`; upload revision → v2, v1 preserved.
2a. **View + edit:** upload a `.docx` and a `.xlsx` → PDF renditions generated + viewable in pdf.js; open in **OnlyOffice**, edit, save → a **new immutable version** is created (original preserved); a view-only Staff user gets the rendition, no editor.
2b. **Acknowledge:** assign the published version to a Staff user → they view + click "I have read and understand" → `Attestation(action=acknowledged)` recorded, assignment marked complete; publishing a new version re-opens the acknowledgment.
3. **Access + audit:** download as Staff → presigned URL works + `AuditEvent` written; bucket not publicly reachable.
4. **Review + email:** cadence=quarterly with a past due date; run cron → `ReviewTask` created + **reminder email caught in MailHog** + `NotificationLog` row; send a **test email from the SMTP UI**.
5. **Sign-off + cover page:** complete review → `Attestation` recorded; export → cover page shows approval chain + next review date + revision history.
6. **Public API:** create API client; `GET /api/v1/documents/:id/content` returns extracted text with a valid key, 401 without; call audited.

Automated tests (CI): unit (DocumentsService version increment, S3 key/presign, RBAC guard, cron due-logic, SMTP send, cover-page), integration (controllers + Prisma), e2e (upload→version→download, review→attest→cover, SSO login, API-key fetch). Coverage gate ≥ 80% changed lines.
