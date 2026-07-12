# Command: /review-ticket

## Purpose

Review a completed ticket before it is accepted.

## Input

```text
/review-ticket <ticket-id>
```

## Procedure

1. Read ticket acceptance criteria.
2. Inspect changed files.
3. Check tests cover acceptance criteria.
4. Check RBAC/audit impact.
5. Check schema placement if migrations changed.
6. Check S3/public API behavior if relevant.
7. Run or review verification commands.
8. Produce findings first.

## Output Format

1. Findings by severity.
2. Open questions.
3. Test gaps.
4. Short summary.

## Stop Conditions

Stop if you cannot inspect the actual changed files.
