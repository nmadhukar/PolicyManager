# Skill: Repo Cartography

## Purpose

Map the current checkout before making claims or edits.

## Use When

- Starting any task.
- After a context reset.
- When repo state seems unclear.
- Before implementation.

## Procedure

1. Confirm working directory.
2. Confirm git root.
3. List top-level files.
4. Locate package/build files.
5. Locate docs.
6. Locate tests.
7. Locate existing commands.
8. Identify dirty or unrelated changes.

## Suggested Commands

```bash
git rev-parse --show-toplevel
git status --short --branch
Get-ChildItem -Force
rg --files
```

## Output

- Repo root.
- Project shape.
- Relevant files.
- Existing commands.
- Risks or surprises.

## PolicyManager Specific Check

If git root is not `PolicyManager`, app scaffolding is blocked.
