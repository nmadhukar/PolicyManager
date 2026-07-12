# PolicyManager Agent Constitution

This file is the canonical operating contract for Claude, Codex, Gemini, and any specialized agents working on PolicyManager. If another instruction conflicts with this file, stop and ask the user unless the newer user message explicitly overrides it.

Primary plan:

- Read `PLAN.md` before starting non-trivial work.
- Treat `PLAN.md` as the product and delivery contract.
- Treat this file as the execution contract.

## 1. Current Project Guardrail

PolicyManager is a greenfield project. The repository isolation gate is not complete until this command resolves to the PolicyManager directory:

```bash
git rev-parse --show-toplevel
```

Expected final value:

```text
C:/Users/MadhukarNarahari/Documents/GitHub/PolicyManager
```

If it resolves to a parent folder, do not scaffold application code. Framework/docs work is allowed if explicitly requested.

## 2. Hard Stack Decisions

Do not change these without an ADR and user approval.

- Frontend: React, Vite, TypeScript, Tailwind CSS.
- Backend: NestJS, TypeScript.
- ORM: Prisma.
- Database: PostgreSQL.
- Application PostgreSQL schema: `policytracker`.
- Local object storage: MinIO.
- Production object storage: AWS S3 or S3-compatible equivalent.
- Auth: local login plus pluggable OIDC/SSO, with internal RBAC as the authorization core.
- API v1: read-only public integration API for EMR/AI clients.
- Deployment target: Docker and Coolify-compatible artifacts.

## 3. PostgreSQL Schema Rule

All PolicyManager application objects must live in the PostgreSQL schema `policytracker`.

Rules:

- No PolicyManager business tables in `public`.
- No PolicyManager enums in `public`.
- No PolicyManager views, functions, triggers, or app-owned indexes in `public`.
- PostgreSQL extensions may use `public` only if documented in an ADR.
- Every migration task must prove schema placement against a live database.

Required verification query:

```sql
select table_schema, table_name
from information_schema.tables
where table_schema in ('public', 'policytracker')
order by table_schema, table_name;
```

Reject any migration that creates PolicyManager app objects in `public`.

## 4. Work Modes

### Planning Mode

Allowed:

- Inspect files.
- Create or update docs/framework artifacts if requested.
- Break work into phases and tickets.

Not allowed:

- App scaffolding.
- Feature code.
- Database migrations.

### Scaffold Mode

Allowed only after Phase 0 framework approval:

- Create monorepo structure.
- Add empty API/web apps.
- Add local Docker Compose.
- Add health checks.
- Add baseline CI and test commands.

Not allowed:

- Business features beyond health checks.
- Full Prisma model dump.

### Implementation Mode

Allowed only from an approved ticket:

- Write failing tests.
- Implement the minimum behavior.
- Run verification.
- Update docs.

### Review Mode

Use code-review posture:

- Findings first.
- File and line references when available.
- Prioritize bugs, regressions, missing tests, and security gaps.

## 5. Phase Gates

Phase 0 is two-step:

1. Repo isolation plus framework/docs.
2. App scaffold after user approval.

Phase 0 may not silently combine framework creation and Nest/React app generation.

Every phase ends with:

- Scope review.
- Tests or verification results.
- Known risks.
- Explicit next-phase approval.

## 6. TDD Mandate

Business behavior requires TDD.

Required loop:

1. Write failing test from an acceptance criterion.
2. Run the focused test and observe failure.
3. Implement the smallest change.
4. Run the focused test and observe pass.
5. Add negative tests for permissions, invalid states, or invalid inputs.
6. Run relevant regression tests.

Coverage gate: changed lines in business behavior must reach at least 80 percent test coverage. If a change is legitimately hard to cover (e.g. thin glue), state why in the ticket rather than silently skipping.

Do not claim done without command evidence.

## 7. Definition Of Done

A ticket is complete only when all relevant items are true:

- Scope stayed inside the approved ticket.
- Tests were written first for business behavior.
- Unit/integration/e2e tests pass as appropriate.
- Changed business-behavior lines reach at least 80 percent coverage, or a documented exception is recorded.
- Lint and typecheck pass.
- RBAC is enforced server-side.
- Audit events are written for document access and state changes.
- Swagger/OpenAPI is updated when API changes.
- Migrations are reviewed and verified in `policytracker`.
- S3 access is private and uses presigned URLs only after authorization.
- Docs are updated.
- Developer documentation and user guides are updated when behavior changes.
- Non-obvious code includes useful comments explaining contracts, invariants, or operational risks.
- Final response lists files changed, commands run, risks, and follow-ups.

## 8. Security Rules

