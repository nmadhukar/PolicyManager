import { SearchPolicyDocumentsTool } from './search-policy-documents.tool';
import type { RetrieverService } from '../retriever.service';
import type { RetrievedChunk } from '../retriever.service';
import type { AuthUser } from '@policymanager/shared';

describe('SearchPolicyDocumentsTool', () => {
  const chunk = (): RetrievedChunk => ({
    documentId: 'doc-1',
    versionId: 'v-1',
    chunkId: 'c-1',
    chunkIndex: 0,
    content: 'policy text',
    score: 0.8,
    documentTitle: 'Policy',
    documentNumber: null,
    versionNumber: 1,
    effectiveDate: null,
    exactMatch: false,
    adjacent: false,
    sectionType: null,
    sectionIdentifier: null,
    normalizedSectionIdentifier: null,
    sectionTitle: null,
    headingPath: [],
    pageStart: null,
    pageEnd: null,
  });

  const makeRetriever = (chunks: RetrievedChunk[] = [chunk()]) =>
    ({ retrieve: jest.fn().mockResolvedValue(chunks) }) as unknown as RetrieverService;

  it('exposes an LLM-facing name/description/inputSchema (AC1)', () => {
    const tool = new SearchPolicyDocumentsTool(makeRetriever());
    expect(tool.name).toBe('SearchPolicyDocuments');
    expect(tool.description).toMatch(/policy/i);
    expect(tool.inputSchema).toMatchObject({ type: 'object', required: ['query'] });
  });

  it('passes the caller user straight to the retriever — no ACL widening (AC2)', async () => {
    const retriever = makeRetriever();
    const tool = new SearchPolicyDocumentsTool(retriever);
    const user = { id: 'u-7' } as AuthUser;

    const result = await tool.run({ query: 'seclusion' }, { user });

    expect(retriever.retrieve).toHaveBeenCalledWith('seclusion', { user, topK: undefined });
    expect(result.chunks).toHaveLength(1);
    expect(result.data).toMatchObject({ query: 'seclusion', matches: 1 });
  });

  it('forwards topK when provided', async () => {
    const retriever = makeRetriever();
    const tool = new SearchPolicyDocumentsTool(retriever);
    await tool.run({ query: 'q', topK: 3 }, { user: { id: 'u' } as AuthUser });
    expect(retriever.retrieve).toHaveBeenCalledWith('q', { user: { id: 'u' }, topK: 3 });
  });

  it('short-circuits an empty query without hitting the retriever', async () => {
    const retriever = makeRetriever();
    const tool = new SearchPolicyDocumentsTool(retriever);
    const result = await tool.run({ query: '   ' }, {});
    expect(retriever.retrieve).not.toHaveBeenCalled();
    expect(result.chunks).toEqual([]);
  });

  it('returns empty chunks when retrieval finds nothing (gating/AC6)', async () => {
    const retriever = makeRetriever([]);
    const tool = new SearchPolicyDocumentsTool(retriever);
    const result = await tool.run({ query: 'x' }, {});
    expect(result.chunks).toEqual([]);
  });
});
