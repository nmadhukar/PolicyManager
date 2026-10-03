# PolicyManager MCP and Hermes integration design

Date: 2026-10-03

Status: approved by “go now approved” on 2026-10-03 and implemented on `feat/mcp-hermes`. Deployment remains opt-in (`MCP_ENABLED=false` by default). See the [operational API contract](../../api/mcp.md) and [delivery evidence](../../../.ai/tasks/MCP_INTEGRATION.md).

## Intended outcome

Users should be able to query PolicyManager and perform its existing application actions from Hermes Agent, other MCP clients, and bots, with the same permissions and document access rules as the REST API. The requested deliverable includes implementation, verification, and developer, user, administrator, and deployment documentation.

The current checkout is a NestJS/React monorepo with 116 REST operations in 24 controllers: 51 GET operations and 65 write operations. The [route inventory](../../api/mcp-route-inventory.md) accounts for every operation, including those requiring a non-chat protocol. The Git root is `C:/Github/PolicyManager`, rather than a parent directory. The earlier checkout path and greenfield statements in `PLAN.md` and `AGENTS.md` are historical; the existing applications and migrations are present. This proposal does not change the locked stack or the read-only public API v1 contract.

Approved scope:

- An action-capable connection represents one PolicyManager user. A dedicated bot can use a dedicated user account and its assigned roles; it cannot supply a different actor ID in tool arguments.
- API-client credentials remain read-only, with their existing scopes and category restrictions.
- Browser authentication redirects and signed OnlyOffice callbacks remain their existing protocols. They are fully inventoried, but are not general-purpose chat action tools.
- Approval covers this integration phase only. Production rollout remains a separate operational step.

## Approaches considered

| Approach | Benefits | Costs and risks |
| --- | --- | --- |
| External REST-to-MCP proxy | Little NestJS code; easy standalone deployment | Additional credential boundary, duplicate authentication configuration, audit attribution, and risk of generic arbitrary-URL tools |
| Direct NestJS service wrappers | In-process invocation and efficient service reuse | Wrappers can skip guards, validation, interceptors, throttling, and controller-specific checks; two behavior contracts to maintain |
| NestJS MCP adapter dispatching named tools through existing REST routes | One authorization and business-behavior contract; complete route coverage can be verified against Nest metadata | Internal HTTP dispatch needs fixed destinations, bounded bodies, timeout semantics, and an explicit MCP audit event |

Recommended: the third approach, using the official TypeScript MCP SDK. Hermes supports remote Streamable HTTP endpoints with configured authentication headers. Start with that transport; a second stdio transport is unnecessary for Hermes compatibility and would increase this phase's maintenance surface.

## Transport and lifecycle

Add `apps/api/src/mcp/` to the existing NestJS API, with a feature flag that defaults off. Expose one Streamable HTTP endpoint at `/api/mcp` when enabled. Use the SDK's stateless JSON-response transport, authenticating every request independently; do not retain user tokens in shared server state. Preserve the SDK's initialize, notification, protocol-version, tools/list, tools/call, and ping behavior. Session IDs must never become an authentication mechanism.

POST processes JSON-RPC requests; GET returns the SDK-compatible 405 response when no server event stream is offered. DELETE returns 405 for a stateless server. Account for Hermes's endpoint preflight in the connection example and smoke test, rather than assuming GET must open a persistent stream.

Reject unapproved browser Origin headers with 403. Origin-less server clients remain supported. Production uses the existing TLS reverse proxy; the adapter must not expose an extra unsecured port. The SDK owns protocol parsing and negotiation rather than a handwritten JSON-RPC implementation. Pin the tested SDK release through the lockfile and verify its compatibility with Node 20 and the repository's CommonJS/Jest toolchain.

Configuration contract: `MCP_ENABLED=false`, `MCP_ALLOWED_ORIGINS` as an explicit comma-separated allow-list, `MCP_MAX_REQUEST_BYTES=16777216`, `MCP_MAX_RESPONSE_BYTES=16777216`, `MCP_MAX_CONCURRENT_CALLS=4`, and `MCP_TOOL_TIMEOUT_MS=120000`. Validate positive bounded integers at startup, with request/response caps no greater than 80 MiB. A nonempty Origin not on the MCP allow-list is denied; an absent allow-list does not reflect arbitrary origins. Tests must prove the MCP parser cap applies independently of the existing REST JSON parser, without enlarging unrelated REST routes. The administrator can raise caps within the hard bound to carry a 50 MiB file; aggregate decoded file bytes must remain at most 50 MiB per call.

