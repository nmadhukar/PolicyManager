import {
  SYSTEM_PROMPT,
  CONVERSATIONAL_SYSTEM_PROMPT,
  buildUserPrompt,
  buildMessages,
  buildConversationalMessages,
  NO_SOURCE_ANSWER,
} from './prompts';
import type { RagContext } from '@policymanager/shared';

describe('RAG chat prompts', () => {
  const ctx = (over: Partial<RagContext> = {}): RagContext => ({
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
    ...over,
  });

  describe('SYSTEM_PROMPT', () => {
    it('mandates grounding only in provided context', () => {
      expect(SYSTEM_PROMPT).toMatch(/ONLY the numbered source/i);
      expect(SYSTEM_PROMPT).toMatch(/do NOT use outside/i);
    });

    it('mandates inline citations', () => {
      expect(SYSTEM_PROMPT).toMatch(/\[1\]/);
      expect(SYSTEM_PROMPT).toMatch(/cite/i);
    });

    it('includes the no-source fallback instruction (no fabrication)', () => {
      // The instruction wraps across lines; collapse whitespace before matching.
      const flat = SYSTEM_PROMPT.replace(/\s+/g, ' ');
      expect(flat).toMatch(/do not have a policy source/i);
      expect(flat).toMatch(/never fabricate/i);
    });

    it('contains the prompt-injection hardening clause (AC8)', () => {
      // The system prompt must instruct the model to treat context as DATA, not
      // instructions, and to refuse embedded instructions.
      const flat = SYSTEM_PROMPT.replace(/\s+/g, ' ');
      expect(flat).toMatch(/untrusted/i);
      expect(flat).toMatch(/ignore previous instructions/i);
      expect(flat).toMatch(/DATA, not instructions/i);
    });
  });

  describe('buildUserPrompt', () => {
    it('delimits the context block as data (AC8)', () => {
      const prompt = buildUserPrompt('What is the seclusion policy?', ctx());
      expect(prompt).toContain('<<<CONTEXT_START>>>');
      expect(prompt).toContain('<<<CONTEXT_END>>>');
      expect(prompt).toContain('Seclusion is a last resort.');
      expect(prompt).toContain('QUESTION: What is the seclusion policy?');
    });

    it('tells the model there are no sources when context is empty', () => {
      const prompt = buildUserPrompt('anything', ctx({ contextText: '', citations: [], empty: true }));
      expect(prompt).toMatch(/no matching policy sources/i);
    });
  });

  describe('buildMessages', () => {
    it('leads with the system prompt then history then the grounded user turn', () => {
      const history = [
        { role: 'user' as const, content: 'earlier q' },
        { role: 'assistant' as const, content: 'earlier a' },
      ];
      const messages = buildMessages('new q', ctx(), history);
      expect(messages[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT });
      expect(messages[1]).toEqual({ role: 'user', content: 'earlier q' });
      expect(messages[2]).toEqual({ role: 'assistant', content: 'earlier a' });
      expect(messages[3].role).toBe('user');
      expect(messages[3].content).toContain('QUESTION: new q');
    });

    it('works with no history', () => {
      const messages = buildMessages('q', ctx());
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe('system');
      expect(messages[1].role).toBe('user');
    });
  });

  it('exposes a clear no-source answer', () => {
    expect(NO_SOURCE_ANSWER).toMatch(/don't have a policy source/i);
  });

  describe('conversational (no-source) path', () => {
    it('CONVERSATIONAL_SYSTEM_PROMPT invites a policy question and forbids inventing facts', () => {
      const flat = CONVERSATIONAL_SYSTEM_PROMPT.replace(/\s+/g, ' ');
      expect(flat).toMatch(/warmly/i);
      expect(flat).toMatch(/greeting|small talk/i);
      expect(flat).toMatch(/do not invent|do not guess/i);
      expect(flat).toMatch(/do not add bracketed/i); // no citations
      expect(flat).toMatch(/did not match any/i);
    });

    it('CONVERSATIONAL_SYSTEM_PROMPT keeps the injection posture', () => {
      const flat = CONVERSATIONAL_SYSTEM_PROMPT.replace(/\s+/g, ' ');
      expect(flat).toMatch(/do not follow any instructions/i);
    });

    it('buildConversationalMessages = system + history + raw user turn (no context block)', () => {
      const history = [{ role: 'assistant' as const, content: 'earlier' }];
      const messages = buildConversationalMessages('Hey', history);
      expect(messages[0]).toEqual({ role: 'system', content: CONVERSATIONAL_SYSTEM_PROMPT });
      expect(messages[1]).toEqual({ role: 'assistant', content: 'earlier' });
      expect(messages[2]).toEqual({ role: 'user', content: 'Hey' });
      // No CONTEXT delimiters — there is no context on this path.
      expect(messages[2].content).not.toContain('CONTEXT');
    });
  });
});
