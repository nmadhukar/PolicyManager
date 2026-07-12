# Skill: Public API Contract

## Purpose

Keep `/api/v1` stable, read-only, scoped, documented, and audit-friendly.

## Use When

- Adding or changing API client behavior.
- Adding `/api/v1` endpoints.
- Adding search or extracted text access.

## Procedure

1. Define endpoint and response shape.
2. Define required API scope.
3. Define category/document scope behavior.
4. Define 401 and 403 behavior.
5. Add tests for valid, invalid, and under-scoped clients.
6. Add audit event.
7. Update Swagger/OpenAPI.
8. Confirm endpoint remains read-only.

## V1 Endpoints

```text
GET /api/v1/documents
GET /api/v1/documents/:id
GET /api/v1/documents/:id/content
GET /api/v1/documents/:id/download
GET /api/v1/documents/:id/versions
GET /api/v1/search?q=
```

## Output

- Endpoint contract.
- Scope.
- Test evidence.
- Swagger update.
- Audit proof.
