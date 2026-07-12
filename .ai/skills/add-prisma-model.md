# Skill: Add Prisma Model

## Purpose

Add a Prisma model safely under the `policytracker` PostgreSQL schema.

## Use When

- A ticket requires new persisted data.

## Procedure

1. Confirm data model impact in the ticket.
2. Add only the models needed for this phase.
3. Use the `policytracker` schema strategy.
4. Generate migration.
5. Inspect generated SQL.
6. Verify live schema placement.
7. Add tests for constraints and behavior.
8. Update developer docs.

## Required Companion Skill

Use `.ai/skills/migration-safety.md`.
