# Command: /quality-check

## Purpose

Run a code quality review for the active ticket.

## Procedure

1. Read active ticket.
2. Inspect changed files.
3. Run or review tests.
4. Apply `.ai/skills/code-quality-review.md`.
5. Use these agents as applicable:
   - `code-quality-reviewer`
   - `backend-quality-reviewer`
   - `frontend-quality-reviewer`
   - `performance-reviewer`
6. Produce findings first.

## Pass Criteria

- No critical/high maintainability issues.
- No unclear ownership boundaries.
- No obvious N+1/unbounded query or payload risks.
- Non-obvious code has useful comments.
- Developer docs explain extension points where needed.

## Output

- Pass/fail.
- Findings.
- Required fixes.
- Optional improvements.
