# Ticket: RAG-P6 — Performance, Caching, Security, Rate Limiting, Observability

## Goal

Production-harden the RAG chatbot: bound cost/latency and abuse (rate limiting +
caching), tighten security (final review of the whole RAG surface), and make it
operable (structured logging + metrics). No new user features — this is the
reliability/security/ops pass that makes Phases 1–5 shippable.

## Phase

RAG Phase 6 of 6 (final). Governed by ADR-0002.

## Background

Phases 1–5 built the full pipeline: embedding index, hybrid retrieval, agent
layer, grounded chat endpoint + conversation storage, and the React chat UI. This
phase adds the operational envelope around it.

## Scope

1. **Rate limiting**: apply a tighter per-user/per-IP throttle to `POST /rag/chat`
   (LLM calls are expensive) using the app's existing `@nestjs/throttler`
   (`ThrottlerModule` is already global). A dedicated, configurable limit
   (`RAG_CHAT_RATE_LIMIT`, `RAG_CHAT_RATE_TTL`) distinct from the generous global
   default.
2. **Caching**: an in-process, TTL-bounded cache for query embeddings (identical
   query string → reuse the embedding vector) to cut latency + OpenAI cost on
   repeated/near-repeated questions. Bounded size (LRU-ish), configurable TTL,
   gated. (Retrieval results themselves are user-scoped by ACL, so cache the
   embedding, not the retrieved rows.)
