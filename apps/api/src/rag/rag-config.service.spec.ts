import { ConfigService } from '@nestjs/config';
import { RagConfigService } from './rag-config.service';

describe('RagConfigService', () => {
  /**
   * Builds a RagConfigService backed by a mock ConfigService whose `get(key)`
   * returns the supplied map value (undefined for absent keys, exactly like the
   * real ConfigService when an env var is unset).
   */
  const build = (env: Record<string, unknown> = {}): RagConfigService => {
    const config = {
      get: jest.fn((key: string) => env[key]),
    } as unknown as ConfigService;
    return new RagConfigService(config);
  };

  describe('defaults when env absent', () => {
    it('returns documented defaults for every getter', () => {
      const svc = build();

      expect(svc.enabled).toBe(false);
      expect(svc.openaiApiKey).toBeNull();
      expect(svc.embeddingModel).toBe('text-embedding-3-small');
      expect(svc.embeddingDimensions).toBe(1536);
      expect(svc.chunkMaxTokens).toBe(500);
      expect(svc.chunkOverlapTokens).toBe(60);
      expect(svc.embeddingBatchSize).toBe(96);
      expect(svc.retrievalTopK).toBe(8);
      expect(svc.retrievalCandidatePool).toBe(40);
      expect(svc.ftsCandidatePool).toBe(40);
      expect(svc.rrfK).toBe(60);
      expect(svc.contextMaxChars).toBe(8000);
      expect(svc.retrievalMaxDistance).toBe(0.72);
      expect(svc.embeddingCacheTtlMs).toBe(300_000);
      expect(svc.embeddingCacheMaxEntries).toBe(500);
      expect(svc.chatRateLimit).toBe(20);
      expect(svc.chatRateTtlMs).toBe(60_000);
    });
  });

  describe('overrides when env present', () => {
    it('reflects every provided env value', () => {
      const svc = build({
        RAG_ENABLED: 'true',
        OPENAI_API_KEY: 'sk-test',
        OPENAI_EMBEDDING_MODEL: 'text-embedding-3-large',
        EMBEDDING_DIMENSIONS: '3072',
        RAG_CHUNK_MAX_TOKENS: '800',
        RAG_CHUNK_OVERLAP_TOKENS: '120',
        EMBEDDING_BATCH_SIZE: '32',
        RAG_RETRIEVAL_TOP_K: '12',
        RAG_RETRIEVAL_CANDIDATE_POOL: '80',
        RAG_FTS_CANDIDATE_POOL: '50',
        RAG_RRF_K: '30',
        RAG_CONTEXT_MAX_CHARS: '5000',
      });

      expect(svc.enabled).toBe(true);
      expect(svc.openaiApiKey).toBe('sk-test');
      expect(svc.embeddingModel).toBe('text-embedding-3-large');
      expect(svc.embeddingDimensions).toBe(3072);
      expect(svc.chunkMaxTokens).toBe(800);
      expect(svc.chunkOverlapTokens).toBe(120);
      expect(svc.embeddingBatchSize).toBe(32);
      expect(svc.retrievalTopK).toBe(12);
      expect(svc.retrievalCandidatePool).toBe(80);
      expect(svc.ftsCandidatePool).toBe(50);
      expect(svc.rrfK).toBe(30);
      expect(svc.contextMaxChars).toBe(5000);
    });
  });

  describe('isConfigured()', () => {
    it('is false when RAG_ENABLED is false even with a key', () => {
      const svc = build({ RAG_ENABLED: 'false', OPENAI_API_KEY: 'sk-test' });
      expect(svc.isConfigured()).toBe(false);
    });

    it('is false when the API key is missing even when enabled', () => {
      const svc = build({ RAG_ENABLED: 'true' });
      expect(svc.isConfigured()).toBe(false);
    });

    it('is true only when enabled AND a key is present', () => {
      const svc = build({ RAG_ENABLED: 'true', OPENAI_API_KEY: 'sk-test' });
      expect(svc.isConfigured()).toBe(true);
    });
  });

  describe('envBool parsing of RAG_ENABLED', () => {
    it("parses the string 'true' as true", () => {
      expect(build({ RAG_ENABLED: 'true' }).enabled).toBe(true);
    });

    it("parses the string 'false' as false", () => {
      expect(build({ RAG_ENABLED: 'false' }).enabled).toBe(false);
    });

    it('accepts a real boolean true', () => {
      expect(build({ RAG_ENABLED: true }).enabled).toBe(true);
    });

    it('accepts a real boolean false', () => {
      expect(build({ RAG_ENABLED: false }).enabled).toBe(false);
    });

    it('is case-insensitive (TRUE → true)', () => {
      expect(build({ RAG_ENABLED: 'TRUE' }).enabled).toBe(true);
    });

    it('falls back to false for unrelated strings', () => {
      expect(build({ RAG_ENABLED: 'yes' }).enabled).toBe(false);
    });
  });
});
