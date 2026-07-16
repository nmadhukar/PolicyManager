import { ChatOpenAI } from '@langchain/openai';
import { OpenAiChatProvider } from './openai-chat.provider';
import { RagConfigService } from '../rag-config.service';

// Replace the real LangChain client with an auto-mock. jest.mock is hoisted
// above the imports, so the provider under test receives this mock constructor.
// Its instances expose a jest.fn() invoke we control per-test.
jest.mock('@langchain/openai');

const MockChatOpenAI = ChatOpenAI as jest.MockedClass<typeof ChatOpenAI>;

describe('OpenAiChatProvider', () => {
  /** Builds a RagConfigService mock with the given configured state + values. */
  const makeConfig = (
    over: Partial<{
      configured: boolean;
      apiKey: string | null;
      model: string;
      maxTokens: number;
      temperature: number;
    }> = {},
  ): RagConfigService => {
    const {
      configured = true,
      apiKey = 'sk-test',
      model = 'gpt-4o-mini',
      maxTokens = 700,
      temperature = 0.1,
    } = over;
    return {
      isConfigured: jest.fn(() => configured),
      openaiApiKey: apiKey,
      chatModel: model,
      chatMaxTokens: maxTokens,
      chatTemperature: temperature,
    } as unknown as RagConfigService;
  };

  /** Points the mocked ChatOpenAI constructor at an invoke impl. */
  const stubInvoke = (impl: (input: unknown) => Promise<{ content: unknown }>) => {
    MockChatOpenAI.mockImplementation(
      () => ({ invoke: jest.fn(impl) }) as unknown as ChatOpenAI,
    );
  };

  beforeEach(() => {
    MockChatOpenAI.mockReset();
  });

  describe('when NOT configured (zero-egress security gate)', () => {
    it('rejects complete() and never constructs a ChatOpenAI client', async () => {
      const provider = new OpenAiChatProvider(makeConfig({ configured: false }));

      await expect(provider.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(
        'Chat provider is not configured',
      );

      // The critical assertion: no client was ever built, so no request could
      // possibly leave the process while the feature is off.
      expect(MockChatOpenAI).not.toHaveBeenCalled();
    });
  });

  describe('empty input', () => {
    it('rejects without constructing a client, even when configured', async () => {
      const provider = new OpenAiChatProvider(makeConfig({ configured: true }));

      await expect(provider.complete([])).rejects.toThrow(
        'Chat provider requires at least one message',
      );

      expect(MockChatOpenAI).not.toHaveBeenCalled();
    });
  });

  describe('when configured', () => {
    it('returns the answer text from a string content', async () => {
      stubInvoke(async () => ({ content: 'hello [1]' }));
      const provider = new OpenAiChatProvider(makeConfig({ configured: true }));

      const answer = await provider.complete([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'q' },
      ]);

      expect(answer).toBe('hello [1]');
    });

    it('constructs ChatOpenAI with the configured apiKey, model, maxTokens, and temperature', async () => {
      stubInvoke(async () => ({ content: 'ok' }));
      const provider = new OpenAiChatProvider(
        makeConfig({
          configured: true,
          apiKey: 'sk-live',
          model: 'gpt-4o',
          maxTokens: 512,
          temperature: 0.2,
        }),
      );

      await provider.complete([{ role: 'user', content: 'q' }]);

      expect(MockChatOpenAI).toHaveBeenCalledTimes(1);
      expect(MockChatOpenAI).toHaveBeenCalledWith({
        apiKey: 'sk-live',
        model: 'gpt-4o',
        maxTokens: 512,
        temperature: 0.2,
      });
    });

    it('passes messages as [role, content] tuples to invoke', async () => {
      const invoke = jest.fn(async () => ({ content: 'ok' }));
      MockChatOpenAI.mockImplementation(() => ({ invoke }) as unknown as ChatOpenAI);
      const provider = new OpenAiChatProvider(makeConfig({ configured: true }));

      await provider.complete([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'q' },
      ]);

      expect(invoke).toHaveBeenCalledWith([
        ['system', 'sys'],
        ['user', 'q'],
      ]);
    });

    it('builds the client only once across multiple complete() calls', async () => {
      stubInvoke(async () => ({ content: 'ok' }));
      const provider = new OpenAiChatProvider(makeConfig({ configured: true }));

      await provider.complete([{ role: 'user', content: 'a' }]);
      await provider.complete([{ role: 'user', content: 'b' }]);

      expect(MockChatOpenAI).toHaveBeenCalledTimes(1);
    });

    it('joins array-of-parts content into a single string', async () => {
      stubInvoke(async () => ({
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
      }));
      const provider = new OpenAiChatProvider(makeConfig({ configured: true }));

      const answer = await provider.complete([{ role: 'user', content: 'q' }]);

      expect(answer).toBe('ab');
    });

    it('ignores non-text parts when joining array content', async () => {
      stubInvoke(async () => ({
        content: [
          { type: 'text', text: 'a' },
          { type: 'image_url', image_url: 'http://x' },
          { type: 'text', text: 'b' },
        ],
      }));
      const provider = new OpenAiChatProvider(makeConfig({ configured: true }));

      const answer = await provider.complete([{ role: 'user', content: 'q' }]);

      expect(answer).toBe('ab');
    });
  });

  describe('getter reflects config', () => {
    it('exposes model from RagConfigService', () => {
      const provider = new OpenAiChatProvider(makeConfig({ model: 'gpt-4o' }));

      expect(provider.model).toBe('gpt-4o');
    });
  });

  describe('provider error path', () => {
    it('propagates a rejection from invoke (does not swallow)', async () => {
      stubInvoke(async () => {
        throw new Error('rate limited');
      });
      const provider = new OpenAiChatProvider(makeConfig({ configured: true }));

      await expect(provider.complete([{ role: 'user', content: 'q' }])).rejects.toThrow(
        'rate limited',
      );
    });
  });
});
