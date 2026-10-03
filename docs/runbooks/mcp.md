# Operate PolicyManager MCP

## Activate

Deploy the normal API artifact and set these API environment values. `docker-compose-prod.yml` forwards them; no extra port, database object, storage policy or UI change is required.

| Variable | Default | Contract |
| --- | --- | --- |
| `MCP_ENABLED` | `false` | Only `true`/`false`; restart to apply |
| `MCP_ALLOWED_ORIGINS` | empty | Comma-separated exact HTTP(S) origins; Origin-less bots are allowed |
| `MCP_MAX_REQUEST_BYTES` | `16777216` | Positive integer, maximum `83886080` (80 MiB) |
| `MCP_MAX_RESPONSE_BYTES` | `16777216` | Positive integer, maximum `83886080` |
| `MCP_MAX_CONCURRENT_CALLS` | `4` | Per-process active dispatches, maximum 32 |
| `MCP_TOOL_TIMEOUT_MS` | `120000` | Positive integer, maximum 300000 |

Configure HTTPS through the existing reverse proxy. Preserve POST `/api/mcp`, authentication headers, Accept and MCP protocol-version headers. Do not rewrite the endpoint to the web UI or an HTML login page. Set body and request/idle timeouts to accommodate configured limits; for 50 MiB decoded uploads use an 80 MiB MCP/proxy request allowance. Ordinary REST JSON still has its existing 100 KiB limit, so a large JSON action can enter MCP but be rejected by the original REST parser. Multipart uses the existing file interceptors and limits.

Use the existing `TRUST_PROXY_HOPS` configuration for original client IP attribution. Do not add blanket proxy trust. Browser access needs both `MCP_ALLOWED_ORIGINS` and the application's explicit CORS allow-list. API credentials and user JWTs stay separate; see [Hermes configuration](../admin/mcp-hermes.md).

## Smoke and acceptance

Set `POLICYMANAGER_MCP_URL` and exactly one of `POLICYMANAGER_ACCESS_TOKEN` or `POLICYMANAGER_API_KEY` securely in the operator shell. Then run:

```bash
npm run mcp:smoke
```

The script uses the official SDK to initialize, list the filtered catalog, call health and ping. It prints a count and outcome without credentials or document content. HTTP is accepted only for loopback development; use HTTPS elsewhere. A GET browser visit returning 405 is expected, and is not a health check. Verify 404 with the feature disabled and 401 without a valid credential separately.

Before production acceptance, connect an actual Hermes installation, verify filtered discovery for a least-privilege user/API client, and complete a disposable draft action. Check proxy limits, downloads/export attachment handling and `mcp.tool.called` audit metadata. Local acceptance used native PostgreSQL 16.15 and an S3 emulator because Docker/MinIO and Hermes were unavailable. PGlite first verified the unchanged complete migrations with pgvector, but its serialized socket could not run the existing multi-connection sign-off transactions. Native test setup substituted an unused array embedding column and omitted the vector index with RAG disabled; no repository migration changed. CI runs unchanged migrations with pgvector PostgreSQL/MinIO. Its remote run, MinIO bucket-versioning checks, Hermes/proxy acceptance and external-provider checks remain deployment evidence.

## Live workflow tests

Use a **disposable** database and bucket. Start the repository's Docker Compose PostgreSQL and MinIO services, generate Prisma, then deploy the existing migrations. Set the environment from `.env.example`, with strong test-only secrets for `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `APP_ENCRYPTION_KEY` and `ONLYOFFICE_JWT_SECRET`. Typical local values are:

```dotenv
DATABASE_URL=postgresql://policy:policy@127.0.0.1:5433/policymanager?schema=policytracker
S3_ENDPOINT=http://127.0.0.1:9000
S3_PUBLIC_ENDPOINT=http://127.0.0.1:9000
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=minioadmin
S3_BUCKET=policymanager-mcp-e2e
S3_FORCE_PATH_STYLE=true
S3_AUTO_CREATE=true
MCP_ENABLED=true
NODE_ENV=test
THROTTLE_DISABLED=true
RAG_ENABLED=false
OCR_ENABLED=false
OIDC_ENABLED=false
```

```bash
docker compose up -d postgres minio
npm run prisma:generate
npm run prisma:deploy
npm run test:e2e:mcp --workspace @policymanager/api
```

The suite uses PDF source uploads, so Gotenberg/OnlyOffice/OCR/model services are unnecessary for its workflow. Mail remains disabled unless test configuration explicitly enables it. Do not target production data or enable production bucket/KMS changes for this test. Local `S3_AUTO_CREATE` uses the existing private/versioned bucket provisioning; the integration adds no storage administration semantics.

## Failure handling

| Symptom | Check/action |
| --- | --- |
| 404 at MCP | Feature flag/restart, API host/path and proxy routing |
| 401 | User JWT expiry/live enabled state or API-key revocation; refresh privately |
| HTTP 403 Origin | Exact origin in `MCP_ALLOWED_ORIGINS`; inspect ordinary CORS separately |
| Tool 403 | Permissions, API scopes, document/category ACL or ownership |
| InvalidParams | Exact grouped input schema from `tools/list`; no actor/URL/header arguments |
| 413 | MCP/proxy caps, REST JSON/file limits, encoded result overhead |
| 429 | Existing REST throttling or MCP active-call cap; pace calls per instance |
| 502/504 or uncertain outcome | Read current state and audit before any mutation retry |
| Audit write failure | Existing AuditService logs and database health; do not assume failed persistence means the action failed |

API status codes appear inside a successful JSON-RPC tool result; transport/auth/protocol failures are separate. No tool-body, result or credential logging is added. Monitor process memory and long-running exports: caps and concurrency are per API process and do not create a durable job queue. During timeout/disconnect, the original action may finish and commit. A process restart can also leave the caller uncertain.

Existing per-IP throttling runs at both MCP entry and the original REST route. Downstream dispatches share the loopback IP quota, so several independent MCP callers can collectively reach the REST limit and receive tool status 429 while staying below their own entry quota. Route-specific overrides also apply to that shared peer. Pace aggregate calls and inspect the original route's throttle settings before tuning; do not disable authentication throttles to mask this symptom. `MCP_MAX_CONCURRENT_CALLS` limits active work independently of request-rate quotas.

## Rollback

Set `MCP_ENABLED=false` and restart/redeploy the API. Existing REST/UI access and stored documents continue normally. Remove/revoke client credentials if access must end. There are no new migrations or data rewrites to reverse. Code rollback reverts the MCP module, bootstrap parser integration, dependencies, scripts and configuration forwarding as one change; retain the original normal REST parsers.
