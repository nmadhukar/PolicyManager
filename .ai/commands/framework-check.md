# Command: /framework-check

## Purpose

Verify the vibe coding framework itself exists and is internally connected.

## Procedure

1. Confirm `AGENTS.md` exists.
2. Confirm `CLAUDE.md` exists.
3. Confirm `GEMINI.md` exists.
4. Confirm `.ai/README.md` exists.
5. Confirm `.ai/agents/` exists and contains agent files.
6. Confirm `.ai/skills/` exists and contains skill files.
7. Confirm `.ai/commands/` exists and contains command files.
8. Confirm `.ai/tasks/` exists and contains task files.
9. Confirm `.codex/GLOBAL_RULES.md` exists.
10. Confirm `.agents/README.md` points to `.ai`.

## Suggested Commands

```bash
Get-ChildItem -Force
Get-ChildItem -Recurse .ai
Test-Path AGENTS.md
Test-Path CLAUDE.md
Test-Path GEMINI.md
```

## Output

- File inventory.
- Missing pieces.
- Next recommended action.
