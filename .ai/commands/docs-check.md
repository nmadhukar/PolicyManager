# Command: /docs-check

## Purpose

Verify documentation and code comments are complete for the active ticket.

## Procedure

1. List behavior changes.
2. List API changes.
3. List setup/env/command changes.
4. List user or admin workflow changes.
5. Confirm relevant docs were updated.
6. Confirm developer docs explain extension and maintenance points.
7. Confirm user guides explain workflow changes.
8. Confirm non-obvious code has useful comments.
9. Confirm stale docs were removed or corrected.

## Pass Criteria

- User-facing changes have user guide updates or a written not-needed reason.
- Developer-facing changes have developer docs or a written not-needed reason.
- Setup/deployment changes have runbook/README updates.
- Complex or fragile code has comments explaining why, not what.

## Output

- Documentation pass/fail.
- Files checked.
- Missing docs.
- Missing code comments.
