# ADR-0002: Review Annotations (governed markup, not open annotation)

- Status: Accepted
- Date: 2026-07-13
- Deciders: User (product owner), Claude (architect)
- Phase: 11
- Related: ADR-0001 (OCR/search), AGENTS.md §9 (immutability), §10c (UI states)

## Context

A generic DMS lets users highlight and comment freely on documents. PolicyManager
is a **controlled-document** system: an approved `DocumentVersion` is CARF/JC
evidence and must stay pristine. We still want collaboration during the **review
cycle** (reviewers marking up a draft before approval). OnlyOffice already provides
comments/track-changes when *editing* docx/xlsx/pptx; the gap is annotation on the
**read-only PDF rendition** and for **view-only reviewers**. The viewer currently
disables the layer (`renderAnnotationLayer={false}`).

## Decision

Add **Review Annotations** as a **separate overlay layer**, not free-form markup on
official documents.

- **D1 — Overlay, never bytes.** Annotations live in a new Postgres table
  (`policytracker`), keyed to a specific `versionId`. They **never** mutate the
  source bytes, the PDF rendition, or the cover-page export.
- **D2 — Version-scoped, non-carrying.** An annotation belongs to one version. When
  a new version is published, prior annotations remain as **historical evidence**
  (like superseded acknowledgments) but do **not** carry forward — anchors would no
  longer match, and a new version is a fresh review.
- **D3 — Governed by RBAC, not open to all.** Creating an annotation requires a
  dedicated `document.comment` permission (seeded to Admin, Compliance Officer,
  Manager/Owner, and assigned Reviewers). **Staff and Auditor do not annotate**;
  Auditor may view annotations read-only. Viewing annotations requires document view
  scope (same as the file).
- **D4 — Resolvable, review-integrated.** Annotations have `open`/`resolved` state
  and surface as an unresolved count on the review task and document detail, so the
  review cycle can close them out. Approving a version with unresolved annotations
  **warns** (does not hard-block) in v1.
- **D5 — Audited & immutable-ish.** Create/resolve/delete are audited (author, IP,
  UA). Delete is **soft** (author or Compliance only); annotation history is not
  destroyed, consistent with the system's evidence posture.
- **D6 — Anchor model.** Resolution-independent: `page` + normalized rect(s) in
  `[0,1]` relative to the rendition page (plus an optional quoted-text snapshot).
  Type is `note` (point/rect + comment) or `highlight` (rect(s), optional comment).

## Rejected alternatives

- **pdf.js native annotation layer baked into the PDF** — would embed markup into a
  file and blur the pristine-version line. Rejected in favor of an external overlay.
- **Open highlighting for all users on published docs** — undermines controlled-
  document integrity. Rejected; annotation is a governed review activity.

## Consequences

- New `DocumentAnnotation` table + `document.comment` permission (migration verified
  in `policytracker`).
- Viewer gains a toggleable overlay; must render loading/empty/error/forbidden
  states (§10c) and never expose the create UI to users lacking `document.comment`.
- Cover-page export and official downloads are unchanged — annotations are never
  part of them.
- Priority: **after Phase 10 (OCR/search)**, which is higher compliance value.

## Rollback

Feature-flag the overlay + endpoints; the table is additive/droppable; no version
bytes are ever touched, so rollback is disabling the flag.
