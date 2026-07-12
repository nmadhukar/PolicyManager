# Skill: Acknowledgment Distribution

## Purpose

Distribute a published document version to staff for read-and-acknowledge, track completion, and produce survey evidence.

## Use When

- Assigning a policy/procedure to users or roles for "I have read and understand".
- Tracking acknowledgment completion and overdue status.

## Procedure

1. Create `AcknowledgmentAssignment` rows targeting users and/or roles for a specific `documentId`/`versionId`, with an optional due date.
2. Require the assignee to view the document (rendition) before enabling the acknowledge action.
3. On acknowledge, record an immutable `Attestation` with `action = acknowledged`, capturing name, role, timestamp, and IP.
4. Mark the assignment completed; expose completion percentage and overdue counts.
5. When a NEW version is published, re-open (re-trigger) acknowledgment against the new version — prior acknowledgments remain as historical evidence but do not satisfy the new version.
6. Never mutate historical attestations; corrections are new records.
7. Audit assignment creation, view, and acknowledgment events.
8. Update user and admin docs describing the distribution and evidence flow.

## Required Companion Skills

- Use `.ai/skills/rbac-proof.md` for who may assign vs who may acknowledge.
- Use `.ai/skills/coverpage-export.md` when acknowledgment status feeds compliance evidence.
