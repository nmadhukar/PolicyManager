# MCP integration delivery tickets

Date: 2026-10-03

Status: PM-MCP-01 through PM-MCP-04 implemented and locally verified on feat/mcp-hermes. Production exposure remains opt-in and unperformed.

Product request: enable existing NestJS application actions and queries through MCP for Hermes Agent and bots, and document the complete integration.

Design: [MCP and Hermes integration](../../docs/superpowers/specs/2026-10-03-mcp-hermes-design.md).

Inventory: [116 REST operations](../../docs/api/mcp-route-inventory.md).

The user approved the written design, nine protocol exclusions and inline implementation with “go now approved” on 2026-10-03. The operational contract is docs/api/mcp.md. Local implementation evidence and explicit deployment checks are recorded below.

## Ticket: PM-MCP-01 - Complete REST tool contract

### Goal

Create stable, typed MCP tool definitions accounting for all current REST operations.

### Phase

MCP integration; contract and coverage slice, after design approval.

### Background

There are 116 operations, including six public read-only routes and two Swagger-excluded OnlyOffice routes. A Swagger-only completeness check would miss real routes.

### Scope

Explicit named registry, Swagger schema normalization/local-reference resolution, reviewed overrides, credential-specific catalogs, annotations, and coverage reconciliation against real Nest route metadata.

### Non-Goals

Transport activation, business-service changes, migrations, unrestricted request tools, authentication bootstrap in model tools.

### User Workflow

A client discovers understandable tools and their required inputs; future REST additions cannot silently escape coverage verification.

### Acceptance Criteria

- [x] Every REST operation has one mapping or an approved exclusion.
- [x] 107 operations are mapped under the approved scope; nine exclusions retain reasons and source references.
- [x] JWT catalog contains eligible user operations and health; API-key catalog contains eligible scoped v1 operations and health.
- [x] Schema references, nested DTOs, optional/required fields, enums, query coercion, and multipart overrides are correct.
- [x] Missing, duplicate, or stale method/path mappings fail verification.
- [x] Tool annotations are reviewed per operation for business-state mutation and retry safety.

### Data Model Impact

None.

### API Impact

Defines the new tool contract without changing existing REST routes.

### UI Impact

None.

### Security / RBAC Impact

Catalog selection and descriptions preserve distinct user permissions and API-client scopes. Runtime authorization is completed in PM-MCP-02.

### Audit Impact

None in this slice.

### Storage Impact

Defines file schemas only.

### Documentation Impact

- Developer docs: registry ownership, schema overrides, adding routes, and coverage reconciliation.
- User guide: deferred to PM-MCP-04 before phase closure.
- Admin/operator docs: deferred to PM-MCP-04.
- Code comments needed: exclusions, schema resolution, annotation semantics.

### Tests Required

- Unit: schema normalization, DTO mapping, deterministic tool names and descriptions.
- Integration: real controller metadata compared with registry and exclusions.
- E2E: deferred to PM-MCP-04.
- Negative: duplicate names, unsupported schema references, unknown/unmapped routes, missing fields, wrong identity catalog.

### Commands To Run

Use `npm.cmd` on Windows. After dependencies are installed: API Jest focused on `mcp`, with coverage of `mcp/**/*.ts`; root typecheck and lint. Record exact final commands and results below.

### Rollback Plan

Revert registry/coverage additions. No data or existing routes change.

### Agents / Skills

- Agents: implement inline unless user selects another method; review according to repository quality commands.
- Skills: task-planning, TDD, documentation-update, code-quality-review, verification-before-completion.

### Review Checklist

- [x] Scope stayed inside ticket; tests written first.
- [x] Authorization boundary and exclusions reviewed.
- [x] No schema migration or storage mutation.
- [x] Documentation/comments updated; commands recorded.

### Done Evidence

- Files changed: mcp.routes/catalog and exhaustive controller/schema tests; five existing DTO files corrected for Swagger completeness; generated catalog and inventory.
- Tests/commands run: focused real-SDK tests and live workflow acceptance; exact commands and counts appear in the implementation evidence below.
- Results: pass within the documented local verification boundary.
- Risks: gaps in Swagger metadata must be resolved, not silently accepted.
- Follow-ups: future controller/DTO changes must pass route and field reconciliation and regenerate the catalog.

## Ticket: PM-MCP-02 - Authenticated NestJS MCP transport and dispatch

### Goal