3. **Prompt optimization**: tighten the system prompt for token efficiency +
   faithfulness (e.g. concise citation instruction, explicit "quote don't
   paraphrase policy numbers"), and cap context to the most relevant chunks;
   confirm no regression in the prompt tests.
4. **Security review**: a written review of the full RAG surface (retrieval ACL,
   conversation ownership, prompt-injection posture, egress gating, PII in
   logs/audit, the OPENAI_API_KEY handling) with any fixes found. Confirm the key
   is never logged and never returned to a client.
5. **Structured logging**: consistent, PII-safe logs at the key seams (embed
   start/done/fail counts, retrieval latency, chat latency + grounded flag) using
   the Nest Logger; no message text / no chunk text / no key in logs.
6. **Monitoring/metrics**: a lightweight, dependency-free metrics surface — an
   authenticated `GET /rag/health` (or reuse the health module) reporting RAG
   config state (enabled, model, dims), embedding backlog counts
   (pending/failed), and basic counters. No new heavy infra.
7. **Tests** for the new behavior (rate-limit config, cache hit/miss/TTL, prompt
   regression, metrics endpoint, log-redaction where testable).

## Non-Goals

- No new chat features / no streaming.
- No external APM/Prometheus stack (keep it dependency-light; expose counters/
  health, don't add a metrics server).
- No distributed cache (Redis) — in-process is sufficient for this scale; note it
  as a future scale option.
- No model fine-tuning.

## User Workflow

Transparent to users. An operator gets: bounded chat cost (rate limit + embedding
cache), a health/metrics endpoint to see RAG status + embedding backlog, and
PII-safe logs to diagnose issues. A user hammering /rag/chat gets a 429 instead of
unbounded LLM spend.

## Acceptance Criteria

- [ ] AC1: `POST /rag/chat` enforces a dedicated throttle (configurable via
      `RAG_CHAT_RATE_LIMIT`/`RAG_CHAT_RATE_TTL`); exceeding it returns 429; the
      generous global default still governs other routes. (test: the @Throttle
      decorator/config is applied; a unit/e2e assertion of the limit)
- [ ] AC2: Query-embedding cache — the same query string within TTL reuses the
      cached vector (provider.embed called once), a different query misses, and
      entries expire after TTL / evict past max size. Gated + configurable.
      (unit test)
- [ ] AC3: Prompt optimization keeps all Phase 4 prompt guarantees (grounding,
      citations, no-source fallback, injection hardening) — the existing prompt
      tests still pass, plus any new efficiency assertions.
- [ ] AC4: Security review is written (a doc/section) covering ACL, ownership,
      injection, egress gating, key handling, PII-in-logs; every finding is fixed
      or explicitly accepted with rationale. A test asserts the OPENAI_API_KEY is
      never included in any RAG response/log path we control (e.g. config getters
      don't leak it into responses).
- [ ] AC5: Structured logs at embed/retrieve/chat seams contain NO message text,
      chunk text, or API key. (code review + a targeted test where feasible)
- [ ] AC6: A metrics/health surface reports RAG enabled/model/dims + embedding
      backlog (pending/failed counts). Authenticated. (test)
- [ ] AC7: No regression — full `apps/api` + `apps/web` suites stay green (modulo
      the two known pre-existing unrelated failures); app boots; build succeeds.
- [ ] AC8: `tsc`, `eslint`, tests pass in both workspaces.

## Data Model Impact

None (metrics read existing counts).

## API Impact

Tighter throttle on `POST /rag/chat`; a new authenticated `GET /rag/health` (or
extension of the health module) for RAG status/metrics. Swagger updated.

## UI Impact

None required (optional: surface a 429 "slow down" toast — the app's error
handling already maps statuses).

## Security / RBAC Impact

This IS the security-hardening phase. Rate limiting bounds abuse/cost; the review
confirms ACL/ownership/injection/egress/key-handling. Metrics endpoint is
authenticated and leaks no secrets.

## Audit Impact

None new (chat already audits). Optionally note rate-limit rejections in logs.

## Storage Impact

None. The embedding cache is in-process/ephemeral.

## Documentation Impact

- Developer docs: "Operations & hardening (Phase 6)" — rate limits, cache,
  metrics/health, logging, and the security-review summary.
- Ops docs: the health/metrics endpoint + env knobs.

## Tests Required

- Unit: embedding cache (hit/miss/TTL/eviction/gating), rate-limit config applied,
  prompt regression + efficiency, metrics service, key-not-leaked.
- Integration: metrics/health endpoint (authenticated); 429 on over-limit (if
  practical in the harness).
- Security: injection posture unchanged, egress gating, no-secret-in-response.

## Commands To Run

```
cd apps/api && npx tsc --noEmit && npm run lint && npm test
cd apps/web && npx tsc --noEmit && npm run lint && npx vitest run && npx vite build
# app boot + metrics endpoint check
```

## Rollback Plan

Each piece is independent and additive: revert the throttle decorator, the cache
(falls back to always-embed), the metrics route, or the log lines. `RAG_ENABLED`
still disables the whole feature.

## Review Checklist

- [ ] Rate limit applied to chat; 429 on excess.
- [ ] Embedding cache correct (hit/miss/TTL/evict) + gated.
- [ ] Prompt guarantees intact (tests green).
- [ ] Security review written; findings fixed/accepted.
- [ ] Logs PII/secret-free.
- [ ] Metrics/health authenticated, no secret leak.
- [ ] Both suites green; app boots; builds.

## Done Evidence

- Files changed:
  - NEW: `apps/api/src/rag/embedding-cache.service.ts` (+spec);
    `apps/api/src/rag/metrics/rag-metrics.service.ts` (+spec).
  - MODIFIED: `retriever.service.ts` (+spec) — cache lookup before embed;
    `rag-config.service.ts` (+spec) — cache/rate-limit getters; `prompts.ts`
    (+spec still green) — verbatim-numbers clause; `chat.service.ts` — PII-safe
    completion log; `rag-chat.controller.ts` (+spec) — @Throttle on /chat + GET
    /status; `rag.module.ts` — EmbeddingCache + RagMetricsService providers;
    `.env(.example)` — cache + rate-limit knobs; developer doc — security-review
    section.
- Tests/commands run: `tsc` (0); `eslint` (0); `jest` (683/684 — only the
  pre-existing azure-oidc env-bleed fails); API restart → all /api/rag routes
  incl. /status mapped, clean boot; live HTTP: /status 401 unauth; chat throttle
  proven (20×401 then 5×429 at the RAG_CHAT_RATE_LIMIT=20 boundary).
- Results:
  - AC1 ✓ (HTTP-proven): POST /rag/chat throttled — request 21 returns 429;
    global default still governs other routes; configurable via env.
  - AC2 ✓: embedding cache hit/miss/TTL/LRU-evict/disabled, gated; wired into
    RetrieverService (cache hit → provider.embed not called). Unit-tested.
  - AC3 ✓: prompt tightened (quote numbers/dates verbatim) with all Phase 4
    guarantees intact (prompt tests green).
  - AC4 ✓: security-review section written (9-row table, sign-off); the
    OPENAI_API_KEY-not-leaked test passes (metrics status excludes it).
  - AC5 ✓: chat logs outcome shape only (grounded, citation counts) — no message
    text / chunk text / key.
  - AC6 ✓: GET /api/rag/status (authenticated) reports enabled/model/dims +
    embedding backlog counts; unit-tested + 401 unauth verified.
  - AC7 ✓: full API suite 683/684 (1 pre-existing unrelated); app boots; both
    workspaces build.
  - AC8 ✓: tsc + eslint clean.
- Risks:
  - Accepted risk: enabling RAG sends chunk/query/question text to OpenAI
    (documented, gated, off by default).
  - In-process cache/rate-limit are per-instance; a multi-replica deployment
    would want a shared store (Redis) — noted as a scale follow-up.
- Follow-ups: shared cache/limiter for horizontal scale; a faithfulness eval set;
  optional streaming.
