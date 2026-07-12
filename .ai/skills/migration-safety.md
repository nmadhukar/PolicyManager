# Skill: Migration Safety

## Purpose

Ensure Prisma/PostgreSQL changes are safe, reviewable, and isolated to the `policytracker` schema.

## Use When

- Editing `schema.prisma`.
- Generating migrations.
- Adding indexes.
- Adding constraints.
- Adding seed data.

## Procedure

1. Review the ticket for data model impact.
2. Update Prisma schema only for the active phase.
3. Generate migration.
4. Inspect generated SQL before applying.
5. Verify `CREATE SCHEMA policytracker` is present only where intended.
6. Verify all app tables/enums/functions are under `policytracker`.
7. Apply migration to local PostgreSQL.
8. Run schema placement query.
9. Run migration-related tests.
10. Document rollback or forward-fix strategy.

## Schema Placement Query

```sql
select table_schema, table_name
from information_schema.tables
where table_schema in ('public', 'policytracker')
order by table_schema, table_name;
```

## Reject If

- Any app business table is in `public`.
- Migration drops audit, attestation, or document version evidence without explicit approved migration plan.
- Migration creates broad cascade deletes on evidence tables.

## Output

- Migration file path.
- SQL review notes.
- Schema placement proof.
- Rollback note.