Run named tools through the existing REST security pipeline and retain MCP transport audit evidence.

### Phase

MCP integration; transport and authorization slice, after PM-MCP-01.

### Background

User actions need JWT-backed live RBAC; API clients must retain read-only scope/category restrictions. Direct service calls would skip controller security and validation.

### Scope

Tested official SDK dependency, feature-flagged stateless `/api/mcp` endpoint, identity-bound catalogs, fixed loopback REST dispatch, error translation, concurrency/timeout bounds, and supplemental immutable MCP audit records.

### Non-Goals

OAuth authorization server, dynamic client registration, API-key write scopes, new business actions, changed audit durability, new database objects, or deployment.

### User Workflow

A configured Hermes user can discover and invoke an authorized JSON-based action; a configured read-only bot cannot execute it.

### Acceptance Criteria

- [x] Enabled endpoint completes real SDK initialize/list/call/ping; disabled endpoint is unavailable.
- [x] Every request validates its identity; mixed credentials are rejected.
- [x] 401/403, token expiry, revoked keys, changed roles, ACLs, and ownership behave as the underlying REST API specifies.
- [x] Controller guards, ValidationPipe, interceptors, and throttling execute during dispatch.
- [x] Dispatch destination is server-established; redirects, arbitrary headers, and path/host injection cannot redirect credentials.
- [x] Concurrent users never share tokens, identity, responses, or catalog state.
- [x] MCP audit records use source=api, correct actor, original caller context, and sanitized status metadata.
- [x] No mutation retries; uncertain outcomes are explicit.
- [x] Origin enforcement and protocol-method/version handling meet the tested SDK/spec contract.

### Data Model Impact

Existing AuditEvent only; no migration. Do not introduce a new audit-source enum.

### API Impact

Adds `/api/mcp`; existing REST routes and public v1 read-only semantics stay intact.

### UI Impact

None.

### Security / RBAC Impact

Reuse JwtAuthGuard/AuthService and ApiClientsService with live checks, then re-enter existing REST guards. Never accept an actor ID or auth headers from tool arguments.

### Audit Impact

Additional immutable MCP records supplement domain events; original MCP network context is recorded without spoofable IP forwarding.

### Storage Impact

None beyond existing actions.

### Documentation Impact

- Developer docs: transport/dispatch/auth boundaries and audit attribution.
- User guide: explicit denied and uncertain outcomes, completed in PM-MCP-04.
- Admin/operator docs: feature flag and live credential expiry/rotation.
- Code comments needed: fixed destination, per-request identity, context loss on loopback, concurrency, no-retry contract.

### Tests Required

- Unit: credential selection, route serialization, failure translation, timeout/concurrency controls, safe audit metadata.
- Integration: real Nest guards/ValidationPipe and SDK client, identity separation, live roles and revoked-key behavior.
- E2E: JSON CRUD/action flows against disposable services in PM-MCP-04.
- Negative: 401/403/404/409/429, disallowed Origin, host/path injection, oversized/invalid JSON, conflicting auth, no mutation replay.

### Commands To Run

Focused API MCP unit/integration Jest with >=80% changed business-line coverage; root lint/typecheck/unit/build. Record exact final commands and results.

### Rollback Plan

Disable feature flag; revert MCP bootstrap/module wiring and SDK dependency. Keep REST endpoints and all historical rows.

### Agents / Skills

- Agents: inline implementation; repository backend/security review as applicable.
- Skills: TDD, documentation-update, rbac-proof, code-quality-review, verification-before-completion.

### Review Checklist

- [x] Scope/tests reviewed.
- [x] RBAC, ACL, API scope, audit attribution, Origin and destination security verified.
- [x] No migration and no public objects.
- [x] Docs/comments and command evidence recorded.

### Done Evidence

- Files changed: MCP config/guard/controller/service/dispatch/module/bootstrap, AppModule/main wiring, transport/dispatch tests.
- Tests/commands run: focused real-SDK tests and live workflow acceptance; exact commands and counts appear in the implementation evidence below.
- Results: pass within the documented local verification boundary.
- Risks: internal calls share a loopback throttler source; audit writes remain best-effort; HTTP auth is pre-provisioned, not OAuth.
- Follow-ups: actual Hermes/proxy/MinIO deployment acceptance remains external; see the runbook.

## Ticket: PM-MCP-03 - Multipart imports and binary exports

### Goal

