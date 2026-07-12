# Command: /migrate

## Purpose

Create and verify Prisma/PostgreSQL migrations safely.

## Input

```text
/migrate <ticket-id>
```

## Procedure

1. Read active ticket data model impact.
2. Update Prisma schema for only the active ticket.
3. Generate migration.
4. Inspect generated SQL.
5. Confirm all app objects target `policytracker`.
6. Apply migration to local PostgreSQL.
7. Run schema placement query.
8. Run database tests.
9. Document rollback or forward-fix path.

## Required Query

```sql
select table_schema, table_name
from information_schema.tables
where table_schema in ('public', 'policytracker')
order by table_schema, table_name;
```

## Reject If

- App tables are created in `public`.
- Evidence tables are destructively changed without explicit approval.
- Rollback strategy is absent.
