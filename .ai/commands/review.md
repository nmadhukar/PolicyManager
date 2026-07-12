# Command: /review

## Purpose

Run a review pass over a ticket, branch, or PR.

## Input

```text
/review <ticket-or-pr>
```

## Procedure

1. Read the task or PR scope.
2. Inspect changed files.
3. Run or review verification commands.
4. Invoke code reviewer.
5. Invoke security reviewer if auth, RBAC, audit, storage, API, or secrets changed.
6. Invoke code quality reviewers when implementation changed.
7. Invoke documentation maintainer when behavior changed.
8. Return findings first.

## Output

- Findings by severity.
- Test gaps.
- Documentation gaps.
- Residual risk.