Support existing upload/import and export actions without losing bytes or bypassing file safety.

### Phase

MCP integration; file transport slice, after PM-MCP-02.

### Background

Three REST endpoints consume multipart uploads; cover-page, document export, comparison export, and evidence binders return binary content.

### Scope

Strict base64 file input, correct multipart construction, manifest/bulk/ZIP import, bounded embedded PDF/ZIP resources, JSON and 204 result handling, request/response cap configuration.

### Non-Goals

Reading server filesystem paths, arbitrary URL fetches, source-byte mutation, new storage provisioning, public buckets, or unlimited in-memory batch transport.

### User Workflow

A bot uploads a file as a new immutable version or imports a batch; an authorized user exports complete PDF/ZIP evidence and can verify the returned bytes.

### Acceptance Criteria

- [x] All existing multipart field names, metadata, relative paths, and file array semantics are preserved.
- [x] Malformed base64 and aggregate/per-file limits fail before costly allocation/dispatch.
- [x] Existing extension validation and authorization still execute.
- [x] Successful upload creates a new immutable version with expected checksum; old bytes and rows remain.
- [x] Export resources carry intact bytes, MIME type, and sanitized filename; checksum/integrity assertions pass.
- [x] Authorized presigned URL responses remain short-lived and private.
- [x] 204 is successful; oversized post-action results report an uncertain/truncated-delivery outcome without automatic retry.
- [x] Default limits and proxy/parser overrides are documented and tested at their boundaries.

### Data Model Impact

None; existing document/import/version services own persistence.

### API Impact

File schemas/result resources in the MCP contract; REST routes are unchanged.

### UI Impact

None.

### Security / RBAC Impact

Uploads/exports re-enter protected REST routes; no new storage or filesystem access primitive.

### Audit Impact

Preserve domain upload/download/export audit; add safe MCP call metadata without file payloads.

### Storage Impact

Existing versioned private S3/MinIO keys and immutable checksum behavior.

### Documentation Impact

- Developer docs: multipart and binary conversion, memory bounds, content-size failure semantics.
- User guide: uploading attached files and using downloads, including batching limitations.
- Admin/operator docs: request/response caps and concurrency/proxy settings.
- Code comments needed: strict base64 validation, size checks before allocation, export completion boundaries.

### Tests Required

- Unit: encoding, multipart field mapping, boundary rejection, safe filename/MIME metadata, response conversion.
- Integration: real file interceptors and SDK binary resource transfer.
- E2E: MinIO version checksums, manifest/bulk/ZIP reports, PDF/ZIP integrity.
- Negative: invalid/unsupported files, missing manifest, wrong fields, oversized payloads, unauthorized uploads and exports, no source overwrite.

### Commands To Run

Focused MCP/file tests with coverage; relevant documents/imports/attestation/evidence regression suites; root lint/typecheck/build; live file e2e in PM-MCP-04.

### Rollback Plan

Disable MCP. Never delete created documents/versions/imports or exported evidence to undo the adapter.

### Agents / Skills

- Agents: inline implementation; repository storage/backend review as applicable.
- Skills: TDD, s3-storage-safety, documentation-update, code-quality-review, verification-before-completion.

### Review Checklist

- [x] File integrity and immutable history verified.
- [x] Memory/body/concurrency bounds and negative cases tested.
- [x] RBAC and private storage preserved; no migrations.
- [x] Docs/comments and command evidence recorded.

### Done Evidence

- Files changed: Multipart encoder/dispatch response handling, real interceptor tests, live import/export/checksum and immutable-version acceptance.
- Tests/commands run: focused real-SDK tests and live workflow acceptance; exact commands and counts appear in the implementation evidence below.
- Results: pass within the documented local verification boundary.
- Risks: base64 enlarges wire payloads; aggregate MCP caps may require splitting large REST-capable batches.
- Follow-ups: use the documented caps/client attachment encoder and decoder when connecting a bot host.

## Ticket: PM-MCP-04 - End-to-end proof and complete MCP documentation

### Goal

Verify the integration across representative business workflows and publish complete, accurate repository documentation.

### Phase

MCP integration; acceptance slice, after PM-MCP-01 through PM-MCP-03.

### Background

Tools being listed is insufficient evidence that users can perform protected application actions from a bot.

### Scope

Live SDK e2e across user and API-client flows, audit/storage assertions, full route reconciliation, Hermes configuration/smoke, CI verification path, developer/user/admin/API/runbook docs, accepted ADR and documentation index links.

