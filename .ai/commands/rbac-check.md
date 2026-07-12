# Command: /rbac-check

## Purpose

Verify route and UI changes enforce authorization correctly.

## Procedure

1. List changed routes/actions.
2. Map each route/action to a permission or API scope.
3. Confirm server-side guard exists.
4. Confirm allowed actor test exists.
5. Confirm unauthenticated test exists.
6. Confirm forbidden actor test exists.
7. Confirm audit event exists where required.
8. Confirm UI handles forbidden state.

## Required Results

- Allowed request succeeds.
- Missing auth returns `401`.
- Forbidden auth returns `403`.

## Output

- Route matrix.
- Permission matrix.
- Test evidence.
- Gaps.
