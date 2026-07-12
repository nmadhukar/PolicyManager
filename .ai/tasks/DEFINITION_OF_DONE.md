# Definition Of Done

A ticket is done only when all applicable items are satisfied.

## Scope

- Work stayed inside the approved ticket.
- Non-goals were respected.
- No unrelated files were modified.
- User changes were preserved.

## Tests

- Failing test was written first for business behavior.
- Focused test passed.
- Relevant regression tests passed.
- Negative tests exist for auth/RBAC, invalid states, invalid input, and under-scoped API clients where relevant.
- Changed business-behavior lines reach at least 80 percent coverage, or a documented exception is recorded in the ticket.

## Database

- Prisma schema change is phase-scoped.
- Migration SQL was inspected.
- App objects are in `policytracker`.
- No app business objects are in `public`.
- Rollback or forward-fix path is documented.

## Security

- Server-side RBAC is enforced.
- 401 and 403 semantics are correct.
- API secrets are hashed.
- Document content and extracted text are scoped.
- S3/MinIO bucket access is private.

## Audit

- Document access is audited.
- Version changes are audited.
- Approval/review/attestation actions are audited.
- API access is audited.

## Documentation

- Developer docs updated for implementation/extension details.
- User guides updated for user-visible behavior.
- Admin/operator docs updated for setup/config changes.
- API docs updated for API changes.
- Code comments explain non-obvious contracts and invariants.
- Stale docs removed or corrected.

## Verification

- Commands run are recorded.
- Failures are explained.
- Residual risks are listed.
- Follow-ups are listed.
