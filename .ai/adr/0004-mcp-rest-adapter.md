# ADR: 0004 - Authenticated MCP over existing REST

## Status

Accepted by the user's “go now approved” scope/design instruction on 2026-10-03.

## Context

Hermes and bots need PolicyManager queries and actions while preserving internal RBAC, confidential-document ACLs, ownership, immutable versions, attestations and the read-only public API v1 contract. The application has 116 controller operations, including non-chat authentication/editor protocols.

## Decision

Expose opt-in stateless Streamable HTTP at `/api/mcp` using the official SDK. Maintain 107 explicit named route tools and nine approved protocol exclusions. Derive schemas from actual Swagger metadata with reviewed overrides; reconcile all real Nest routes, including Swagger-excluded ones, in tests. JWTs expose authorized internal actions; API keys expose only scoped v1 reads.

Dispatch to the original controller via fixed loopback HTTP and the actual listening port, preserving guards, pipes, file interceptors and service behavior. Bind identity per HTTP request, reject unapproved Origin, constrain inputs/files/responses/deadlines/concurrency, block redirects and never automatically replay a write. Add a supplemental audit event with original caller context and safe target metadata.

## Consequences

Positive:

- Existing REST authorization and domain behavior stay authoritative.
- Complete coverage is verifiable without silently exposing future endpoints.
- Hermes connects remotely without a separate MCP deployment or credential store.

Negative:

- Loopback adds HTTP overhead; original domain audits see the internal peer, so original client attribution is in the supplemental MCP event.
- Static headers need an external login/refresh broker. MCP OAuth discovery and a shared bot's per-human identity broker are outside this adapter.
- Base64/JSON duplication impose delivery overhead; timeout/disconnect cannot roll back committed actions.

## Alternatives Considered

- External proxy: another deployment/auth/audit boundary.
- Direct service wrappers: duplicate guard/validation/interceptor/access contracts.
- Generic URL/request tool: broader authority than the reviewed registry permits.

## Verification

Route/permission reconciliation, schemas, real SDK protocol tests, live PostgreSQL/S3 document workflows, no-retry/limit negatives, changed-line coverage, catalog freshness, root checks and a fresh independent review. Deployment acceptance additionally exercises Hermes, MinIO and the real proxy.

## Documentation Impact

[API](../../docs/api/mcp.md), [developer](../../docs/developer/mcp.md), [user](../../docs/user/mcp-chat.md), [admin](../../docs/admin/mcp-hermes.md), [runbook](../../docs/runbooks/mcp.md), route inventory and generated schema catalog.
