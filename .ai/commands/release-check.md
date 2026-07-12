# Command: /release-check

## Purpose

Verify production readiness before release.

## Procedure

1. Run full tests, including the coverage gate (fail if changed business-behavior lines are below 80 percent without a documented exception).
2. Run lint and typecheck.
3. Run build.
4. Run e2e smoke.
5. Verify database migration path.
6. Verify backup/restore runbook.
7. Verify S3 production settings.
8. Verify env var docs.
9. Verify no secrets are committed.
10. Verify release notes.

## Expected Commands After Scaffold

```bash
npm run lint
npm run typecheck
npm test -- --coverage
npm run test:e2e
npm run build
```

## Output

- Release pass/fail.
- Command evidence.
- Blockers.
- Deployment notes.
