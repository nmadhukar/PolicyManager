import { Inject, Injectable, Logger } from '@nestjs/common';
import type { RagContext } from '@policymanager/shared';
import type { RetrievedChunk } from '../retriever.service';
import { ContextBuilder } from './context-builder.service';
import { AgentTool, TOOL_REGISTRY, type ToolContext } from './agent-tool';

/** Result of gathering grounding context for a query. */
export interface AnswerableContext {
  context: RagContext;
  chunks: RetrievedChunk[];
}

const SEARCH_TOOL = 'SearchPolicyDocuments';

/**
 * Thin agent orchestrator (RAG Phase 3). It is deliberately NOT an autonomous
 * planner: for a query it runs the SearchPolicyDocuments tool and builds a
 * grounding context. The tool set is injected from the {@link TOOL_REGISTRY}
 * multi-provider, so adding a tool later is a registration — no change here.
 *
 * No LLM call happens in this phase; Phase 4's chat service feeds the returned
 * context to the model. Access control rides entirely on `ctx.user`, which the
 * tool passes to the retriever.
 */
@Injectable()
export class AgentOrchestrator {
  private readonly logger = new Logger(AgentOrchestrator.name);
  private readonly tools: Map<string, AgentTool>;

  constructor(
    @Inject(TOOL_REGISTRY) tools: AgentTool[],
    private readonly contextBuilder: ContextBuilder,
  ) {
    this.tools = new Map(tools.map((t) => [t.name, t]));
  }

  /** Names of the registered tools (extension seam is observable/testable). */
  toolNames(): string[] {
    return [...this.tools.keys()];
  }

  /**
   * Retrieve grounding context for `query` on behalf of `ctx.user`. Returns an
   * empty-but-valid context when nothing is found (or RAG is off), which the
   * chat layer turns into an honest "I don't have a source for that" answer.
   */
  async answerableContext(query: string, ctx: ToolContext = {}): Promise<AnswerableContext> {
    const q = (query ?? '').trim();
    const empty: AnswerableContext = {
      context: { contextText: '', citations: [], empty: true },
      chunks: [],
    };
    if (q.length === 0) return empty;

    const tool = this.tools.get(SEARCH_TOOL);
    if (!tool) {
      this.logger.warn(`Tool ${SEARCH_TOOL} is not registered; returning empty context.`);
      return empty;
    }

    const result = await tool.run({ query: q }, ctx);
    const context = this.contextBuilder.build(result.chunks);
    return { context, chunks: result.chunks };
  }
}
