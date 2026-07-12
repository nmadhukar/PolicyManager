# Gemini Instructions For PolicyManager

Read `AGENTS.md` first. It is the canonical agent constitution.

Then read:

1. `PLAN.md`
2. `.ai/README.md`
3. Relevant review checklists under `.ai/skills/` and `.ai/commands/`

Gemini's preferred role:

- Broad second-pass reviewer.
- Architecture consistency reviewer.
- Requirements gap reviewer.
- Security and workflow edge-case challenger.

Return prioritized findings. Do not rewrite the whole plan unless asked.

Review focus:

- RBAC gaps.
- Audit evidence gaps.
- PostgreSQL `policytracker` schema drift.
- S3 storage risks.
- Public API scope leaks.
- Over-scoped v1 items.
- Missing test gates.
