import type { AuthUser } from '@policymanager/shared';
import type { RetrievedChunk } from '../retriever.service';

/**
 * Execution context passed to every tool. Carries the caller's identity so tools
 * enforce the SAME ACL/visibility as the rest of the app (never widened).
 */
export interface ToolContext {
  user?: AuthUser;
}

/**
 * Result of running a tool. Kept generic: `chunks` are the retrieved sources
 * (empty for tools that don't retrieve), `data` is any tool-specific payload.
 * The orchestrator/context builder consume `chunks`; future tools may return
 * other `data`.
 */
export interface ToolResult {
  chunks: RetrievedChunk[];
  data?: Record<string, unknown>;
}

/**
 * A pluggable agent tool. The agent layer stays THIN — it is a registry of tools
 * the orchestrator can run, not an autonomous planner. Adding a capability later
 * (e.g. "GetDocumentMetadata", "ListCategories") means implementing this
 * interface and registering a provider under {@link TOOL_REGISTRY}; no
 * orchestrator change is required. `name`/`description`/`inputSchema` are shaped
 * for LLM function-calling in a later phase.
 */
export interface AgentTool<TInput = Record<string, unknown>> {
  /** Stable identifier the LLM/function-calling layer references. */
  readonly name: string;
  /** LLM-facing description of when to use the tool. */
  readonly description: string;
  /** JSON-schema-ish description of the tool's input (for function-calling). */
  readonly inputSchema: Record<string, unknown>;
  /** Execute the tool. MUST honor ctx.user for access control. */
  run(input: TInput, ctx: ToolContext): Promise<ToolResult>;
}

/**
 * Nest DI token for the multi-provider tool registry. Every AgentTool provider
 * registers under this token so the orchestrator injects the full set:
 *   { provide: TOOL_REGISTRY, useExisting: SearchPolicyDocumentsTool, multi: true }
 */
export const TOOL_REGISTRY = Symbol('RAG_TOOL_REGISTRY');
