# PolicyManager Documentation

This folder is the durable documentation home for PolicyManager.

Documentation is part of the Definition of Done. Any behavior change must update the appropriate docs or explain why no doc update was needed.

## Documentation Areas

- `developer/` - architecture, extension points, code conventions, and implementation notes.
- `user/` - user-facing workflow guides.
- `admin/` - administrator configuration and operations.
- `api/` - public API and integration documentation.
- `runbooks/` - deployment, backup, restore, and incident procedures.
- `adr/` - accepted architecture decision records.

## Rules

- Keep docs aligned with actual commands and behavior.
- Do not document commands before the scaffold creates them.
- Prefer task-focused user guides over abstract feature descriptions.
- Explain non-obvious developer contracts and extension points.
- Update docs in the same ticket that changes behavior.

## MCP and chat integrations

- [MCP API contract](./api/mcp.md): 107 tools, authentication, inputs, files, results and errors.
- [Hermes and bot setup](./admin/mcp-hermes.md): client configuration and credential lifecycle.
- [Chat workflows](./user/mcp-chat.md): policy, review and acknowledgment actions.
- [Developer guide](./developer/mcp.md) and [operations runbook](./runbooks/mcp.md): extension, verification, activation and rollback.
- [REST operation inventory](./api/mcp-route-inventory.md) and [tool schemas](./api/mcp-tools.json): all 116 current operations accounted for.
- [Accepted design](./superpowers/specs/2026-10-03-mcp-hermes-design.md) and [ADR-0004](../.ai/adr/0004-mcp-rest-adapter.md): architecture and approved boundaries.
- [MCP delivery tickets](../.ai/tasks/MCP_INTEGRATION.md): implementation boundaries, tests, documentation, rollback, and required completion evidence.
