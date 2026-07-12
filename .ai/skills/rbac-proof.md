# Skill: RBAC Proof

## Purpose

Prove that authorization is enforced server-side and cannot be bypassed by UI manipulation.

## Use When

- Adding routes.
- Adding UI actions.
- Adding API clients.
- Changing permissions.
- Exposing document content.

## Procedure

1. Name the required permission or API scope.
2. Add server-side guard.
3. Add positive test for allowed actor.
4. Add negative test for unauthenticated request.
5. Add negative test for authenticated but forbidden actor.
6. Confirm UI handles 401 and 403.
7. Confirm audit event is written where required.

## Required Status Semantics

- `401` means not authenticated.
- `403` means authenticated but not allowed.

## Output

- Permission or scope.
- Protected route.
- Positive test.
- Negative tests.
- Audit proof.
