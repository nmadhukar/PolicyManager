# Phase 11 — Review Annotations

Governed markup for the **review cycle**, not open annotation on approved documents.
Decisions: `.ai/decisions/ADR-0002-review-annotations.md`. **Priority: after
Phase 10 (OCR/search).**

Core rules (from ADR-0002): overlay layer only — never mutate version bytes,
rendition, or cover-page export (AGENTS.md §9); version-scoped and non-carrying;
`document.comment` RBAC (Admin/Compliance/Manager/assigned Reviewer create; Staff
none; Auditor read-only); resolvable + review-integrated; soft-delete + audited;
normalized-rect anchors. UI shows loading/empty/error/forbidden states (§10c).
TDD-first, ≥80% changed-line coverage.

Dependency order: **PM-1101 → PM-1102 → PM-1103 → PM-1104 → PM-1105 → PM-1106.**

---

## PM-1101 — `DocumentAnnotation` model + `document.comment` permission

**Goal.** Data model for version-scoped annotations and the permission that gates
them.

**Acceptance criteria.**
- [ ] `DocumentAnnotation` in `policytracker`: `id, documentId, versionId, authorId,
      page Int, rects Json (normalized [0,1] boxes), type (note|highlight),
      quotedText String?, body String?, status (open|resolved), resolvedById?,
      resolvedAt?, deletedAt?, createdAt, updatedAt`. Index `[versionId]`,
      `[versionId, status]`.
- [ ] `AnnotationType` + `AnnotationStatus` enums in `policytracker`.
- [ ] New permission `document.comment` seeded to Admin, Compliance Officer,
      Manager/Owner (and granted to assigned reviewers via review flow); NOT Staff,
      NOT Auditor.
- [ ] Migration verified in `policytracker`, none in `public` (see
      `MIGRATION_CHECKLIST_OCR_SEARCH.md` shared verification pattern).

**Data model impact.** New table + 2 enums + 1 permission seed. **API/UI.** None
here. **Tests.** Migration placement proof; seed test asserts role→permission grants.

---

## PM-1102 — Annotations API (scoped CRUD + RBAC + audit)

**Goal.** Endpoints to create/list/resolve/soft-delete annotations on a version.

**Acceptance criteria.**
- [ ] `POST /documents/:id/versions/:versionId/annotations` — requires
      `document.comment` **and** document/category ACL view; creates open annotation.
- [ ] `GET .../annotations` — requires document view; returns annotations for the
      version (excludes soft-deleted); Auditor can read.
- [ ] `PATCH .../annotations/:annId/resolve` and `/reopen` — author, a reviewer, or
      Compliance.
- [ ] `DELETE .../annotations/:annId` — **soft delete**; author or Compliance only.
- [ ] Every create/resolve/reopen/delete writes an `AuditEvent` (actor, IP, UA).
- [ ] Annotations never appear in cover-page export or the public `/api/v1`
      surfaces.

**Security/RBAC.** `document.comment` for authoring; view scope for reading; 401
unauth / 403 forbidden. **Audit.** All state changes audited. **Tests.** Unit:
guard matrix (Staff create⇒403, Auditor create⇒403, Auditor read⇒200, Reviewer
create⇒201). Integration: create→list→resolve→soft-delete; deleted excluded.
Negative: cross-version/cross-document id mismatch⇒404.

---

## PM-1103 — Viewer overlay UI

**Goal.** Render and author annotations over the read-only PDF rendition.

**Acceptance criteria.**
- [ ] Toggleable annotation layer over the pdf.js/react-pdf rendition; highlights and
      notes render at the correct page + normalized position across zoom levels.
- [ ] Users with `document.comment` can add a highlight/note and resolve; users
      without it see annotations read-only, **no create affordance** (UI hiding
      backs the server check, never replaces it).
- [ ] Loading/empty ("no annotations")/error/forbidden states present (§10c);
      keyboard-navigable, labeled controls, sufficient contrast.
- [ ] Annotation panel lists notes with author + timestamp + resolved state; click
      focuses the anchor in the page.

**UI impact.** New overlay + side panel in `DocumentViewer`/detail. **Tests.**
Component: renders each state; add/resolve flows against mocked API; a11y check;
no create button without permission.

---

## PM-1104 — Review-cycle integration

**Goal.** Make annotations part of closing a review, not a detached feature.

**Acceptance criteria.**
- [ ] Review task and document detail show an **unresolved annotation count** for
      the current version.
- [ ] Approving/attesting a version with unresolved annotations shows a **warning**
      (soft, non-blocking in v1) that surfaces the count.
- [ ] Publishing a new version leaves prior-version annotations intact as history
      but they do not carry to the new version (ADR-0002 D2).

**Tests.** Unit: unresolved count logic; approve-with-unresolved warning path.
Integration: new version ⇒ prior annotations remain queryable on the old version,
absent on the new.

---

## PM-1105 — Access, audit & regression tests

**Goal.** Prove the governance rules hold end-to-end.

**Acceptance criteria.**
- [ ] Access matrix e2e: Staff/Auditor cannot author; confidential-doc annotations
      invisible to users without view scope.
- [ ] Audit trail contains create/resolve/delete with actor + IP + UA.
- [ ] Cover-page export and `/api/v1` outputs verified free of annotation data.

**Tests.** e2e: reviewer annotates draft → resolves → approves; auditor reads but
cannot write; export clean.

---

## PM-1106 — Docs + skill

**Goal.** Keep docs and the framework current.

**Acceptance criteria.**
- [ ] Developer docs (annotation model, overlay contract, non-carrying rule); user
      guide (how reviewers comment); admin docs (`document.comment` grant).
- [ ] `.ai/skills/review-annotations.md` documents the governed-markup procedure.
- [ ] ADR-0002 kept in sync with as-built.

**Tests.** Docs review via `.ai/commands/docs-check.md`.
