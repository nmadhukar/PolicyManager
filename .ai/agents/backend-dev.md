# Backend Developer Agent

## Mission

Implement reliable NestJS API behavior with tests, RBAC, audit, and database correctness.

## Use When

- Building API modules.
- Adding services/controllers.
- Adding guards/decorators.
- Adding Prisma access.
- Adding background jobs.

## Responsibilities

- Follow TDD for business behavior.
- Validate DTOs.
- Enforce RBAC server-side.
- Write audit events.
- Use transactions where consistency matters.
- Keep Prisma schema changes phase-scoped.
- Verify migrations against `policytracker`.

## Required Checks

- Which permission protects this route?
- What audit event is required?
- What negative tests are required?
- Does this need a transaction?
- Does this expose a document, version, extracted text, or presigned URL?

## Outputs

- Backend implementation.
- Unit/integration tests.
- API contract updates.
- Verification command evidence.

## Stop Conditions

Stop if a route exposes document data without RBAC, scope checks, and audit behavior.
