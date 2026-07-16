# ADR-0004: Generic Structural Metadata Model for RAG Chunks

- Status: Proposed (awaiting user approval — do not implement until approved)
- Date: 2026-07-16
- Deciders: User (product owner), Claude (architect)
- Phase: RAG Phase 7 of the remediation roadmap — "Structural metadata model"
  (the first, unblocking phase of the accepted multi-document conformance audit)
- Supersedes: none
- Extends: ADR-0002 (pgvector + `DocumentChunk`) — adds structural columns to the
  same table and reuses the same raw-SQL, delete-then-insert write path and the
  two-leg hybrid retrieval seam.

## Context

A conformance audit (accepted 2026-07-16) found the RAG pipeline is **content-aware
but structure-blind**. `DocumentChunk` stores only `content` / `chunkIndex` /
`embedding` / `searchVector`; it carries **no** structural metadata. As a result,
four requirement clusters are not merely untested but *structurally impossible*:

- exact section/identifier retrieval ("Policy 705", "SOP-0045", "Clause 8.3",
  "Article IV", "Section 504"),
- section-level context assembly and adjacent-chunk expansion,
- citations that identify the section and page, and
- disambiguation of the same identifier across documents.

The requirement is a **document-type-neutral** structural model that supports policy
manuals, SOPs, procedures, employee handbooks, clinical manuals, contracts,
regulatory documents, training materials, reports, **and unstructured documents**
(which must degrade cleanly to "no structure"). The audit named the generic fields:
`documentType` (on `Document`), and `sectionType`, `sectionIdentifier`,
`normalizedSectionIdentifier`, `sectionTitle`, `headingPath`, `pageStart`,
`pageEnd`, plus a `metadata` JSON escape hatch (on the chunk).

**This ADR governs *where that structure lives*. It is deliberately SCHEMA-ONLY.**
The component that *detects* structure (a structure-aware extractor/chunker) is a
**later** phase. That reframing is decisive: in this phase there is no writer of
structural values, so under **every** candidate design the new fields ship `NULL`
and are populated lazily later, through the one existing idempotent write path
(`EmbeddingService.replaceChunks`, a single raw `DELETE`-then-`INSERT` per version).

Verified codebase facts that drive the decision:

- `DocumentChunk` rows are written **only** by `replaceChunks` (embedding.service.ts),
  via raw SQL because Prisma cannot write `Unsupported("vector")`. Re-index is
  **wholesale**: a version's chunks are deleted and re-inserted atomically. There is
  **no in-place chunk UPDATE path anywhere.**
- Both retrieval legs (`vectorSearch`, `ftsSearch` in retriever.service.ts) are raw
  `$queryRaw` that `SELECT` scalar `dc.*` and JOIN **only** `Document` on
  `currentVersionId` (+ `status='published' AND deletedAt IS NULL`). RRF fuses by
  `chunkId`; an ACL re-filter (`DocumentAccessService.buildListWhere`) runs after.
- Citations (`RetrievedChunk`, `RagCitation`) carry `documentId`, `versionId`,
  `chunkId`, `documentTitle`, `documentNumber` — no section/page/versionNumber.
- The schema is single-tenant: there is **no** organization/tenant column anywhere.
- Precedent for additive raw-SQL structure on this table exists: migration
  `20260716160000_rag_chunk_fts` added a `GENERATED ... STORED` tsvector + GIN index.

## Decision

### D1 — Store structural metadata **inline on `DocumentChunk`** (Option A)

Add the generic structural fields as **nullable/defaulted columns on
`DocumentChunk`** — no separate section table in this phase:

`sectionType`, `sectionIdentifier`, `normalizedSectionIdentifier`, `sectionTitle`,
`headingPath` (`text[]`, root→leaf breadcrumb), `pageStart`, `pageEnd`, and
`metadata` (`jsonb`, default `{}`).

And add **`documentType`** (nullable `String`) + a **`metadata` `jsonb`** column to
`Document`.

The chunk is the unit of retrieval, citation, and re-index; keeping section context
on the chunk aligns the unit of storage with the unit of use. Both hot legs already
read scalar `dc.*` and join only `Document`, so exact-identifier retrieval and
section/page citations become **pure projection + index work with zero new joins**.

### D2 — `documentType` and `sectionType` are **free `String?`, never Postgres enums**