- UI hiding is never security.
- Every protected API route needs server-side auth and permission checks.
- Unauthorized means `401`.
- Authenticated but forbidden means `403`.
- API client secrets must be hashed.
- Passwords must be hashed with Argon2.
- Presigned URLs must be short-lived.
- Buckets must not be public.
- Access to extracted text must obey the same scope as file download.
- Audit records and attestations must not be mutable through normal app paths.

## 9. Storage Rules

- Every document upload creates a new immutable `DocumentVersion`.
- Never overwrite source document bytes.
- S3 object keys must be deterministic and versioned by document/version.
- Store checksum for every upload.
- Capture S3 version ID where available.
- Local MinIO may auto-create buckets.
- Production S3 bucket/KMS/public-access changes require explicit env flags and review.
- Storage Admin UI v1 may create/list buckets and prefixes, but must not expose destructive bucket/object operations unless a separate ticket approves them.

## 10. Cover Page Rules

Cover pages must be generated from metadata without mutating the source document version.

Default cover page content:

- Title.
- Document number.
- Version.
- Effective date.
- Owner.
- Status.
- Category.
- Review cadence.
- Next review date.
- Approval chain.
- Revision history.

Recent-access summaries are opt-in because they can expose internal access patterns.

## 10a. Viewing And Editing Rules

- Supported document types: PDF, DOCX/DOC, XLSX/XLS, PPTX/PPT, images, TXT/MD.
- Non-PDF uploads get a PDF rendition (Gotenberg) for uniform in-browser viewing and cover-page prepend; the original source bytes are never mutated by conversion.
- In-browser viewing is read-only (pdf.js/react-pdf); view-only users never receive an editor.
- In-browser editing of docx/xlsx/pptx uses self-hosted OnlyOffice; native app-authored docs use TipTap.
- Every editor save-back or native edit creates a NEW immutable `DocumentVersion` (new object, new checksum) and regenerates the rendition. Editing never overwrites a prior version's bytes.
- Editing requires `document.write` plus document/category ACL; OnlyOffice save callbacks must be authenticated (signed).

## 10b. Acknowledgment Rules

- Staff read-and-acknowledge distribution uses `AcknowledgmentAssignment`; acknowledgment is recorded as an immutable `Attestation` with `action = acknowledged` (name, role, timestamp, IP).
- Assignees must view the document before the acknowledge action is enabled.
- Publishing a new version re-triggers acknowledgment against the new version; prior acknowledgments remain as historical evidence but do not satisfy the new version.

## 10c. UI/UX Quality Rules

- The product must look and feel professional and clinical-grade; UX must be simple and low-friction for non-technical clinic staff.
- Use one shared design system (tokens, components in `apps/web/src/ui/`): consistent spacing, typography, color, focus states.
- Every data screen implements loading, empty, error, and forbidden (403) states — never a blank or raw-error screen.
- Primary workflows (find a policy, upload/version, review/attest, acknowledge) must be reachable in as few clicks as possible with clear affordances.
- Accessibility: keyboard navigable, labeled controls, sufficient contrast, semantic HTML; a11y is part of Definition of Done for UI tickets.
- Responsive down to tablet width; tables/wide content scroll within their own container, never the page.

## 11. AI Tool Roles

Claude:

- Product analysis.
- PRD refinement.
- Architecture critique.
- Workflow edge cases.
- Documentation review.

Codex:

- Repo inspection.
- File edits.
- Implementation.
- Local command execution.
- Test debugging.
- Verification.

Gemini:

- Broad second-pass review.
- Large-context consistency review.
- Missed edge-case review.

Default workflow:

```text
Plan -> ticket -> failing test -> implementation -> verification -> review -> acceptance
```

## 12. Required Task Format

Every implementation task must include:

- Goal.
- Phase.
- Scope.
- Non-goals.
- Acceptance criteria.
- Data model impact.
- API impact.
- UI impact.
- RBAC/security impact.
- Audit impact.
- Tests required.
- Commands to run.
- Rollback plan.
- Done evidence.

Use `.ai/tasks/TASK_TEMPLATE.md`.

## 13. Required Verification Before Final Response

For framework/docs tasks:

```bash
Get-ChildItem -Force
Get-ChildItem -Recurse .ai
```

For app tasks, use the commands defined in `.ai/commands/` and project scripts once scaffolded.

Documentation check:

- Use `.ai/skills/documentation-update.md`.
- Use `.ai/commands/docs-check.md`.
- Do not close a ticket that changes behavior without updating developer docs, user guides, or explicitly stating why no documentation update was needed.

Code quality check:

- Use `.ai/skills/code-quality-review.md`.
- Use `.ai/commands/quality-check.md`.
- Do not close an implementation ticket with avoidable duplication, unclear boundaries, fragile error handling, unreviewed performance risks, or undocumented non-obvious logic.

Final responses must be short and factual:

- What changed.
- What was verified.
- What remains blocked or next.