## Authentication and catalogs

| MCP request credential | Identity | Available REST-backed tools |
| --- | --- | --- |
| `Authorization: Bearer <user access JWT>` | Live PolicyManager `AuthUser` | 100 JWT-protected operations plus health, narrowed by declared permissions |
| `X-Api-Key: <clientId.secret>` | Live authenticated API client | Six public v1 operations plus health, narrowed by API scopes |
| Missing, invalid, expired, disabled, or revoked credential | None | HTTP 401; no protected discovery or execution |

Reject requests presenting both identity mechanisms to avoid ambiguous actor selection. A user JWT does not become a public API key, and an API key does not acquire user-action permissions. Check identity and roles/scopes again for every call. Permission-filtered discovery improves usability; downstream REST guards, ownership rules, and document/category ACLs remain authoritative even if a client manually invokes an undiscovered tool name.

Use existing local or Azure OIDC login to provision an access JWT outside the model conversation. Document access-token expiry and replacement; do not retain passwords or refresh tokens in MCP shared state. This initial integration uses pre-provisioned PolicyManager credentials. It must not claim to implement MCP OAuth discovery, dynamic registration, or delegated consent. Those would require a separate authentication design, including proper token audiences. Internal REST dispatch is restricted to this same PolicyManager resource server; tokens must never be forwarded to third-party origins.

## Tool contract and coverage

Use an explicit, reviewed mapping with a stable descriptive tool name for each eligible operation. Example names: `documents_list`, `documents_create`, `documents_update`, `documents_add_version`, `documents_restore_version`, `reviews_complete`, `acknowledgments_acknowledge`, and `public_documents_search`.

Derive parameter and body schemas from the application's Swagger document where complete, dereferencing local schemas for tools/list. Supply reviewed overrides for multipart files, inline request types, and any metadata gaps. DTO validation is still executed by the actual REST pipeline. Unknown arguments, missing path parameters, and invalid enum/type values must produce actionable errors before dispatch where possible. No unrestricted raw URL, HTTP method, header, actor ID, or REST path is accepted from tool arguments.

Group arguments under `path`, `query`, `body`, and `files` only when applicable. Path segments are encoded individually, and reserved characters cannot alter the route. Query values retain correct booleans, arrays, dates, and pagination semantics. Include descriptions explaining ownership, immutable versions, authorization prerequisites, and side effects.

Maintain a coverage test against actual Nest controller/route metadata, not only the Swagger paths: `DocumentsEditorController` is deliberately excluded from Swagger. Each existing REST method/path must have exactly one eligible tool mapping or a reviewed exclusion with a reason. Fail verification on unmapped routes, duplicate names, stale mappings, or unjustified exclusions. Snapshot the exported catalog and regenerate the human-readable inventory during implementation. Health has one mapping shared by both catalogs.

The approved scope has 107 eligible operations, and nine explicit exclusions:

- Five bootstrap credential operations: login, refresh, logout, forgot-password, reset-password. These remain documented REST procedures outside model-visible tools.
- Two Azure OIDC browser redirect/callback operations.
- Two OnlyOffice content/callback operations authenticated with purpose-scoped signatures. User operations for editor configuration, uploading Office files, and creating new HTML versions remain eligible tools.

The authenticated change-password operation remains eligible to honor existing user-action coverage. Its description must flag sensitive arguments; user/admin guides must explain that passwords and one-time API-client credentials returned by existing administrative operations can enter chat history. Never silently replace or redact a required one-time result without an explicit alternative delivery mechanism. Include credential-related tools in the documented Hermes filter examples so operators can omit them when appropriate.

MCP tool annotations describe real behavior. Mutations must have `readOnlyHint: false`. Do not infer read-only or retry safety solely from the HTTP verb: signed editor-config issuance and expensive exports require individual review, and ordinary reads also write access audit events. Only classify a tool as read-only when it leaves business state unchanged. Annotation hints and Hermes filters are not authorization checks.

## Dispatch and authorization preservation

