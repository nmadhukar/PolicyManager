import { Injectable } from '@nestjs/common';
import { RetrieverService } from '../retriever.service';
import type { AgentTool, ToolContext, ToolResult } from './agent-tool';

export interface SearchPolicyDocumentsInput {
  query: string;
  topK?: number;
}

/**
 * The one Phase-3 tool: semantic + full-text search over published policy
 * documents. Thin wrapper around {@link RetrieverService} — it exists so the
 * agent layer treats retrieval as a registered, LLM-describable capability (and
 * so more tools can be added the same way later).
 *
 * ACL: the caller's `ctx.user` is passed straight through to the retriever, so
 * results are limited to documents that user may view — the tool never widens
 * scope. Retrieval is gated (returns [] when RAG is unconfigured), so this tool
 * is safe to invoke unconditionally.
 */
@Injectable()
export class SearchPolicyDocumentsTool implements AgentTool<SearchPolicyDocumentsInput> {
  readonly name = 'SearchPolicyDocuments';
  readonly description =
    'Search the organization’s published policy and procedure documents for ' +
    'passages relevant to a question. Returns the most relevant document excerpts ' +
    'with their source. Use this to ground every answer in real policy text.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The natural-language search query.' },
      topK: { type: 'number', description: 'Optional max number of passages to return.' },
    },
    required: ['query'],
  };

  constructor(private readonly retriever: RetrieverService) {}

  async run(input: SearchPolicyDocumentsInput, ctx: ToolContext): Promise<ToolResult> {
    const query = (input?.query ?? '').trim();
    if (query.length === 0) return { chunks: [] };
    const chunks = await this.retriever.retrieve(query, {
      user: ctx.user,
      topK: input.topK,
    });
    return { chunks, data: { query, matches: chunks.length } };
  }
}
