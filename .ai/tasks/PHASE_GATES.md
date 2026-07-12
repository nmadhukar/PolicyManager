# Phase Gates

## Phase 0A: Framework

Pass criteria:

- `AGENTS.md` exists.
- `CLAUDE.md` and `GEMINI.md` point to `AGENTS.md`.
- `.ai/README.md` exists.
- Agent, skill, command, and task folders exist.
- Documentation update requirement is enforced.
- Repo isolation status is documented.

Blockers:

- App scaffold generated before approval.
- Framework has competing sources of truth.

## Phase 0B: Scaffold

Pass criteria:

- Git root is PolicyManager.
- Monorepo structure exists.
- API/web/shared packages boot.
- Docker Compose starts PostgreSQL, MinIO, and MailHog.
- Prisma targets `policytracker`.
- Health checks pass.

Blockers:

- Git root resolves to parent folder.
- Any app table is in `public`.

## Phase 1: Product Contract

Pass criteria:

- PRD accepted.
- Lifecycle accepted.
- Role/permission matrix accepted.
- Review and attestation evidence accepted.
- API v1 scope accepted.
- Documentation outline accepted.

## Later Phase Gate Rule

Every later phase must close with:

- Tests.
- Documentation updates.
- RBAC/audit proof where relevant.
- Schema placement proof where relevant.
- User approval to proceed.
