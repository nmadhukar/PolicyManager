# Codex Global Rules For PolicyManager

Read `../AGENTS.md` first. This file is a Codex-friendly mirror of the most important constraints.

Rules:

- Do not scaffold app code while `git rev-parse --show-toplevel` resolves outside `PolicyManager`.
- Do not create app database objects in `public`.
- Use PostgreSQL schema `policytracker`.
- Use TDD for business behavior.
- Keep each task inside the approved ticket.
- Preserve user changes.
- Use server-side RBAC, never UI-only security.
- Use private S3/MinIO access with short-lived presigned URLs.
- Build Prisma models by phase.
- Final answers must include changed files and commands run.

Canonical source:

- `../AGENTS.md`
- `../PLAN.md`
