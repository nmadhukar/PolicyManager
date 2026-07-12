# PolicyManager Vibe Coding Framework

This directory contains the executable working framework for building PolicyManager with Claude, Codex, Gemini, or specialized AI agents.

Canonical files:

- `../AGENTS.md` - global constitution.
- `../PLAN.md` - product, architecture, and roadmap.
- `agents/` - role definitions.
- `skills/` - repeatable procedures.
- `commands/` - command-style workflows.
- `tasks/` - task templates, backlog, and gates.
- `reviews/` - review output location.
- `adr/` - architecture decision records.

## How To Use This Framework

1. Read `AGENTS.md`.
2. Read `PLAN.md`.
3. Pick the active phase from `tasks/BACKLOG.md`.
4. Create or select one ticket using `tasks/TASK_TEMPLATE.md`.
5. Choose the smallest set of agents needed.
6. Run the relevant skill procedure.
7. Verify with the relevant command procedure.
8. Record done evidence in the ticket.

## Phase 0 Status

Framework creation is allowed.

Application scaffolding is blocked until:

- The repository root is isolated to `PolicyManager`.
- The user approves Phase 0 framework/docs.

Do not scaffold NestJS, React, Prisma, or Docker Compose until that gate is passed.

## Directory Conventions

- Agent prompts are durable role contracts, not one-off chat prompts.
- Skills are step-by-step procedures.
- Commands are named workflows that agents can execute manually or automate later.
- Tasks are scoped work items with acceptance criteria and verification evidence.
