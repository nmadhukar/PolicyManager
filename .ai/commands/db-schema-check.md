# Command: /db-schema-check

## Purpose

Prove PolicyManager database objects live in `policytracker`, not `public`.

## Procedure

Run against the active local database:

```sql
select table_schema, table_name
from information_schema.tables
where table_schema in ('public', 'policytracker')
order by table_schema, table_name;
```

Also inspect enums when applicable:

```sql
select n.nspname as enum_schema, t.typname as enum_name
from pg_type t
join pg_namespace n on n.oid = t.typnamespace
where t.typtype = 'e'
order by enum_schema, enum_name;
```

## Pass Criteria

- Application tables are in `policytracker`.
- Application enums are in `policytracker`.
- `public` has no PolicyManager business objects.

## Output

- Query results.
- Pass/fail.
- Any unexpected objects.
