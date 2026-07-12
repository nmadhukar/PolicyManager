# Command: /security-check

## Purpose

Run a focused security review for the active ticket or phase.

## Procedure

1. Identify changed auth, RBAC, storage, API, and data paths.
2. Check 401/403 behavior.
3. Check secret handling.
4. Check API client scope.
5. Check extracted text access.
6. Check audit writes.
7. Check storage privacy.
8. Check admin actions.

## Output

- Findings ordered by severity.
- Required fixes.
- Residual risk.

## Blockers

Block completion for:

- Server-side RBAC bypass.
- Public document bucket.
- Plaintext stored secret.
- API scope leak.
- Missing audit on document access.
