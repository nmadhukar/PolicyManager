import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ChatService } from './chat.service';
import type { ChatLlmProvider } from './chat-llm-provider';
import type { AgentOrchestrator } from '../agent/agent-orchestrator.service';
import type { RagConfigService } from '../rag-config.service';
import type { AuthUser, RagContext } from '@policymanager/shared';

describe('ChatService', () => {
  const USER = { id: 'u-1', name: 'Ada' } as AuthUser;

  const groundedContext: RagContext = {
    contextText: '[1] Seclusion Policy (PP-42)\nSeclusion is a last resort.',
    citations: [
      {
        index: 1,
        documentId: 'd1',
        versionId: 'v1',
        chunkId: 'c1',
        documentTitle: 'Seclusion Policy',
        documentNumber: 'PP-42',
        versionNumber: 1,
        effectiveDate: null,
        sectionIdentifier: null,
        sectionTitle: null,
        pageStart: null,
        pageEnd: null,
        snippet: 'Seclusion is a last resort.',
      },
    ],
    empty: false,
  };
  const emptyContext: RagContext = { contextText: '', citations: [], empty: true };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const makePrisma = (): any => ({
    ragConversation: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'convo-1' }),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    ragMessage: {
      createMany: jest.fn().mockResolvedValue({ count: 2 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
  });

  const makeAudit = () => ({ record: jest.fn().mockResolvedValue('ae-1') });

  const makeOrchestrator = (context: RagContext): AgentOrchestrator =>
    ({ answerableContext: jest.fn().mockResolvedValue({ context, chunks: [] }) }) as unknown as AgentOrchestrator;

  const makeLlm = (over: Partial<ChatLlmProvider> = {}): ChatLlmProvider => ({
    isConfigured: jest.fn().mockReturnValue(true),
    model: 'gpt-4o-mini',
    complete: jest.fn().mockResolvedValue('Seclusion is a last resort [1].'),
    ...over,
  });

  const makeConfig = (): RagConfigService =>
    ({ chatHistoryTurns: 6 }) as unknown as RagConfigService;

  const build = (prisma: unknown, orchestrator: AgentOrchestrator, llm: ChatLlmProvider, audit = makeAudit()) =>
    new ChatService(prisma as never, audit as never, makeConfig(), orchestrator, llm);

  it('grounded path: calls the LLM with context and returns a cited answer (AC3)', async () => {
    const prisma = makePrisma();
    const llm = makeLlm();
    const svc = build(prisma, makeOrchestrator(groundedContext), llm);

    const res = await svc.chat({ message: 'seclusion?' }, USER);

    expect(llm.complete).toHaveBeenCalled();
    // The prompt the LLM saw includes the context + system instruction.
    const messages = (llm.complete as jest.Mock).mock.calls[0][0];
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toMatch(/untrusted/i); // injection hardening present
    expect(messages.at(-1).content).toContain('Seclusion is a last resort.');
    expect(res.grounded).toBe(true);
    expect(res.answer).toContain('[1]');
    expect(res.citations).toHaveLength(1);
    expect(res.conversationId).toBe('convo-1');
    // Persisted both turns + audited.
    expect(prisma.ragMessage.createMany).toHaveBeenCalled();
  });

  it('no-source path: warm conversational reply, grounded=false, NO citations', async () => {
    const prisma = makePrisma();
    // Conversational reply for a greeting / off-topic message.
    const llm = makeLlm({
      complete: jest.fn().mockResolvedValue("Hi! I'm the policy assistant — ask me about a policy."),
    });
    const svc = build(prisma, makeOrchestrator(emptyContext), llm);

    const res = await svc.chat({ message: 'Hey' }, USER);

    // The conversational path DOES call the LLM (with the conversational system prompt).
    expect(llm.complete).toHaveBeenCalled();
    const messages = (llm.complete as jest.Mock).mock.calls[0][0];
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toMatch(/did not match any/i); // conversational prompt
    expect(res.grounded).toBe(false);
    // CRITICAL: an ungrounded reply must carry NO citations (no misleading sources).
    expect(res.citations).toEqual([]);
    expect(res.answer).toMatch(/policy assistant/i);
    expect(prisma.ragMessage.createMany).toHaveBeenCalled();
  });

  it('no-source path falls back to the static answer if the conversational LLM errors', async () => {
    const prisma = makePrisma();
    const llm = makeLlm({ complete: jest.fn().mockRejectedValue(new Error('down')) });
    const svc = build(prisma, makeOrchestrator(emptyContext), llm);

    const res = await svc.chat({ message: 'Hey' }, USER);
    expect(res.grounded).toBe(false);
    expect(res.citations).toEqual([]);
    expect(res.answer).toMatch(/don't have a policy source/i);
  });

  it('grounded context but the model DECLINES (refusal, no [n]) → warm reply, no citations', async () => {
    const prisma = makePrisma();
    // The model explicitly declines — a genuine non-answer, not a forgotten marker.
    const llm = makeLlm({
      complete: jest
        .fn()
        .mockResolvedValueOnce('I could not find that covered in the provided sources.') // refusal
        .mockResolvedValueOnce("Hi! Ask me about a policy and I'll help."), // conversational retry
    });
    const svc = build(prisma, makeOrchestrator(groundedContext), llm);

    const res = await svc.chat({ message: 'Hey' }, USER);

    expect(res.grounded).toBe(false);
    expect(res.citations).toEqual([]); // no sources on a genuine non-answer
    expect(res.answer).toMatch(/ask me about a policy/i);
    expect(llm.complete).toHaveBeenCalledTimes(2); // grounded attempt + conversational
  });

  it('SALVAGE: a substantive answer that forgot its [n] markers is KEPT with sources attached', async () => {
    const prisma = makePrisma();
    // The model answered the question from the context but omitted the bracket markers
    // (the intermittent LLM behavior behind the old "fails first, works on retry" bug).
    const answer =
      'An infection-control incident report must be submitted within twenty-four hours ' +
      'of discovery, excluding weekends and holidays, to the department and the county board.';
    const llm = makeLlm({ complete: jest.fn().mockResolvedValueOnce(answer) });
    const svc = build(prisma, makeOrchestrator(groundedContext), llm);

    const res = await svc.chat({ message: 'When must an incident report be submitted?' }, USER);

    // The good answer is kept (not discarded), marked grounded, with the context's
    // sources attached — and NO second (conversational) LLM call is made.
    expect(res.grounded).toBe(true);
    expect(res.answer).toBe(answer);
    expect(res.citations.length).toBeGreaterThan(0);
    expect(llm.complete).toHaveBeenCalledTimes(1);
  });

  it('gating: unconfigured LLM → fallback, zero egress (AC5)', async () => {
    const prisma = makePrisma();
    const llm = makeLlm({ isConfigured: jest.fn().mockReturnValue(false) });
    const svc = build(prisma, makeOrchestrator(groundedContext), llm);

    const res = await svc.chat({ message: 'seclusion?' }, USER);

    expect(llm.complete).not.toHaveBeenCalled();
    expect(res.grounded).toBe(false);
  });

  it('LLM error → safe fallback, never surfaces the raw error', async () => {
    const prisma = makePrisma();
    const llm = makeLlm({ complete: jest.fn().mockRejectedValue(new Error('OpenAI 500')) });
    const svc = build(prisma, makeOrchestrator(groundedContext), llm);

    const res = await svc.chat({ message: 'seclusion?' }, USER);
    expect(res.grounded).toBe(false);
    expect(res.answer).not.toContain('OpenAI 500');
  });

  it('continues an existing OWNED conversation and loads bounded history (AC6)', async () => {
    const prisma = makePrisma();
    prisma.ragConversation.findUnique.mockResolvedValue({ id: 'convo-9', userId: 'u-1' });
    prisma.ragMessage.findMany.mockResolvedValue([
      { role: 'user', content: 'prev q' },
      { role: 'assistant', content: 'prev a' },
    ]);
    const llm = makeLlm();
    const svc = build(prisma, makeOrchestrator(groundedContext), llm);

    const res = await svc.chat({ message: 'follow up', conversationId: 'convo-9' }, USER);

    expect(res.conversationId).toBe('convo-9');
    expect(prisma.ragConversation.create).not.toHaveBeenCalled(); // reused
    // History was loaded and passed to the LLM.
    const messages = (llm.complete as jest.Mock).mock.calls[0][0];
    expect(messages.some((m: { content: string }) => m.content === 'prev q')).toBe(true);
  });

  it('does NOT reuse or leak another user\'s conversation (AC7)', async () => {
    const prisma = makePrisma();
    prisma.ragConversation.findUnique.mockResolvedValue({ id: 'convo-x', userId: 'someone-else' });
    const llm = makeLlm();
    const svc = build(prisma, makeOrchestrator(groundedContext), llm);

    const res = await svc.chat({ message: 'hi', conversationId: 'convo-x' }, USER);
    // Started a fresh conversation instead of writing into convo-x.
    expect(prisma.ragConversation.create).toHaveBeenCalled();
    expect(res.conversationId).toBe('convo-1');
  });

  it('passes the caller user to the orchestrator (ACL scope)', async () => {
    const prisma = makePrisma();
    const orchestrator = makeOrchestrator(emptyContext);
    const svc = build(prisma, orchestrator, makeLlm());
    await svc.chat({ message: 'q' }, USER);
    expect(orchestrator.answerableContext).toHaveBeenCalledWith('q', { user: USER });
  });

  describe('getConversation ownership (AC7)', () => {
    it('404s when the conversation does not exist', async () => {
      const prisma = makePrisma();
      prisma.ragConversation.findUnique.mockResolvedValue(null);
      const svc = build(prisma, makeOrchestrator(emptyContext), makeLlm());
      await expect(svc.getConversation('missing', USER)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('403s when the conversation belongs to another user', async () => {
      const prisma = makePrisma();
      prisma.ragConversation.findUnique.mockResolvedValue({
        id: 'c', userId: 'other', title: 't', createdAt: new Date(), updatedAt: new Date(),
      });
      const svc = build(prisma, makeOrchestrator(emptyContext), makeLlm());
      await expect(svc.getConversation('c', USER)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('listConversations (pagination)', () => {
    const convoRows = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `c-${i}`, title: `t-${i}`, createdAt: new Date('2024-01-01'), updatedAt: new Date('2024-01-01'),
      }));

    it('defaults to a page of 5 and fetches limit+1 to detect more pages', async () => {
      const prisma = makePrisma();
      prisma.ragConversation.findMany.mockResolvedValue(convoRows(6)); // 6 → hasMore
      const svc = build(prisma, makeOrchestrator(emptyContext), makeLlm());

      const res = await svc.listConversations(USER);

      const args = prisma.ragConversation.findMany.mock.calls[0][0];
      expect(args.skip).toBe(0);
      expect(args.take).toBe(6); // limit(5) + 1
      expect(res.items).toHaveLength(5);
      expect(res.hasMore).toBe(true);
      expect(typeof res.items[0].createdAt).toBe('string');
    });

    it('reports hasMore=false on the last page and honors offset', async () => {
      const prisma = makePrisma();
      prisma.ragConversation.findMany.mockResolvedValue(convoRows(3));
      const svc = build(prisma, makeOrchestrator(emptyContext), makeLlm());

      const res = await svc.listConversations(USER, { limit: 5, offset: 5 });

      expect(prisma.ragConversation.findMany.mock.calls[0][0].skip).toBe(5);
      expect(res.items).toHaveLength(3);
      expect(res.hasMore).toBe(false);
    });
  });

  describe('getConversation (message pagination, newest-first)', () => {
    const ownedConvo = { id: 'c', userId: USER.id, title: 't', createdAt: new Date(), updatedAt: new Date() };
    // findMany returns DESC; the service reverses to ASC. Rows carry sequence.
    const msgRowsDesc = (seqs: number[]) =>
      seqs.map((s) => ({
        sequence: s, role: s % 2 === 0 ? 'user' : 'assistant', content: `m${s}`,
        citations: null, grounded: false, createdAt: new Date('2024-01-01'),
      }));

    it('loads the NEWEST page (no cursor), returns messages oldest→newest + hasMoreOlder', async () => {
      const prisma = makePrisma();
      prisma.ragConversation.findUnique.mockResolvedValue(ownedConvo);
      // limit 10 → fetch 11; return 11 newest rows desc (seq 20..10) → hasMoreOlder.
      prisma.ragMessage.findMany.mockResolvedValue(
        msgRowsDesc(Array.from({ length: 11 }, (_, i) => 20 - i)),
      );
      const svc = build(prisma, makeOrchestrator(emptyContext), makeLlm());

      const res = await svc.getConversation('c', USER);

      const args = prisma.ragMessage.findMany.mock.calls[0][0];
      expect(args.orderBy).toEqual({ sequence: 'desc' });
      expect(args.take).toBe(11); // limit(10) + 1
      expect(args.where.sequence).toBeUndefined(); // no cursor on the first page
      expect(res.hasMoreOlder).toBe(true);
      expect(res.messages).toHaveLength(10);
      // Displayed oldest→newest: first shown seq < last shown seq.
      expect(res.messages[0].sequence).toBeLessThan(res.messages.at(-1)!.sequence);
      // oldestSequence is the cursor for the next (older) page.
      expect(res.oldestSequence).toBe(res.messages[0].sequence);
    });

    it('loads OLDER messages before a cursor', async () => {
      const prisma = makePrisma();
      prisma.ragConversation.findUnique.mockResolvedValue(ownedConvo);
      prisma.ragMessage.findMany.mockResolvedValue(msgRowsDesc([9, 8, 7])); // fewer than limit+1
      const svc = build(prisma, makeOrchestrator(emptyContext), makeLlm());

      const res = await svc.getConversation('c', USER, { messageLimit: 10, before: 10 });

      expect(prisma.ragMessage.findMany.mock.calls[0][0].where.sequence).toEqual({ lt: 10 });
      expect(res.hasMoreOlder).toBe(false);
      expect(res.messages.map((m) => m.sequence)).toEqual([7, 8, 9]); // ascending
    });

    it('FINDING-005: degrades to [] instead of throwing when citations is null, non-array, or shape-mismatched', async () => {
      const prisma = makePrisma();
      prisma.ragConversation.findUnique.mockResolvedValue(ownedConvo);
      // findMany returns newest-first (desc by sequence); the service reverses
      // to ascending for display, so this mock is intentionally seq 4..1.
      prisma.ragMessage.findMany.mockResolvedValue([
        {
          sequence: 4,
          role: 'assistant',
          content: 'd',
          citations: [{ index: 1, documentId: 'doc-1', chunkId: 'chunk-1' }],
          grounded: true,
          createdAt: new Date(),
        },
        { sequence: 3, role: 'assistant', content: 'c', citations: [{ foo: 'bar' }], grounded: false, createdAt: new Date() },
        { sequence: 2, role: 'assistant', content: 'b', citations: 'not-an-array', grounded: false, createdAt: new Date() },
        { sequence: 1, role: 'assistant', content: 'a', citations: null, grounded: false, createdAt: new Date() },
      ]);
      const svc = build(prisma, makeOrchestrator(emptyContext), makeLlm());

      const res = await svc.getConversation('c', USER);

      // Displayed ascending by sequence (1, 2, 3, 4) regardless of fetch order.
      expect(res.messages.map((m) => m.citations)).toEqual([
        [],
        [],
        [],
        [{ index: 1, documentId: 'doc-1', chunkId: 'chunk-1' }],
      ]);
      expect(res.messages.map((m) => m.sequence)).toEqual([1, 2, 3, 4]);
    });
  });
});
