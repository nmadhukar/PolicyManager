import { AgentOrchestrator } from './agent-orchestrator.service';
import { ContextBuilder } from './context-builder.service';
import type { AgentTool, ToolResult } from './agent-tool';
import type { RagConfigService } from '../rag-config.service';
import type { RetrievedChunk } from '../retriever.service';

describe('AgentOrchestrator', () => {
  const chunk = (): RetrievedChunk => ({
    documentId: 'doc-1',
    versionId: 'v-1',
    chunkId: 'c-1',
    chunkIndex: 0,
    content: 'Grounding passage.',
    score: 0.9,
    documentTitle: 'Policy',
    documentNumber: 'PP-1',
  });

  const searchTool = (chunks: RetrievedChunk[]): AgentTool => ({
    name: 'SearchPolicyDocuments',
    description: 'search',
    inputSchema: {},
    run: jest.fn(async (): Promise<ToolResult> => ({ chunks })),
  });

  const contextBuilder = () =>
    new ContextBuilder({ contextMaxChars: 8000 } as unknown as RagConfigService);

  it('exposes registered tool names — extension seam (AC1)', () => {
    const fakeSecondTool: AgentTool = {
      name: 'GetDocumentMetadata',
      description: 'x',
      inputSchema: {},
      run: jest.fn(async () => ({ chunks: [] })),
    };
    const orch = new AgentOrchestrator(
      [searchTool([]), fakeSecondTool],
      contextBuilder(),
    );
    // A newly-registered tool is discoverable without changing the orchestrator.
    expect(orch.toolNames()).toEqual(
      expect.arrayContaining(['SearchPolicyDocuments', 'GetDocumentMetadata']),
    );
  });

  it('runs the search tool and builds numbered context (AC3)', async () => {
    const orch = new AgentOrchestrator([searchTool([chunk()])], contextBuilder());
    const result = await orch.answerableContext('seclusion?', { user: { id: 'u' } as never });

    expect(result.chunks).toHaveLength(1);
    expect(result.context.empty).toBe(false);
    expect(result.context.contextText).toMatch(/\[1\] Policy \(PP-1\)/);
    expect(result.context.citations[0].index).toBe(1);
  });

  it('passes ctx through to the tool (ACL)', async () => {
    const tool = searchTool([]);
    const orch = new AgentOrchestrator([tool], contextBuilder());
    const ctx = { user: { id: 'u-42' } as never };
    await orch.answerableContext('q', ctx);
    expect(tool.run).toHaveBeenCalledWith({ query: 'q' }, ctx);
  });

  it('returns empty context for an empty query (AC5)', async () => {
    const tool = searchTool([chunk()]);
    const orch = new AgentOrchestrator([tool], contextBuilder());
    const result = await orch.answerableContext('   ');
    expect(result.context.empty).toBe(true);
    expect(result.chunks).toEqual([]);
    expect(tool.run).not.toHaveBeenCalled();
  });

  it('returns empty context when retrieval finds nothing (AC5/AC6)', async () => {
    const orch = new AgentOrchestrator([searchTool([])], contextBuilder());
    const result = await orch.answerableContext('nomatch', { user: { id: 'u' } as never });
    expect(result.context.empty).toBe(true);
    expect(result.context.contextText).toBe('');
    expect(result.context.citations).toEqual([]);
  });

  it('returns empty context when the search tool is not registered', async () => {
    const otherTool: AgentTool = {
      name: 'SomethingElse',
      description: 'x',
      inputSchema: {},
      run: jest.fn(async () => ({ chunks: [chunk()] })),
    };
    const orch = new AgentOrchestrator([otherTool], contextBuilder());
    const result = await orch.answerableContext('q', { user: { id: 'u' } as never });
    expect(result.context.empty).toBe(true);
    expect(otherTool.run).not.toHaveBeenCalled();
  });
});
