# PolicyManager MCP API

PolicyManager exposes its existing REST actions through authenticated MCP Streamable HTTP at `https://<api-host>/api/mcp`. Set `MCP_ENABLED=true` to activate it. The integration uses the official TypeScript SDK, pinned to 1.32.0, and requires no second server or port.

There are **107 named tools** covering 100 internal user operations, six public read-only API operations and shared health. All **116 existing REST operations** are accounted for in the [route inventory](mcp-route-inventory.md). The nine approved exclusions are login/refresh/logout/password recovery, Azure browser redirects/callback, and signed OnlyOffice source/save protocols. Use those protocols outside model tools. Password changes and editor configuration remain available to authorized users.

See [Hermes setup](../admin/mcp-hermes.md), [chat workflows](../user/mcp-chat.md), [developer maintenance](../developer/mcp.md), and the [operations runbook](../runbooks/mcp.md).

## Authentication and protocol

Supply exactly one credential on **every** HTTP request:

| Header | Identity | Available tools |
| --- | --- | --- |
| `Authorization: Bearer <access JWT>` | Live PolicyManager user | Internal tools allowed by current permissions, plus health |
| `X-Api-Key: <clientId.secret>` | Existing API client | Public v1 reads allowed by current scopes, plus health |

API keys must use `X-Api-Key` at the MCP endpoint. Unlike public REST v1, an API key in the Bearer header is not accepted here. Expired JWTs, disabled/locked users and revoked/disabled API clients return HTTP 401. Simultaneous credential mechanisms return 400. Authenticated callers with insufficient permission receive a tool error with status 403. Discovery is filtered; manually calling an undiscovered tool does not bypass authorization. Document/category ACLs and task/annotation/conversation ownership are rechecked by the original REST service.

This is a stateless, JSON-response transport. POST supports SDK initialize, notifications, ping, `tools/list` and `tools/call`. Clients send `Accept: application/json, text/event-stream`, JSON Content-Type, and the negotiated protocol-version header as required by their SDK. No session ID authenticates a caller. Authenticated GET/HEAD and DELETE return 405 with `Allow: POST`; there is no persistent event stream or session-delete operation. Disabled MCP returns 404. Browser Origins must exactly match `MCP_ALLOWED_ORIGINS`; absent Origin is supported for server clients. Browser clients also need the normal application CORS configuration.

## Tool arguments

The complete machine-readable contract is [mcp-tools.json](mcp-tools.json), generated from actual controller Swagger metadata plus reviewed overrides. Runtime `tools/list` is authoritative for the caller. Each tool takes only its declared groups: `path`, `query`, `body`, `files`. Do not send credentials, an actor ID, a destination URL or arbitrary headers in arguments.

```json
{
  "name": "documents_create",
  "arguments": { "body": { "title": "Infection prevention", "reviewCadence": "annual" } }
}
```

```json
{
  "name": "documents_get",
  "arguments": { "path": { "id": "document-id" } }
}
```

Path IDs accept letters, digits, `_` and `-`, up to 200 characters. Query values use their declared JSON types; arrays become repeated query keys. Unknown fields and malformed schemas produce JSON-RPC InvalidParams. Original Nest DTO validation remains authoritative for dates, lengths and business constraints. Optional bodies on action DTOs are represented as a required `body` group; pass `{ "body": {} }` where all DTO fields are optional.

## Files and results

Uploads accept complete, canonical, padded base64 bytes. No server filesystem path, data URL or remote fetch primitive is exposed.

```json
{
  "name": "documents_add_version",
  "arguments": {
    "path": { "id": "document-id" },
    "body": { "changeSummary": "Annual update" },
    "files": {
      "file": { "fileName": "policy.txt", "mimeType": "text/plain", "contentBase64": "UG9saWN5Cg==" }
    }
  }
}
```

Version upload uses `files.file`. Manifest import uses `files.manifest` with optional `files.files[]`; bulk import uses `files.files[]` and optional `body.relativePaths[]`. Import arrays are capped at 200 files. Every filename must be a basename with the existing supported extension; original interceptors still enforce actual file type and size. Total decoded file bytes across a call cannot exceed 50 MiB. The MCP JSON cap includes base64 overhead: the default 16 MiB cap carries less than 12 MiB of decoded data. To carry a 50 MiB file, raise the request cap to 80 MiB and align the proxy body limit.

JSON results have both `structuredContent` and text. Array/scalar structured results use `{ "value": ... }`; the text keeps the original JSON value. Empty REST success returns `{ "success": true, "status": 204 }` (or the actual empty-success status).

PDF/ZIP/other non-JSON responses are complete embedded resources: `content[].type = "resource"`, `resource.blob` is base64, and `resource.mimeType` identifies the format. Structured metadata supplies `fileName`, `mimeType`, and `sizeBytes`. Decode in the client and save or attach the bytes; do not treat the `policymanager://mcp/results/...` URI as a remotely downloadable URL. Original file downloads/view actions still return short-lived presigned URLs after authorization. The adapter does not follow those URLs or REST redirects. An expired URL must be requested again by an authorized caller.

Both upstream response bytes and encoded MCP result bytes are bounded. JSON duplication and base64 can make the delivered result exceed the limit even when the REST body fits. There is no silent truncation. Larger exports need an increased response cap within 80 MiB; use a dedicated client rather than printing base64 into chat.

## Failures, audit and retry

REST failures become `isError: true` with safe structured `{ "status", "message", "outcome" }`. Client errors use `outcome: "rejected"`. A write whose response times out, disconnects, redirects, fails after dispatch or exceeds the delivery cap uses **`outcome: "uncertain"`**. The original action may already have committed. Read the document, version history, assignment or audit trail before deciding whether to call again. **The adapter never retries a mutation automatically.** A disconnect stops waiting and attempts to cancel network work; it cannot undo a committed action.

Tool annotations are conservative: state-changing operations and editor credential issuance are marked non-read-only, destructive and non-idempotent. Read tools are marked read-only and idempotent; they may still produce access audit records. Annotations are client guidance, never authorization.

Existing domain audit events are retained. A supplemental immutable `mcp.tool.called` event records the user/API client, original peer IP/User-Agent, tool name, REST template, safe document/version identifiers, status and outcome. It never records tool bodies, file bytes, prompts, passwords, credentials or response content. The downstream domain event sees the loopback connection and its existing source label; correlate it with the MCP event by actor, target and time. Audit persistence retains the existing best-effort `AuditService` behavior; monitor its write-failure logs.
