# Ticket: RAG-P5 — React Chat Page

## Goal

A polished, accessible chat page in the PolicyManager web app where an
authenticated user asks the policy chatbot questions and gets grounded answers
with clickable citations, backed by the Phase 4 endpoints. Conversation list +
thread continuation, loading/empty/error states, no streaming (deferred).

## Phase

RAG Phase 5 of 6. Governed by ADR-0002.

## Background

Phase 4 exposes `POST /api/rag/chat`, `GET /api/rag/conversations`,
`GET /api/rag/conversations/:id` (JWT). Shared types `RagChatRequest`,
`RagChatResponse`, `RagCitation`, `RagChatMessage` exist. The web app is React +
Vite + Tailwind + TanStack Query + a shared design system in
`apps/web/src/ui/`, with `states.tsx` (Loading/Empty/Error/Forbidden) and the
`AppShell` nav.

## Scope

1. **API client** (`apps/web/src/api/ragChat.ts`): `sendChat(message,
   conversationId?)`, `listConversations()`, `getConversation(id)` — using the
   app's existing axios client + types from `@policymanager/shared`.
2. **Chat page** (`apps/web/src/pages/ChatPage.tsx`): a conversation view
   (message bubbles: user vs assistant), a composer (textarea + Send), a
   conversation sidebar/list to switch threads + "New chat". Assistant messages
   render inline `[n]` citation markers and a sources list (title, number,
   snippet) that deep-links to the document detail page.
3. **State/UX**: TanStack Query for load; optimistic append of the user message;
   pending "thinking…" indicator; disabled send while in-flight; the grounded=false
   "no source" answer rendered clearly; keyboard: Enter to send, Shift+Enter
   newline. Loading/empty/error states via the shared `states` components.
4. **Routing + nav**: a `/chat` route + an AppShell nav entry (gated to
   authenticated users). Lazy-load the page (matches how heavy pages are split).
5. **Accessibility**: labeled controls, focus management, semantic roles for the
   message log (aria-live for new answers), sufficient contrast, keyboard-
   navigable. (AGENTS.md §10c.)
6. **Tests** (vitest + Testing Library, the web app's stack): API client, the
   chat page (send → renders answer + citations; empty/error states; ownership/
   auth handled by the API), citation rendering + deep-link.

## Non-Goals

- No streaming (SSE/websockets) — a single request/response per turn (Phase 6
  may add streaming).
- No admin/config UI for RAG.
- No new backend work (Phase 4 endpoints are complete).
- No changing the design system.

## User Workflow

An authenticated user opens "Chat" from the nav → asks "what is our seclusion
policy?" → sees their message, a "thinking…" state, then a grounded answer with
[1][2] markers and a Sources list linking to the cited documents. They start a
new chat or revisit a prior conversation from the sidebar.

## Acceptance Criteria

- [ ] AC1: `/chat` route renders the ChatPage for an authenticated user; a nav
      entry links to it. (component/route test)
- [ ] AC2: Sending a message calls `POST /api/rag/chat`, optimistically shows the
      user bubble, shows a pending indicator, then renders the assistant answer.
      (test with mocked API)
- [ ] AC3: Assistant answers render `[n]` markers and a Sources list (title,
      number, snippet); each source links to the document detail route. (test)
- [ ] AC4: The no-source answer (`grounded=false`) is rendered clearly (e.g. a
      muted "no policy source" note, no fake citations). (test)
- [ ] AC5: Conversation continuation — after the first turn, the returned
      `conversationId` is reused for the next send; the sidebar lists prior
      conversations and switching loads that thread. (test)
- [ ] AC6: Loading, empty (no conversations / no messages), and error states use
      the shared `states` components — never a blank or raw-error screen. (test)
- [ ] AC7: Accessibility — composer + send are labeled; the message log has an
      appropriate role/aria-live; Enter sends, Shift+Enter newlines. (test where
      practical + code review)
- [ ] AC8: `tsc`, `eslint`, and `vitest` pass in `apps/web`; `vite build`
      succeeds. Changed-line coverage ≥ 80% for the new code.

## Data Model Impact

None.

## API Impact

None (consumes Phase 4). Uses shared types.

## UI Impact

New `/chat` page + nav entry + message/citation components in the existing design
system. Loading/empty/error/forbidden states.

## Security / RBAC Impact

Page is behind the app's auth (authenticated users only). All authorization
(ACL-scoped sources, per-user conversations) is server-enforced by Phase 4; the
UI never bypasses it. Citations deep-link to documents the user already may see
(the document detail page enforces its own access).

## Audit Impact

None new (Phase 4 audits server-side).

## Documentation Impact

- User guide: a short "Ask the policy chatbot" entry (how to use /chat).
- Developer docs: note the UI consumes the Phase 4 endpoints (link).

## Tests Required

- Unit/component (vitest + Testing Library): API client, ChatPage send flow,
  citation rendering + deep-link, no-source rendering, conversation switching,
  loading/empty/error states, keyboard behavior.

## Commands To Run

```
cd apps/web && npx tsc --noEmit && npm run lint && npx vitest run && npx vite build
```

## Rollback Plan

Remove the `/chat` route + nav entry + new files. Additive; no other UI changed.

## Review Checklist

- [ ] Scope stayed inside ticket (no streaming/backend).
- [ ] Loading/empty/error/forbidden states present.
- [ ] a11y: labels, roles, keyboard, contrast.
- [ ] Citations deep-link correctly; no fabricated sources shown.
- [ ] tsc/lint/vitest/build green.
- [ ] Docs updated.

## Done Evidence

- Files changed:
  - NEW: `apps/web/src/api/ragChat.ts` (sendChat/listConversations/getConversation
    + local Conversation types); `apps/web/src/pages/ChatPage.tsx` (+spec).
  - MODIFIED: `apps/web/src/App.tsx` (/chat ProtectedRoute); `apps/web/src/ui/
    AppShell.tsx` (Chat nav entry + ChatIcon).
- Tests/commands run (independently re-verified): `tsc --noEmit` (0);
  `npm run lint` (0); `vitest run` (117/117, +8 ChatPage tests, no regressions);
  `vite build` (success); route + nav wiring confirmed by grep.
- Results:
  - AC1 ✓: /chat route renders ChatPage for authed users; nav entry present.
  - AC2 ✓: send → POST /rag/chat, optimistic user bubble + "Thinking…" then answer.
  - AC3 ✓: [n] markers → links to /library/:documentId; Sources list (title,
    number, snippet) deep-links. XSS-safe (React text children, no
    dangerouslySetInnerHTML).
  - AC4 ✓: grounded=false shows "No policy source found", no citations.
  - AC5 ✓: conversationId reused across turns; sidebar lists + switches threads.
  - AC6 ✓: loading/empty/error via shared states components.
  - AC7 ✓: role="log" aria-live, labeled composer/button, Enter/Shift+Enter.
  - AC8 ✓: tsc/lint/vitest/build all green.
- Risks:
  - No streaming (deferred to Phase 6/future) — answers appear all-at-once after
    the round trip; fine for the corpus size but a longer answer feels slower.
  - Conversation list/detail response types are local to ragChat.ts (not in
    shared) — acceptable; promote to shared if another client needs them.
- Follow-ups: Phase 6 (rate limiting, embedding cache, security review, logging,
  metrics); optional streaming.
