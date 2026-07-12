# Command: /plan-phase

## Purpose

Expand one roadmap phase into small, verifiable tickets.

## Input

```text
/plan-phase <phase-number>
```

## Procedure

1. Read `AGENTS.md`.
2. Read `PLAN.md`.
3. Read `.ai/tasks/BACKLOG.md`.
4. Identify the phase goal and acceptance gate.
5. Split work into tickets sized for half-day to one-day agent work.
6. For each ticket, define acceptance criteria and tests.
7. Identify required agents and skills.
8. Update backlog only if the user asked to write files.

## Output

- Phase summary.
- Ticket list.
- Dependencies.
- Risks.
- Phase acceptance gate.

## Stop Conditions

Stop if the requested phase depends on an unapproved previous phase.
