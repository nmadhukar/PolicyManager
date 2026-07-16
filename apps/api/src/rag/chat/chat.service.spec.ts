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

  it('grounded context but the answer cites NOTHING → warm reply, no citations', async () => {
    const prisma = makePrisma();
    // Weak context: model answers without any [n] marker (sources didn't help).
    const llm = makeLlm({
      complete: jest
        .fn()
        .mockResolvedValueOnce('I could not find that in the sources.') // grounded attempt, no [n]
        .mockResolvedValueOnce("Hi! Ask me about a policy and I'll help."), // conversational retry
    });
    const svc = build(prisma, makeOrchestrator(groundedContext), llm);

    const res = await svc.chat({ message: 'Hey' }, USER);

    expect(res.grounded).toBe(false);
    expect(res.citations).toEqual([]); // never attach sources to an uncited answer
    expect(res.answer).toMatch(/ask me about a policy/i);
    expect(llm.complete).toHaveBeenCalledTimes(2); // grounded attempt + conversational
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
});