Route calls through the application's existing HTTP adapter using a server-established loopback destination and port after startup. Never derive the destination from request Host/forwarded headers or tool arguments. Reject redirects and never forward credentials to another origin. Keep route allowlists and argument encoding independent of any client-provided URL.

The downstream request includes only its bound identity credential, the correct content type, and an identifiable MCP user-agent. The existing Nest guards, global ValidationPipe, per-route DTO handling, file interceptors, file-type checks, ACL services, ownership checks, audit writes, and rate limits execute normally. Do not call controllers or services directly to bypass that pipeline.

Internal dispatch changes the downstream socket peer to loopback. Preserve the actual MCP caller's original IP and user agent in the **additional MCP audit event** captured at the authenticated entry endpoint. Do not trust a client-supplied IP or elevate `TRUST_PROXY_HOPS` merely to hide the loopback hop. Documentation must distinguish the transport audit record from any existing business event containing the downstream network context. Existing acknowledgment rules still require a view and create immutable version-specific attestations.

Authentication or permission changes between entry and dispatch must fail closed. Throttle the MCP entry endpoint and bound concurrent dispatches; account for the existing per-IP throttler also seeing a shared loopback source. Document the effective combined limits instead of disabling throttling globally.

## Files and responses

Uploads use file objects containing `fileName`, `mimeType`, and strictly validated `contentBase64`. Convert these into multipart field names already expected by controllers (`file`, `manifest`, `files`, `relativePaths`). Support version uploads, CSV manifest import, bulk file import, and ZIP import. Reject malformed base64, forbidden fields, and aggregate payload limits before allocation/dispatch. Do not read arbitrary server filesystem paths or fetch arbitrary file URLs.

Apply a configurable total MCP request/response cap and a concurrent-request bound, with conservative defaults. Individual files must still obey the REST 50 MiB cap and supported extension rules. Large imports may require splitting batches: aggregate MCP limits are a documented transport constraint, not a claim of byte-for-byte capacity equivalence with 200 REST uploads. Tune the proxy and parser caps together. State the actual configured values in the final operator guide and test exact boundary behavior.

JSON results provide structuredContent plus a readable text representation. Preserve pagination and returned IDs. Empty 204 responses become a successful empty result. PDF and ZIP exports use a bounded embedded MCP resource with MIME type, filename, and complete base64 bytes; downloads that already return an authorized short-lived presigned URL retain that contract. Do not make an S3 bucket public or mutate a source version to package an export.

REST 400, 401, 403, 404, 409, 413, and 429 responses become structured tool failures with status and actionable safe messages. Entry authentication failures remain HTTP 401. Invalid tool names/arguments use SDK protocol errors. Do not expose stack traces, server configuration, credentials, or request bodies in errors.

Timeouts, cancellation, disconnects, or oversized responses after a mutation may leave an uncertain outcome. Return that distinction and the route/tool identity. Never automatically retry a mutation or falsely report rollback. Guides must explain checking the affected document, task, or import report before another call. Sensitive results and presigned URLs must not be stored in diagnostic logs.

## Audit and persistence

Add immutable `mcp.tool.called` audit records with `source=api`, the resolved `actorUserId` or `apiClientId`, original network context, tool name, method, sanitized route template, result status, and safe relevant document/version identifiers. Record successes, authorization denials by known actors, validation failures, and uncertain outcomes. Do not log raw arguments, document text, signatures, uploaded bytes, secrets, or entire results. Anonymous entry failures cannot claim a resolved actor.

Existing domain audit events remain in place. AuditService currently makes writes best-effort and defaults to `source=web`; the adapter must explicitly supply `source=api` for its transport record and document the existing best-effort persistence limitation. Do not silently introduce a new durability promise or schema enum. No Prisma migration is expected for this phase; all existing database objects remain in `policytracker`.

## Documentation deliverables