### Non-Goals

Production deployment, secrets committed to configuration examples, unapproved database migrations, changing v1 scopes, or modifying unrelated UI/business behavior.

### User Workflow

An administrator configures a user-action connection or scoped read-only bot; users find policies and complete authorized work from chat, with documented errors and recovery.

### Acceptance Criteria

- [x] Real MCP initialize/discovery/call works against the production bootstrap configuration.
- [x] JWT create/upload/update/view/review/approve/acknowledge/delete/restore/version-restore workflows prove unchanged behavior.
- [x] All six API-client reads work with appropriate scopes; categories/confidential/deleted/unpublished content remain filtered.
- [x] Authorization, original MCP audit actor/network context, immutable attestations, and S3 checksums are asserted against live disposable services.
- [x] Registry covers all current routes or approved exclusions, with a regenerated human-readable mapping.
- [x] Root lint/typecheck/tests/build and >=80% changed business-line coverage have recorded command evidence.
- [x] Hermes shipped configuration is tested; any unavailable Hermes/service verification is clearly marked pending rather than passed.
- [x] API/developer/user/admin/runbook docs explain setup, credentials/expiry, tool names/schemas, workflows, limits, troubleshooting, concurrency, audit and rollback.
- [x] Documentation and code-quality checks have no unresolved critical/high findings.
- [x] No PolicyManager business objects were introduced in public; no migration is expected.

### Data Model Impact

Disposable integration fixtures in existing policytracker tables; no schema changes. Test teardown is restricted to isolated test data, and must not target live user data.

### API Impact

Documents tested MCP contract and unchanged v1 contract.

### UI Impact

None; chat/bot user guide added.

### Security / RBAC Impact

Proof across roles, ACLs, API-client scopes/category filters, expired/disabled/revoked identities, and concurrent users.

### Audit Impact

Live immutable evidence assertions; log/argument redaction checks.

### Storage Impact

Live private MinIO checksum/version/export proof in a disposable test environment.

### Documentation Impact

- Developer docs: `docs/developer/mcp.md`.
- User guide: `docs/user/chat-and-bots.md`.
- Admin/operator docs: `docs/admin/mcp-hermes.md`, `docs/runbooks/mcp.md`.
- API docs: `docs/api/mcp.md`, final route/tool inventory.
- Code comments needed: review previous slices against actual invariants.

### Tests Required

- Unit: all new business behavior with recorded coverage.
- Integration: controller/registry coverage and SDK/Nest interoperability.
- E2E: described user/API-key/file/audit workflows on isolated Postgres/MinIO services.
- Negative: RBAC/ACL/ownership/scope restrictions, malicious inputs, response limits, isolation and retry behavior.

### Commands To Run

Existing root scripts, using `npm.cmd` on this Windows host:

```powershell
npm.cmd ci
npm.cmd run prisma:generate
npm.cmd run build --workspace @policymanager/shared
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test -- --runInBand
npm.cmd run build
```

Select the final focused MCP coverage/e2e commands after their files exist. For existing root test argument forwarding, verify the selected workspace script accepts the option rather than assuming it. Run live tests only with explicit disposable services; do not apply migrations or seed a production database. Apply `.ai/commands/docs-check.md` and `.ai/commands/quality-check.md` and record their evidence.

### Rollback Plan

Disable MCP feature flag; retain existing REST/API/UI and all business history. Revert adapter and deployment configuration if necessary, with previous image retained.

### Agents / Skills

- Agents: inline implementation; quality/security review according to repository commands and selected execution method.
- Skills: documentation-update, code-quality-review, rbac-proof, verification-before-completion.

### Review Checklist

- [x] All implementation ticket criteria reconciled.
- [x] Tests, coverage, RBAC/audit/storage proof, docs and quality review recorded.
- [x] Unavailable checks explicitly listed.
- [x] Phase scope/risk review complete; production rollout is a separate unapproved operational step and was not attempted.

### Done Evidence

