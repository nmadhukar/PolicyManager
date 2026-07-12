# Command: /verify-phase

## Purpose

Verify that a phase is complete and safe to close.

## Input

```text
/verify-phase <phase-number>
```

## Procedure

1. Read phase acceptance gate in `PLAN.md`.
2. List completed tickets for the phase.
3. Run required checks.
4. Verify docs are current.
5. Verify migrations if database changed.
6. Verify RBAC/audit if access changed.
7. Verify S3 privacy if storage changed.
8. Produce a closeout report.

## Phase 0 Verification

Required:

```bash
git rev-parse --show-toplevel
git status --short --branch
Get-ChildItem -Force
Get-ChildItem -Recurse .ai
```

Phase 0 app scaffold is blocked until git root resolves to PolicyManager.

## Output

- Pass/fail.
- Evidence.
- Blockers.
- Recommendation.