Type-neutrality is a hard requirement and the corpus of document types is open-ended
(policy, SOP, procedure, handbook, clinical manual, contract, regulatory guidance,
training material, report, form, …, unstructured). A closed Postgres `ENUM` would
force an `ALTER TYPE ADD VALUE` migration per new type — the opposite of neutral. We
use free strings with a documented recommended vocabulary, not a DB-enforced enum.
(This is the one flaw that sank the hybrid variant's `DocumentType` enum.)

### D3 — `headingPath` as `text[]`, **not** `ltree`, and **not** a section tree

Hierarchy is captured as a per-chunk **materialized ancestor breadcrumb**
(`["Chapter 7", "705", "705.3"]`, root→leaf). We reject `ltree` because real
identifiers contain dots, spaces, and dashes that `ltree` labels forbid, and Phase 7
has no subtree/ancestor SQL to justify it. The `text[]` breadcrumb covers citation
display and shallow filtering (`'Chapter 7' = ANY("headingPath")`) today, and — this
is load-bearing — it is the **ready-made materialization source** for a normalized
`DocumentSection` tree if a later phase needs one (see D5). No GIN index on the array
in this phase (no query needs it yet).

### D4 — Indexes: **partial** btree over the classified subset

Exact-identifier retrieval rides partial btree indexes that include **only** chunks
that actually carry an identifier (`WHERE "normalizedSectionIdentifier" IS NOT NULL`),
so unstructured docs' `NULL`s never bloat the index and it stays tiny and hot:

- `("documentId", "normalizedSectionIdentifier") WHERE normalizedSectionIdentifier IS NOT NULL`
  — the "within this document, jump to Clause 8.3" and doc-scoped-boost path;
- `("normalizedSectionIdentifier") WHERE normalizedSectionIdentifier IS NOT NULL`
  — the cross-corpus "find Policy 705 anywhere the user can see" path;
- `("sectionType") WHERE sectionType IS NOT NULL` — low-cardinality section-class filter.

Plus a `CHECK ("pageStart" IS NULL OR "pageEnd" IS NULL OR "pageEnd" >= "pageStart")`
sanity constraint, mirroring the existing `chunkIndex`/`tokenCount` CHECKs.

### D5 — Explicitly document the evolution path to a normalized `DocumentSection`

Choosing inline now is a **reversible** decision, and that is the reason to choose it.
When a later (detector) phase has a real writer and reader for hierarchy, a normalized
`DocumentSection` table + a nullable `DocumentChunk.sectionId` FK can be added
**additively and non-breakingly**:

1. `CREATE TABLE "policytracker"."DocumentSection"` (additive, droppable — same class
   as migrations `120000`/`160000`);
2. `ADD COLUMN "sectionId" TEXT NULL` + a nullable `ON DELETE SET NULL` FK on
   `DocumentChunk` (additive, rewrites no existing row);
3. extend `replaceChunks`' single raw `INSERT` to also write `sectionId` — an edit
   that must happen when the detector lands **under any option anyway**.

Because re-index rewrites every chunk wholesale, the FK and any section rows are
stamped **for free** as documents re-index — no bespoke `UPDATE` migration. The
`headingPath` array supplies the ancestor chain to reconstruct the tree, and
`normalizedSectionIdentifier` is retained verbatim as the denormalized hot field a
section table would have copied. **No field is re-litigated; the tree is added
around the columns, not instead of them.**

## Alternatives considered

Three designs were steelmanned independently and scored across ten dimensions
(nesting, duplication, exact-identifier retrieval, section assembly, citations,
backfill, migration risk, Prisma ergonomics, query performance, unstructured
support), then adjudicated by a skeptical review.

### Option B — normalized `DocumentSection` model + `DocumentChunk.sectionId` FK

A per-version tree of section rows (`parentSectionId` self-FK), with chunks pointing
at a section. **Genuinely superior** for true hierarchy: subtree/ancestor queries,
sibling ordering independent of `chunkIndex`, DB-enforced per-version identifier
uniqueness, and section-level entities (per-section approvals/review state). It won
4 of 10 dimensions (nesting, duplication, section assembly — tie elsewhere).

**Rejected for this phase** because: (a) with no detector, the table holds **zero
rows** and every column is `NULL` until a Phase-2 re-index — it delivers no Phase-7
value; (b) its own performance claim requires denormalizing the hot fields
(`normalizedSectionIdentifier`, `pageStart`, `sectionTitle`) back onto the chunk to
keep the two latency-critical legs join-free — so B is *in practice a hybrid* that
pays **both** the new-table/self-FK/order-sensitive-two-entity-write cost **and** the
denormalized-column cost; (c) it commits to an unvalidated detector shape (can a
chunk span two sections? are pages per-section or per-line?) before a single real
document has been through a detector. B's advantages are real but land in a **later**
phase, and D5 shows they can be adopted then without a breaking migration.

### Option C — hybrid: normalized `DocumentSection` **plus** denormalized hot fields on the chunk

The "best of both": tree for assembly, copied hot fields for join-free retrieval.
The hybrid's own author concluded the denormalized half is **premature commitment**
(not premature cost) for a schema-only phase — it bakes "identifier + page belong on
the chunk" before a detector proves what is extractable — and recommended shipping
only the normalized half + a bare `sectionId` FK now, deferring the copies. It also
introduced a closed `DocumentType` Postgres enum, which **fails the type-neutrality
requirement** (D2). **Rejected** as the most machinery for the least validated
Phase-7 benefit; its non-enum insights are folded into D2/D5.

### Why Option A wins here

The decisive axis for a schema-only phase is **reversibility, not eventual
capability**. The pieces expensive to retrofit are the columns physically on
`DocumentChunk` (every existing row must be re-stamped); the piece cheap to add later
is the section table + nullable FK. Option A adds exactly the hard-to-retrofit pieces
now (for free, via the re-index path) and defers the cheap-to-retrofit piece to the
phase that will actually have a writer and reader for it. A closes all four Phase-7
requirements (exact-identifier retrieval, section/page citations, clean unstructured
degradation, and a hierarchy source for later) with the **smallest** additive
migration and **no** change to the retrieval, ACL, fusion, or citation pipeline shape.

## Consequences

- **Additive, `policytracker`-only, droppable** migration: `ADD COLUMN` ×8 on
  `DocumentChunk`, ×2 on `Document`, three partial indexes, one CHECK. No new table,
  no self-FK, no cross-table FK, no enum type. Verified in `policytracker`, never
  `public` (AGENTS.md §3).
- **No behavior change in this phase.** Every new column is `NULL`/`{}`/`[]`;
  retrieval, ACL, versioning, audit, and citations behave **byte-identically to
  today** until a later detector populates the fields and the retriever/citation
  code is extended (separate tickets). This ADR + task ship the *destination*, not
  the traffic.
- **Existing chunks stay valid** with zero backfill machinery: nullable/defaulted
  columns make every existing row instantly a clean "unstructured" chunk. A future
  detector backfills values through the normal wholesale re-index — no bespoke
  data migration.
- **Storage duplication** of section context across a section's chunks is real but
  bounded (tiny next to the 1536-dim vector already on each row) and free of update
  anomalies because re-index rewrites a version's chunks atomically — they can never
  disagree.
- **Honest limitation:** no first-class section entity and no true hierarchical
  navigation in this phase (subtree/ancestor queries, sibling ordering independent of
  `chunkIndex`, per-section objects). Mitigated by D3/D5; adopt the normalized tree
  when a detector gives it a writer and reader.

## Rollout / rollback

- The columns are inert until written. Ship anytime; nothing reads them yet.
- Rollback = a down migration dropping the eight chunk columns, two document columns,
  three indexes, and the CHECK. No `DocumentVersion` bytes are touched; no existing
  behavior depends on the columns, so the drop is safe at any time.
- No Docker/image change (pgvector already present from ADR-0002). No new dependency.

## Related

- ADR-0002 (pgvector + `DocumentChunk`) — same table, same raw-SQL write path, same
  two-leg retrieval seam.
- ADR-0001 (OCR + FTS) — the `GENERATED ... STORED` + GIN precedent this migration
  class follows.
- AGENTS.md §3 (schema placement), §8 (extracted-text scope = download scope), §9
  (immutable versions), §12 (task format).
- Accepted conformance audit (2026-07-16) — this is the first, unblocking remediation
  phase; Phases for structure-aware ingestion, retrieval diversity, disambiguation,
  and the multi-type fixture corpus depend on it.