- Files changed: MCP module and tests, five Swagger DTO declarations, main/AppModule, SDK/AJV dependencies and lockfile, catalog/smoke scripts, dedicated MCP e2e command, CI/env/production Compose settings; API/developer/user/admin/runbook guides, indexes, ADR-0004, inventory, generated schemas, spec/plan/tickets.
- Results: all local adapter, full regression, live native PostgreSQL/S3-emulator and production-bootstrap SDK checks pass; see exact evidence below.
- Risks: static JWT headers require private renewal; loopback REST quotas are shared; audit persistence remains best-effort; timeout/disconnect cannot roll back committed actions. These are documented in the API/runbook.
- Follow-ups: remote CI with unchanged pgvector migrations and MinIO, actual Hermes connection, proxy limits and client attachment behavior before production activation. External conversion/OCR/OnlyOffice/RAG/email providers retain their existing separate acceptance tests.

## Planning artifact verification evidence

- `git rev-parse --show-toplevel`: `C:/Github/PolicyManager`; isolated checkout, no parent-root issue.
- `Get-ChildItem -Force` and `Get-ChildItem -Recurse .ai`: framework and existing application structure inspected.
- Controller source scan: 116 unique method/path operations in 24 controllers, 51 GET and 65 write operations.
- Independent Node verification: 116 inventory rows, nine exclusions, 100 JWT operations, six API-key operations, one shared health operation, three multipart routes, four binary export routes; every linked source line points at a route decorator.
- Local link verification: all 125 relative links in the four changed planning/documentation files resolved when checked.
- Template verification: all four tickets contain the 20 required template sections.
- `git diff --check`: clean for the tracked documentation change; Node verification additionally checked trailing whitespace in new untracked artifacts.
- `node --version`: v24.19.0. `npm.cmd --version`: 11.17.0. `node_modules` and `.env` are absent; Docker is not on PATH. No application dependency installation, migration, tests, or MCP smoke was performed in the planning stage.
- Documentation check: passes for proposal-only changes. Product behavior is unchanged, so operational user/admin guides remain delivery criteria rather than falsely advertising an available feature.
- Quality review: no application code changed. Design review explicitly identifies protocol exclusions, credential-boundary risks, loopback network attribution/throttling, bounded base64 memory, uncertain mutations, audit durability, and absent live-test infrastructure.

The preceding section is historical evidence from the planning stage. Implementation evidence follows and supersedes its environment/status observations.

## Implementation verification evidence (2026-10-03)

- Baseline: API 72 suites / 880 tests passed before implementation. Node 24.19.0 / npm.cmd 11.17.0.
- RED/GREEN: inline query optionality, nullable DTO string unions, open dictionary fields, all validated DTO fields, secret-returning tool warnings/config filters, and advertised oversized response cleanup were reproduced before corrections. Focused final run: 3 suites / 25 tests passed.
- `npm.cmd test --workspace @policymanager/api -- --runInBand mcp --coverage --collectCoverageFrom=mcp/**/*.ts --collectCoverageFrom=documents/dto/update-document.dto.ts --collectCoverageFrom=documents/dto/bulk-review-schedule.dto.ts --collectCoverageFrom=search/dto/upsert-saved-search.dto.ts --collectCoverageFrom=smtp/dto/update-smtp-config.dto.ts --collectCoverageFrom=evidence/dto/evidence-binder.dto.ts`: 25 tests pass; combined changed adapter/DTO coverage **97.47% lines, 93.72% statements, 84.48% branches**. MCP alone 97.15% lines. Thin Nest module/main wiring has no new business behavior; live AppModule and built-main smoke prove wiring instead of synthetic decorator tests. All five changed DTOs reach at least 96.42% lines.
- `npm.cmd test -- --runInBand`: full root run passed, API then 901 tests and web 28 files / 126 tests. After the final regressions/DTO corrections, `npm.cmd test --workspace @policymanager/api -- --runInBand` passed **75 suites / 905 tests**. Web was unchanged after its passing root run.
- `npm.cmd run lint`, `npm.cmd run typecheck`, `npm.cmd run build`: all workspaces pass after final code changes.
- `npm.cmd run mcp:catalog` and `npm.cmd run mcp:catalog -- --check`: **107 tools, nine exclusions**, generated documentation matches actual Swagger. Inventory reconciles all 116 operations and source references; controller metadata tests also reconcile permissions and scopes.
- `npm.cmd run test:e2e:mcp --workspace @policymanager/api` against disposable native PostgreSQL 16.15 at loopback and S3rver: **5 live tests pass**, no business-service mocks. Includes private bytes/checksums, review/approval/immutable attestations, view gating, wrong owners, PDF/ZIP exports, manifest/folder/ZIP imports, all six scoped public reads, category/confidential/draft/deleted filtering, live API revocation, immutable version restore and soft delete/restore. Fixtures cleaned up; no production data touched.
- Database proof: the required information_schema query found **32 policytracker tables and zero public tables**. Earlier PGlite + pgvector setup applied every unchanged migration successfully. Native workflow setup omitted the unused vector extension/index and used an array embedding column because a Windows pgvector build was unavailable; RAG was disabled. This proves document workflows and schema placement, not native vector retrieval. No repository migration/schema change.
- Built `apps/api/dist/main.js`, ordinary login outside tools and the shipped `scripts/mcp-smoke.mjs`: real SDK handshake/list/health/ping passed for a user JWT (24 eligible own-account tools with no coarse permissions) and documents-read API client (4 tools). Authenticated HEAD/GET both returned 405, matching current Hermes preflight behavior. Credentials were not logged; smoke fixtures were removed.
- One fresh read-only reviewer checked the whole change. Secret-rotation filter/warning and unfinished oversized-body cleanup findings were reproduced RED then fixed GREEN. Live proof was expanded for all six reads, visibility/ownership and imports/ZIP integrity. A DTO metadata reconciliation additionally exposed and corrected seven missing binder options. Required loopback quota documentation was checked missing then present. No critical/high findings remain; no deferred minors.
- Local services used only task-owned temporary directories and loopback ports; they are stopped after verification. Test logs reside under the local temporary directory with names `policymanager-mcp-*.log`, `policymanager-api-final.log`, `policymanager-full-test.log`, `policymanager-lint.log`, `policymanager-typecheck.log` and `policymanager-build.log`.
- Documentation/quality checks: API changes, credential/command/env setup, user/admin workflows, extension contracts, audit/retry/limits/rollback and non-obvious code comments are documented. Local link/source and whitespace checks are recorded at closure. No UI changes; no UI accessibility work needed for this backend ticket.

