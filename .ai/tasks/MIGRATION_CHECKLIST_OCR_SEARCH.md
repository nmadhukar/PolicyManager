# Migration Checklist — OCR (`extractionStatus`) + Full-Text (`tsvector`)

Companion to `.ai/skills/migration-safety.md` for the two Phase 10 migrations:
**PM-1002** (extraction status columns) and **PM-1005** (full-text search). Read
that skill first; this file adds the specific gotchas these two carry.

Non-negotiables (AGENTS.md §3): everything under `policytracker`, nothing in
`public`; inspect generated SQL before applying; prove placement against a live DB;
never drop audit/attestation/version evidence.

---

## Migration A — PM-1002: extraction status

**Prisma schema deltas** (all `@@schema("policytracker")`):

```prisma
enum ExtractionStatus {
  pending
  processing
  done
  failed
  skipped
  @@schema("policytracker")
}

model DocumentVersion {
  // ...existing fields...
  extractionStatus ExtractionStatus @default(pending)
  extractionError  String?
  ocrApplied       Boolean          @default(false)
  // Worker claims rows by status; index it.
  @@index([extractionStatus])
}
```

**Checklist**

- [ ] New enum lands in `policytracker`, not `public` (Prisma multiSchema puts enums
      wherever `@@schema` says — confirm it's declared).
- [ ] `@default(pending)` chosen deliberately: **existing rows** backfill to
      `pending`, so the reindex job (PM-1006) can re-evaluate legacy versions.
      If you prefer legacy rows NOT auto-OCR'd on deploy, default to a neutral value
      and let PM-1006 set `pending` selectively — decide and document.
- [ ] `hasExtractedText` semantics unchanged; `extractionStatus` is orthogonal
      (a `done` row can still have `hasExtractedText=false` for a blank scan).
- [ ] Adding a nullable column + defaulted column to a large table is a fast
      metadata-only change in modern Postgres — no table rewrite. Confirm.
- [ ] No change to `extractedText`/`s3Key`/checksum/version evidence.

---

## Migration B — PM-1005: full-text search (tsvector + GIN)

**The Prisma constraint that bites here:** Prisma does not model a
`GENERATED ALWAYS AS (to_tsvector(...))` tsvector column natively. Use
`Unsupported("tsvector")?` in the schema so Prisma tolerates the column, and write
the **generated expression + GIN index as raw SQL** inside the migration.

```prisma
model DocumentVersion {
  // Prisma can't express the generated tsvector; it's maintained by SQL below.
  searchVector Unsupported("tsvector")?
  // Do NOT add @@index here for the GIN — declare it in raw SQL (typed GIN).
}
```

Raw SQL to hand-write into the migration (schema-qualified):

```sql
-- Generated column: immutable because the regconfig is a constant literal.
ALTER TABLE "policytracker"."DocumentVersion"
  ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce("fileName", '') || ' ' || coalesce("extractedText", ''))
  ) STORED;

-- GIN index for @@ / ts_rank.
CREATE INDEX "DocumentVersion_searchVector_gin"
  ON "policytracker"."DocumentVersion" USING GIN ("searchVector");
```

Note: title lives on `Document`, not `DocumentVersion`. Decide the indexed surface:
either include `Document.title` via a maintained column / trigger on the Document
row, or index version `fileName + extractedText` here and OR-match `Document.title`
with `ILIKE` in the query. Document the choice in the ticket.

**Checklist**

- [ ] tsvector uses a **constant** `regconfig` (`'english'`) so
      `GENERATED ALWAYS AS ... STORED` is accepted (expression must be immutable).
      A column-driven config (`to_tsvector("lang", ...)`) is NOT immutable and will
      be rejected — hardcode the language or use a trigger instead.
- [ ] `coalesce(col,'')` on every nullable source so NULL text doesn't null the
      whole vector.
- [ ] GIN index (not GIN on the raw text, not btree). Confirm via EXPLAIN on seeded
      data that the GIN index is used and it's not a seq scan.
- [ ] **`CREATE INDEX CONCURRENTLY` cannot run inside a transaction.** Prisma wraps
      each migration in a transaction, so either (a) accept the brief lock of a
      normal `CREATE INDEX` (fine on a small/new table), or (b) split the
      concurrent build into a separate, manually-run step for large prod tables and
      document it in the runbook. Do not silently put `CONCURRENTLY` in a normal
      migration — it will fail.
- [ ] Generated `STORED` column backfills existing rows automatically on add; no
      separate data backfill needed for the vector itself (PM-1006 still enqueues
      OCR so the *text* exists to index).
- [ ] Query layer switched to `@@` + `ts_rank`; the response contract and all
      filters are unchanged; ILIKE fallback documented behind the search flag.
- [ ] Down migration drops the index then the column; additive and reversible.

---

## Shared verification (run for BOTH, per AGENTS.md §3)

1. Inspect generated SQL before apply; confirm schema qualification `policytracker`.
2. Apply to local Postgres (`prisma migrate dev`).
3. Run the schema placement query and confirm the new enum/columns/index are under
   `policytracker`, none under `public`:

```sql
select table_schema, table_name
from information_schema.tables
where table_schema in ('public', 'policytracker')
order by table_schema, table_name;

-- Column/enum/index proof:
select column_name, data_type
from information_schema.columns
where table_schema = 'policytracker' and table_name = 'DocumentVersion'
  and column_name in ('extractionStatus','extractionError','ocrApplied','searchVector');

select indexname from pg_indexes
where schemaname = 'policytracker' and tablename = 'DocumentVersion';
```

4. Run migration + query-layer tests; confirm existing extraction/search specs stay
   green.
5. Record: migration file path, SQL review notes, placement proof, rollback note.

## Reject If

- Any new object lands in `public`.
- The tsvector expression is non-immutable (will fail at migrate time).
- `CONCURRENTLY` is embedded in a transactional Prisma migration.
- The migration alters or drops `extractedText`, `s3Key`, checksum, or any version/
  audit/attestation evidence.
