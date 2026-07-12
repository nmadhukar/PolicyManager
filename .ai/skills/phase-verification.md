# Skill: Phase Verification

## Purpose

Close a phase only when its acceptance gate is actually proven.

## Use When

- End of a phase.
- Before asking user to approve next phase.

## Procedure

1. Read phase acceptance criteria in `PLAN.md`.
2. Read tickets completed for the phase.
3. Run required verification commands.
4. Check schema placement if database changed.
5. Check RBAC/audit if access changed.
6. Check S3 privacy if storage changed.
7. Check docs are current.
8. List blockers.
9. Recommend approve, approve with risk, or block.

## Output

- Phase.
- Completed tickets.
- Commands run.
- Evidence.
- Blockers.
- Recommendation.
