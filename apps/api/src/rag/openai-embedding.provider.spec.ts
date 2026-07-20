import { OpenAIEmbeddings } from '@langchain/openai';
import { OpenAiEmbeddingProvider } from './openai-embedding.provider';
import { RagConfigService } from './rag-config.service';

// Replace the real LangChain client with an auto-mock. jest.mock is hoisted
// above the imports, so the provider under test receives this mock constructor.
// Its instances expose a jest.fn() embedDocuments we control per-test.
jest.mock('@langchain/openai');

const MockOpenAIEmbeddings = OpenAIEmbeddings as jest.MockedClass<typeof OpenAIEmbeddings>;

describe('OpenAiEmbeddingProvider', () => {
  /** Builds a RagConfigService mock with the given configured state + values. */
  const makeConfig = (
    over: Partial<{
      configured: boolean;
      apiKey: string | null;
      model: string;
      dimensions: number;
      timeoutMs: number;
    }> = {},
  ): RagConfigService => {
    const {
      configured = true,
      apiKey = 'sk-test',
      model = 'text-embedding-3-small',
      dimensions = 1536,
      timeoutMs = 20_000,
    } = over;
    return {
      isConfigured: jest.fn(() => configured),
      openaiApiKey: apiKey,
      embeddingModel: model,
      embeddingDimensions: dimensions,
      llmTimeoutMs: timeoutMs,
    } as unknown as RagConfigService;
  };

  /** Points the mocked OpenAIEmbeddings constructor at an embedDocuments impl. */
  const stubEmbedDocuments = (impl: (texts: string[]) => Promise<number[][]>) => {
    MockOpenAIEmbeddings.mockImplementation(
      () => ({ embedDocuments: jest.fn(impl) }) as unknown as OpenAIEmbeddings,
    );
  };

  beforeEach(() => {
    MockOpenAIEmbeddings.mockReset();
  });

  describe('when NOT configured (zero-egress security gate)', () => {
    it('rejects embed() and never constructs an OpenAIEmbeddings client', async () => {
      const provider = new OpenAiEmbeddingProvider(makeConfig({ configured: false }));

      await expect(provider.embed(['x'])).rejects.toThrow('Embedding provider is not configured');

      // The critical assertion: no client was ever built, so no request could
      // possibly leave the process while the feature is off.
      expect(MockOpenAIEmbeddings).not.toHaveBeenCalled();
    });
  });

  describe('empty input', () => {
    it('returns [] without constructing a client, even when configured', async () => {
      const provider = new OpenAiEmbeddingProvider(makeConfig({ configured: true }));

      await expect(provider.embed([])).resolves.toEqual([]);

      expect(MockOpenAIEmbeddings).not.toHaveBeenCalled();
    });
  });

  describe('when configured', () => {
    it('returns one vector per input in order', async () => {
      const canned: number[][] = [
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ];
      stubEmbedDocuments(async () => canned);
      const provider = new OpenAiEmbeddingProvider(makeConfig({ configured: true }));

      const result = await provider.embed(['a', 'b']);

      expect(result).toEqual(canned);
      expect(result).toHaveLength(2);
    });

    it('constructs OpenAIEmbeddings with the configured apiKey, model, dimensions, and timeout', async () => {
      stubEmbedDocuments(async () => [[1]]);
      const provider = new OpenAiEmbeddingProvider(
        makeConfig({
          configured: true,
          apiKey: 'sk-live',
          model: 'text-embedding-3-large',
          dimensions: 3072,
          timeoutMs: 15_000,
        }),
      );

      await provider.embed(['a']);

      expect(MockOpenAIEmbeddings).toHaveBeenCalledTimes(1);
      expect(MockOpenAIEmbeddings).toHaveBeenCalledWith({
        apiKey: 'sk-live',
        model: 'text-embedding-3-large',
        dimensions: 3072,
        timeout: 15_000,
      });
    });

    it('FINDING-003: always passes a bounded timeout, even with default config', async () => {
      stubEmbedDocuments(async () => [[1]]);
      const provider = new OpenAiEmbeddingProvider(makeConfig({ configured: true }));

      await provider.embed(['a']);

      const ctorArg = MockOpenAIEmbeddings.mock.calls[0][0] as { timeout?: number };
      expect(ctorArg.timeout).toBeGreaterThan(0);
    });

    it('builds the client only once across multiple embed() calls', async () => {
      stubEmbedDocuments(async () => [[1]]);
      const provider = new OpenAiEmbeddingProvider(makeConfig({ configured: true }));

      await provider.embed(['a']);
      await provider.embed(['b']);

      expect(MockOpenAIEmbeddings).toHaveBeenCalledTimes(1);
    });
  });

  describe('getters reflect config', () => {
    it('exposes model and dimensions from RagConfigService', () => {
      const provider = new OpenAiEmbeddingProvider(
        makeConfig({ model: 'text-embedding-3-large', dimensions: 3072 }),
      );

      expect(provider.model).toBe('text-embedding-3-large');
      expect(provider.dimensions).toBe(3072);
    });
  });

  describe('provider error path', () => {
    it('propagates a rejection from embedDocuments (does not swallow)', async () => {
      stubEmbedDocuments(async () => {
        throw new Error('rate limited');
      });
      const provider = new OpenAiEmbeddingProvider(makeConfig({ configured: true }));

      await expect(provider.embed(['a'])).rejects.toThrow('rate limited');
    });
  });
});