## Delivery rulings and external verification boundary

- Use the approved existing feature checkout, with no push/merge/deploy: work is reviewable locally; cost if isolation assumptions were wrong would be overlap with unrelated edits (initial checkout was clean).
- Use native PostgreSQL/S3-emulator acceptance plus full-migration PGlite proof locally because Docker/MinIO are unavailable; cost is that MinIO versioning and native vector integration still need the configured CI/deployment check. Production stack/configuration is unchanged.
- Use a dedicated CommonJS Jest MCP e2e command: the existing VM-modules option conflicts with the sanitizer dependency on Node24. Cost is that this suite does not validate dynamic PDF extraction workers; those retain separate tests.
- Do not claim Hermes/proxy/remote CI/external provider verification: SDK and current upstream configuration/source checks are the local interoperability evidence. Cost is a required deployment smoke before exposing production access.
- Shared loopback throttling documentation was graded as a required operational fix because aggregate 429 responses can affect otherwise-independent callers. It is now documented; no throttle bypass was introduced.

Reviewer-declined items were reconciled: the nine non-chat protocol exclusions are approved; new OAuth delegation, production rollout and unrelated pre-existing service defects remain outside this adapter. Actual Hermes/MinIO/proxy/native vector and remote CI/external provider checks are explicitly listed as rollout evidence. Ticket finalization is completed by this section rather than left as a proposal.

Closure: documentation verification passed for 179 relative links, 116 route-source links and all 116 inventory rows across 48 changed/new files; tracked and new-file whitespace checks are clean. Fresh quality review and required fixes are complete. Temporary API, PGlite/S3 and native PostgreSQL processes were stopped; reviewable work remains on feat/mcp-hermes.

## Repository integration authorization (2026-10-03)

The user's subsequent instruction, "merge with main and git push", authorizes committing this verified change, integrating it into `main`, and pushing `main` to `origin`. It supersedes the earlier local-only delivery ruling. Production deployment and MCP activation remain separate rollout steps. Re-run repository checks before integration and verify the pushed commit against the remote branch.

Pre-integration verification: `git fetch origin` found no divergence from the feature base. Fresh root `npm.cmd test -- --runInBand` passed all 75 API suites / 905 tests and 28 web files / 126 tests. Root lint, typecheck and build passed. The catalog freshness check verified 107 tools and nine exclusions; documentation checks passed for 179 relative links, 116 route-source links and 116 inventory rows across 48 files. `git diff --check` was clean. Logs: temporary `policymanager-merge-{test,lint,typecheck,build}.log` files.
