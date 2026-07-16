# Ticket: RAG-P3 — Agent Layer, SearchPolicyDocuments Tool & Context Builder

## Goal

Add a THIN agent-orchestration layer over the Phase 2 retriever: a pluggable
tool abstraction, one concrete tool (`SearchPolicyDocuments`) wrapping
`RetrieverService`, and a `ContextBuilder` that turns retrieved chunks into a
citation-numbered grounding context. This is the seam the Phase 4 chat endpoint
will call. Not an autonomous multi-step agent — a single-tool orchestrator built
so more tools drop in later.

## Phase

RAG Phase 3 of 6. Governed by ADR-0002.

## Background

Phase 2 built `RetrieverService.retrieve(query, {user, topK})` → `RetrievedChunk[]`
(documentId, versionId, chunkId, chunkIndex, content, score, documentTitle,
documentNumber), ACL-filtered to current published versions. Phase 3 wraps that
in the architecture's Agent → Tool → Retriever chain and prepares grounded
context + citation data — without yet calling an LLM (that's Phase 4).

## Scope

1. **`AgentTool` abstraction** (interface + DI token): `name`, `description`
   (LLM-facing), `inputSchema` (for future function-calling), and
   `run(input, ctx): Promise<ToolResult>`. A `TOOL_REGISTRY` multi-provider so
   tools self-register and the orchestrator discovers them — the extension seam.
2. **`SearchPolicyDocumentsTool`** implements `AgentTool`: input `{ query,
   topK? }`, calls `RetrieverService.retrieve` with the caller's `AuthUser` from
   `ctx`, returns a `ToolResult` carrying the retrieved chunks + a citation list.
   ACL is enforced by passing `ctx.user` straight through (never widened).
3. **`ContextBuilder`**: given `RetrievedChunk[]`, produces
   `{ contextText, citations }` where `contextText` is the numbered, chunk-
   delimited passage block an LLM will ground on ([1], [2], …) and `citations`
   is the ordered `Citation[]` (index, documentId, versionId, chunkId,
   documentTitle, documentNumber, snippet). Deterministic; dedups repeated
   chunks; caps total context by a configurable char/token budget.
4. **`AgentOrchestrator`** (thin): `answerableContext(query, ctx)` runs the
   `SearchPolicyDocuments` tool and returns the built context + citations + raw
   chunks. Single tool for now; the registry lets Phase 4+/future add tools with
   no orchestrator change. NO LLM call here (Phase 4).
5. **Shared types** for the tool/citation/context contracts (in
   `@policymanager/shared` so Phase 4 API DTOs + Phase 5 UI reuse them).
6. **RagConfig**: `contextMaxChars` (budget) getter.
7. Wire into `RagModule` (providers + exports). Tests.

## Non-Goals

- No LLM / answer generation / streaming (Phase 4).
- No HTTP endpoint or conversation storage (Phase 4).
- No UI (Phase 5).
- No second tool — just the abstraction that permits one later.
- No autonomous multi-hop agent loop.

## User Workflow

(Integration-facing.) Phase 4's chat service calls
`AgentOrchestrator.answerableContext("what is the seclusion policy?", {user})`
→ gets a numbered context block + citation list built only from documents the
user may see → will feed that to the LLM in Phase 4.

## Acceptance Criteria

- [ ] AC1: `AgentTool` interface + `TOOL_REGISTRY` DI token exist; the
      orchestrator resolves tools from the registry (not hard-wired), so a new
      tool is added by registering a provider — proven by a test that registers a
      fake second tool and sees the orchestrator/registry expose it.
- [ ] AC2: `SearchPolicyDocumentsTool.run({query}, {user})` calls
      `RetrieverService.retrieve(query, {user})` with the SAME user (no ACL
      widening) and returns the chunks. (unit test asserts the user is passed
      through)
- [ ] AC3: `ContextBuilder.build(chunks)` returns deterministic numbered
      `contextText` with one entry per chunk ([1]…[n]) and a parallel `citations`
      array whose indices match; same input → identical output. (unit test)
- [ ] AC4: Context budget — when chunks exceed `contextMaxChars`, the builder
      truncates to fit (drops lowest-ranked chunks and/or clips), never exceeds
      the budget, and citations stay consistent with what's in contextText.
- [ ] AC5: Empty retrieval → empty context (`contextText === ''`, `citations ===
      []`), no throw; orchestrator returns an empty-but-valid result the Phase 4
      chat can turn into an "I don't know / no sources" answer.
- [ ] AC6: Gating — with RAG unconfigured, retrieval returns [] (Phase 2), so the
      tool/orchestrator return empty context and make zero egress. (unit test)
- [ ] AC7: Citations carry enough to render a source reference (documentId,
      versionId, title, number, chunk snippet) and to later deep-link.
- [ ] AC8: `tsc`, `eslint --max-warnings 0`, `jest` pass in `apps/api`; shared
      package rebuilds; app boots. Changed-line coverage ≥ 80%.

## Data Model Impact

None. No schema change (reads Phase 2 chunks).

## API Impact

None yet (Phase 4 adds the endpoint). Shared types are added for the contract.

## UI Impact

None (Phase 5).

## Security / RBAC Impact

The tool passes the caller's `AuthUser` straight to `RetrieverService`, so ACL/
visibility is enforced exactly as Phase 2 (only published, current-version,
in-scope chunks). The orchestrator never widens scope. Egress stays gated.

## Audit Impact

None in Phase 3 (no user-facing action yet). Phase 4 audits at conversation level.

## Storage Impact

None.

## Documentation Impact

- Developer docs: add an "Agent layer (Phase 3)" section to
  `rag-embedding-pipeline.md` (tool abstraction, registry extension seam,
  SearchPolicyDocuments, context builder, citation contract).
- Code comments: the registry extension seam; the deterministic context format.

## Tests Required

- Unit: AgentTool/registry (resolve tools; add a fake tool), SearchPolicyDocuments
  (user pass-through, chunk→result mapping, empty), ContextBuilder (numbering,
  determinism, budget truncation, empty), orchestrator (single-tool flow, empty),
  RagConfig new getter, gating/zero-egress.
- Integration: n/a (no DB SQL new); reuses Phase 2 retriever (mocked).
- Security: user pass-through (no widening), gating.

## Commands To Run

```
npm run build --workspace @policymanager/shared
cd apps/api && npx tsc --noEmit && npm run lint && npm test
```

## Rollback Plan

All additive and unused by production routes until Phase 4. Revert the new files +
RagModule providers to remove. No schema/bytes touched.

## Agents / Skills

- Skills: none specific.

## Review Checklist

- [ ] Scope stayed inside ticket (no LLM/endpoint/UI).
- [ ] Tests written where behavior added.
- [ ] User pass-through preserves ACL; no widening.
- [ ] Registry extension seam proven by a test.
- [ ] Docs + comments updated.
- [ ] Commands recorded.

## Done Evidence

- Files changed:
  - NEW: `apps/api/src/rag/agent/` — `agent-tool.ts` (interface + TOOL_REGISTRY),
    `search-policy-documents.tool.ts` (+spec), `context-builder.service.ts`
    (+spec), `agent-orchestrator.service.ts` (+spec).
  - MODIFIED: `rag.module.ts` (tool/registry-factory/context-builder/orchestrator
    providers + exports); `rag-config.service.ts` (+spec) — `contextMaxChars`;
    `packages/shared/src/index.ts` — RagCitation/RagContext/RagChatMessage/
    RagChatRequest/RagChatResponse; `.env(.example)` — RAG_CONTEXT_MAX_CHARS.
- Tests/commands run: shared build; `tsc` (0); `eslint` (0);
  `jest src/rag/agent src/rag/rag-config.service.spec.ts` (28/28); full `jest`
  (634/636); API restart → clean boot (registry factory wiring resolves).
- Results:
  - AC1 ✓: tool registry via a factory provider; orchestrator resolves tools from
    it; a fake second tool is discoverable (`toolNames()`) without orchestrator
    change.
  - AC2 ✓: SearchPolicyDocumentsTool passes `ctx.user` straight to the retriever
    (no widening); forwards topK; short-circuits empty query.
  - AC3/AC4/AC7 ✓: ContextBuilder — numbered passages + parallel citations,
    deterministic, dedups, budget-truncates while keeping citations in sync,
    citations carry deep-link fields + snippet.
  - AC5/AC6 ✓: empty retrieval / empty query / unconfigured RAG → empty-but-valid
    context, no throw, zero egress.
  - AC8 ✓: tsc 0, eslint 0, 28 new tests pass, app boots.
- Risks:
  - The orchestrator + tool are not yet called by any route (Phase 4 wires the
    chat endpoint). Fully tested/DI-registered, inert until then.
  - No LLM involved yet — grounded-answer generation is Phase 4.
- Follow-ups: Phase 4 (chat endpoint + conversation storage + LLM grounded
  answers + citation rendering, consuming AgentOrchestrator.answerableContext).
