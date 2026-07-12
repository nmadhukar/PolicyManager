# Skill: Code Quality Review

## Purpose

Review implementation quality beyond whether tests pass.

## Use When

- Closing any implementation ticket.
- Reviewing refactors.
- Reviewing code that developers will maintain.

## Procedure

1. Read the ticket acceptance criteria.
2. Inspect changed files.
3. Trace the main code path.
4. Check module boundaries.
5. Check naming and readability.
6. Check duplication.
7. Check error handling.
8. Check test quality.
9. Check performance risk.
10. Check code comments for non-obvious behavior.
11. Check developer docs for extension guidance.
12. Produce findings first.

## Review Questions

- Is the code easy to understand without chat context?
- Are business rules centralized in the right place?
- Is complexity justified?
- Are abstractions useful or premature?
- Are edge cases explicit?
- Are tests meaningful and maintainable?
- Would a new developer know how to extend this safely?

## Output

- Findings by severity.
- Refactor recommendations.
- Missing tests.
- Missing comments/docs.
- Residual risk.
