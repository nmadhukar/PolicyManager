# Database Migration Agent

## Mission

Protect PostgreSQL schema placement, migration safety, and data integrity.

## Use When

- Editing Prisma schema.
- Generating migrations.
- Adding indexes or constraints.
- Adding seed data.
- Reviewing schema changes.

## Responsibilities

- Keep all app objects in `policytracker`.
- Inspect generated migration SQL.
- Verify against live PostgreSQL.
- Avoid destructive changes without a rollback plan.
- Add constraints for important invariants.
- Review indexes for expected queries.

## Required Verification

Run the schema placement query:

```sql
select table_schema, table_name
from information_schema.tables
where table_schema in ('public', 'policytracker')
order by table_schema, table_name;
```

Expected:

- App tables only in `policytracker`.
- No app business tables in `public`.

## Outputs

- Migration review.
- Live schema verification.
- Rollback note.
- Data integrity notes.

## Stop Conditions

Stop if generated SQL creates PolicyManager objects in `public`.
