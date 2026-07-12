# Skill: Documentation Update

## Purpose

Keep developer documentation, user guides, and code comments in sync with behavior changes.

## Use When

- Any feature changes user behavior.
- Any feature changes admin behavior.
- Any API changes.
- Any command or setup step changes.
- Any database, storage, auth, or deployment behavior changes.
- Any non-obvious code contract is introduced.

## Procedure

1. Identify what changed.
2. Identify who needs to understand it:
   - end user
   - admin
   - developer
   - operator
   - auditor
3. Update the right documentation:
   - README for setup and core usage
   - developer guide for architecture and extension points
   - user guide for workflows
   - admin guide for configuration
   - API docs for endpoint changes
   - ADR for architectural decisions
   - runbook for deployment/operations
4. Review code for non-obvious logic.
5. Add comments only where they explain intent, invariant, contract, or risk.
6. Remove or correct stale docs.
7. Record documentation changes in done evidence.

## Code Comment Rules

Add comments for:

- RBAC decisions that are easy to weaken accidentally.
- Audit evidence requirements.
- Document/version immutability.
- Review cadence date math.
- S3 key and presigned URL safety.
- OIDC identity linking.
- Migration/schema safety.
- Cover page/export assumptions.

Do not add comments that only restate simple code.

## Output

- Docs updated.
- User guide updated or not-needed reason.
- Developer guide updated or not-needed reason.
- Code comments added or not-needed reason.
- Stale docs removed or corrected.
