# Skill: Review Annotations

## Purpose

Implement and review governed, version-scoped annotations for document review without mutating source document bytes or exposing annotation data outside internal workflows.

## Use When

- Adding or changing annotation APIs.
- Updating the document viewer annotation layer.
- Changing review, approval, acknowledgment, or sign-off behavior that depends on unresolved annotations.
- Reviewing whether annotations are correctly hidden from public API, cover-page, export, and official download paths.

## Rules

1. Annotations belong to one immutable `DocumentVersion`.
2. Publishing or restoring a version must not carry annotations forward automatically.
3. Annotation create/update/delete requires server-side document view access first.
4. Creating annotations requires `document.comment`, an assigned reviewer relationship, or an open review task for the same version. Versionless legacy tasks authorize only the document's current version.
5. Resolving or reopening annotations is limited to the author, an authorized commenter, or assigned reviewer/task for the same version.
6. Deleting annotations is soft-delete only and limited to the author, Admin, or Compliance Officer.
7. Public API, cover-page generation, export, and official download flows must not include annotation data.
8. Every create, resolve, reopen, and delete writes an audit event.
9. Viewer UI hiding is only an affordance; backend checks are authoritative.

## Procedure

1. Confirm the active ticket states annotation scope, non-goals, RBAC impact, audit impact, and tests.
2. Verify schema changes are in `policytracker` and use soft delete for annotation removal.
3. Trace backend routes through service-level access checks and audit writes.
4. Trace frontend affordances for loading, empty, error, forbidden/read-only, create, resolve, reopen, and delete states.
5. Confirm review and approval surfaces show unresolved annotation counts or warnings where applicable.
6. Confirm public API, cover-page, export, and download code paths do not query or serialize `DocumentAnnotation`.
7. Add focused tests for author, commenter, reviewer, auditor/read-only, compliance delete, soft-delete hiding, and public API exclusion.
8. Update developer docs and user guides with the internal-only annotation contract.

## Verification

Required evidence before closing an annotation ticket:

- Unit or service tests for RBAC and audit behavior.
- UI tests or focused manual evidence for read-only vs authoring affordances.
- Public API/export regression proof that annotation fields are absent.
- Schema placement proof for tables, enums, and indexes.
- Documentation updates in developer, admin, and user guides, or a written not-needed reason.

## Output

- Findings first if reviewing.
- Files changed.
- Commands run.
- Any residual risk, especially around public exposure, stale annotations, or unresolved-signoff handling.