- `docs/api/mcp.md`: transport contract, tool discovery, complete eligible mapping/exclusions, JSON/multipart/binary examples, authentication, errors, and limits.
- `docs/developer/mcp.md`: module boundaries, registry/schema maintenance, REST pipeline preservation, audit attribution, tests, adding routes, and SDK upgrade procedure.
- `docs/user/chat-and-bots.md`: find/read a policy, create a document/version, review, approve/publish, acknowledge, restore, and interpret denied/uncertain calls.
- `docs/admin/mcp-hermes.md`: distinct user/bot accounts, role assignment, scoped read-only keys, credential storage/rotation, Hermes configuration and tool filters.
- `docs/runbooks/mcp.md`: feature flag, reverse proxy/body limits, deployment smoke, health and rate limits, audit inspection, disable/rollback, and troubleshooting.
- README and documentation index links; accepted architecture record after design approval. Never describe this proposal as a running feature.

The shipped Hermes configuration is documented in the [administrator guide](../../admin/mcp-hermes.md). Its core remote transport settings are:

```yaml
mcp_servers:
  policymanager:
    url: "https://policymanager-api.example.com/api/mcp"
    headers:
      Authorization: "Bearer ${POLICYMANAGER_ACCESS_TOKEN}"
    timeout: 150
    supports_parallel_tool_calls: false
```

For a read-only bot, replace the Authorization header with `X-Api-Key: "${POLICYMANAGER_API_KEY}"`. Keep credential values in the Hermes profile's secret scope, never in committed examples. Current Hermes accepts a POST-only endpoint's authenticated GET/HEAD 405 during preflight; no custom skip option is needed. The operator guide includes final registry names, restrictive filters and access-token renewal. Tool filters supplement server RBAC.

## Verification and acceptance

Implementation follows the [MCP tickets](../../../.ai/tasks/MCP_INTEGRATION.md), using failing tests before business behavior. All changed business-behavior lines require at least 80 percent coverage; record any thin wiring exception explicitly rather than ignoring coverage.

Required evidence:

1. Real SDK client handshake, tools/list, tools/call, notification, and shutdown against the Nest endpoint.
2. Exhaustive method/path coverage against controller metadata, including Swagger-excluded routes.
3. JWT action flows: create document, upload a version, metadata update, view/download, complete owned review, approval/publication, assignment and acknowledgment, soft delete/restore, and immutable version restore.
4. Read-only API-key flows covering all six v1 operations, scope/category restrictions, disabled/revoked credentials, and denial of action tools.
5. Negative RBAC/ACL/ownership/input tests, two simultaneous identities without leakage, token expiry and live permission changes, origin/host/path attacks, and fixed-destination dispatch.
6. Multipart manifest/bulk/ZIP handling, binary PDF/ZIP integrity, 204 handling, response/request boundaries, throttling, and timeout outcomes without mutation retries.
7. Audit proof with the correct actor, original MCP caller context, safe metadata, and existing domain events.
8. Root lint/typecheck/unit/build checks, focused coverage, live Postgres/MinIO integration tests, and a Hermes connection smoke using the shipped configuration.

Implementation installed the dependencies and generated Prisma/shared artifacts using `npm.cmd` (PowerShell blocks `npm.ps1`). Local protocol and native PostgreSQL/S3-emulator acceptance evidence is recorded in the [tickets](../../../.ai/tasks/MCP_INTEGRATION.md). Docker/MinIO and Hermes were unavailable locally; CI now includes unchanged pgvector migrations and an explicit MinIO-backed MCP workflow check. Remote CI, actual Hermes and production proxy acceptance remain rollout checks.

## Rollback and completion boundary

Keep MCP disabled until checks pass. Rollback disables the MCP feature flag and removes/reverts the adapter/bootstrap wiring and tested SDK dependency; existing REST/API/UI behavior and database rows remain intact. Never delete documents, versions, audit records, or attestations during rollback.

Completion means code and documentation are present, relevant checks have fresh command evidence, route coverage is reconciled, security/audit behaviors are proved, and any infrastructure-dependent checks are explicitly reported. Design approval alone is not implementation completion. Production exposure is not authorized by this proposal.

## Primary references

- [Hermes MCP configuration](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference): remote URL/header configuration, environment secret references, tool filtering, endpoint preflight, and concurrency controls.
- [Hermes MCP guide](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp).
- [Official TypeScript MCP SDK server guide](https://ts.sdk.modelcontextprotocol.io/server): Streamable HTTP and stateless JSON transport.
- [MCP 2025-11-25 transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports): Origin validation and protocol lifecycle.
- [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization): requirements applicable to a future OAuth-secured integration.
