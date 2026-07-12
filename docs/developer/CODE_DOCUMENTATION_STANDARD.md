# Code Documentation Standard

PolicyManager code should be understandable by developers who did not participate in the original AI session.

## Comment When It Explains Why

Add comments for:

- RBAC rules that protect sensitive document access.
- Audit evidence requirements.
- Document/version immutability.
- Review cadence date calculations.
- S3 key construction and presigned URL safety.
- OIDC identity linking and group-role mapping.
- Migration/schema safety.
- Cover page/export assumptions.
- Any workaround for a library or platform limitation.

## Do Not Comment Noise

Avoid comments that restate the code:

```ts
// Set user ID
user.id = id;
```

Prefer comments that explain contracts:

```ts
// Attestations must keep the signer's role as it existed at signing time,
// because later role changes must not alter survey evidence.
```

## Developer Documentation Requirement

If a developer must know a pattern to safely extend the feature, document it in `docs/developer/`, not only in code comments.

## Review Requirement

The documentation maintainer and code quality reviewer must check comments and developer docs before a ticket is accepted.
