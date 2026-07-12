# Skill: TDD Loop

## Purpose

Implement behavior through tests instead of assumptions.

## Use When

- Adding business behavior.
- Adding permissions.
- Adding workflow transitions.
- Adding API behavior.
- Fixing bugs.

## Procedure

1. Pick one acceptance criterion.
2. Write the smallest failing test.
3. Run focused test and capture failure.
4. Implement minimal code.
5. Run focused test and capture pass.
6. Add negative tests.
7. Refactor under green tests.
8. Run relevant regression tests.
9. Record command output in done evidence.

## Required Negative Tests

Add negative tests for:

- Unauthorized access.
- Forbidden role.
- Invalid lifecycle transition.
- Invalid file.
- Under-scoped API client.
- Missing audit behavior where applicable.

## Output

- Test file path.
- Failure evidence.
- Passing command.
- Regression command.
