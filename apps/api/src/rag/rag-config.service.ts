import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Parses a string/boolean env flag into a real boolean. */
function envBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return fallback;
}

/**
 * Central, typed accessor for all RAG-related environment configuration.
 *
 * RAG is off by default and self-provisioned: it only becomes active when an
 * operator sets RAG_ENABLED=true AND supplies OPENAI_API_KEY. Until both are
 * present {@link isConfigured} returns false and no embedding egress may occur.
 * Every consumer reads config through this service rather than ConfigService
 * directly, so defaults and the enablement gate live in exactly one place.
 */
@Injectable()
export class RagConfigService {
  constructor(private readonly config: ConfigService) {}

  /** RAG_ENABLED feature flag; default false (feature is opt-in). */
  get enabled(): boolean {
    return envBool(this.config.get('RAG_ENABLED'), false);
  }

  /** OPENAI_API_KEY, or null when absent/blank. Never logged. */
  get openaiApiKey(): string | null {
    return this.config.get<string>('OPENAI_API_KEY') || null;
  }

  /** Embedding model id persisted per-chunk; default 'text-embedding-3-small'. */
  get embeddingModel(): string {
    return this.config.get<string>('OPENAI_EMBEDDING_MODEL') || 'text-embedding-3-small';
  }

  /** Output vector dimensionality; default 1536. */
  get embeddingDimensions(): number {
    return Number(this.config.get('EMBEDDING_DIMENSIONS') ?? 1536);
  }

  /** Max tokens per chunk when splitting documents; default 500. */
  get chunkMaxTokens(): number {
    return Number(this.config.get('RAG_CHUNK_MAX_TOKENS') ?? 500);
  }

  /** Token overlap between adjacent chunks; default 60. */
  get chunkOverlapTokens(): number {
    return Number(this.config.get('RAG_CHUNK_OVERLAP_TOKENS') ?? 60);
  }

  /** Number of texts sent per embedding request; default 96. */
  get embeddingBatchSize(): number {
    return Number(this.config.get('EMBEDDING_BATCH_SIZE') ?? 96);
  }

  /** Max chunks returned from a hybrid retrieval; default 8. */
  get retrievalTopK(): number {
    return Number(this.config.get('RAG_RETRIEVAL_TOP_K') ?? 8);
  }

  /** Vector-leg candidate cap before fusion; default 40. */
  get retrievalCandidatePool(): number {
    return Number(this.config.get('RAG_RETRIEVAL_CANDIDATE_POOL') ?? 40);
  }

  /**
   * FTS-leg candidate cap before fusion; default 40. Independent of
   * {@link retrievalCandidatePool} so lexical vs. semantic recall can be tuned
   * separately — the two legs retrieve independently (true hybrid search) and
   * are combined only afterward via Reciprocal Rank Fusion.
   */
  get ftsCandidatePool(): number {
    return Number(this.config.get('RAG_FTS_CANDIDATE_POOL') ?? 40);
  }

  /** Reciprocal-Rank-Fusion constant `k` (higher = flatter weighting); default 60. */
  get rrfK(): number {
    return Number(this.config.get('RAG_RRF_K') ?? 60);
  }

  /**
   * Exact-identifier-leg candidate cap; default 20. When the query names a section
   * identifier (Policy 705, SOP-0045, Clause 8.3), a third INDEPENDENT retrieval
   * leg looks it up by normalizedSectionIdentifier. Smaller than the semantic pools
   * because an exact identifier is highly selective.
   */
  get exactCandidatePool(): number {
    return Number(this.config.get('RAG_EXACT_CANDIDATE_POOL') ?? 20);
  }

  /**
   * Weight added to the fused score for a chunk that matched the EXACT-identifier
   * leg; default 1.0. Ensures that when a user asks for "Policy 705" the chunks of
   * Policy 705 rank ahead of merely semantically-similar chunks. Additive on top of
   * the RRF score so exact requests are prioritized without silencing the other legs.
   */
  get exactMatchBoost(): number {
    return Number(this.config.get('RAG_EXACT_MATCH_BOOST') ?? 1.0);
  }

  /**
   * Number of adjacent chunks (chunkIndex ± N) to pull in around each selected
   * anchor for continuous context; default 1. Neighbors are fetched within the
   * SAME version and, when the anchor has a section, the SAME section — so section
   * boundaries are respected. 0 disables expansion.
   */
  get adjacentExpansion(): number {
    return Number(this.config.get('RAG_ADJACENT_EXPANSION') ?? 1);
  }

  /**
   * Max ANCHOR chunks any single document may contribute to the final result
   * (RAG Phase 4 anti-monopolization); default 3. Prevents one large document from
   * filling topK and starving other relevant documents on a broad query. An EXACT
   * section request bypasses this cap for the requested section so a whole section
   * can still be assembled. 0 disables the cap.
   */
  get maxChunksPerDocument(): number {
    return Number(this.config.get('RAG_MAX_CHUNKS_PER_DOCUMENT') ?? 3);
  }

  /** Max characters of grounding context assembled from chunks; default 8000. */
  get contextMaxChars(): number {
    return Number(this.config.get('RAG_CONTEXT_MAX_CHARS') ?? 8000);
  }

  /**
   * Max cosine DISTANCE a chunk may have to still count as relevant (0 = identical,
   * 2 = opposite). Chunks beyond this are dropped so clearly-unrelated text never
   * becomes a "source". Deliberately LENIENT (0.72): OpenAI text-embedding-3-small
   * puts genuine matches around 0.35–0.65, so a tighter cap would reject real but
   * loosely-worded questions. The friendly-reply behaviour for greetings/off-topic
   * does not rely on this cap alone — it also triggers when the model's answer
   * cites no source (see ChatService), which is the robust signal.
   */
  get retrievalMaxDistance(): number {
    return Number(this.config.get('RAG_RETRIEVAL_MAX_DISTANCE') ?? 0.72);
  }

  /** OpenAI chat model for grounded answers; default 'gpt-4o-mini'. */
  get chatModel(): string {
    return this.config.get<string>('OPENAI_CHAT_MODEL') || 'gpt-4o-mini';
  }

  /** Prior turns loaded into the prompt as history; default 6. */
  get chatHistoryTurns(): number {
    return Number(this.config.get('RAG_CHAT_HISTORY_TURNS') ?? 6);
  }

  /** Max tokens for a generated answer; default 700. */
  get chatMaxTokens(): number {
    return Number(this.config.get('RAG_CHAT_MAX_TOKENS') ?? 700);
  }

  /** Answer temperature (low = deterministic/grounded); default 0.1. */
  get chatTemperature(): number {
    return Number(this.config.get('RAG_CHAT_TEMPERATURE') ?? 0.1);
  }

  // --- Phase 6: hardening (cache + rate limit) ---

  /** Query-embedding cache TTL in ms (0 disables the cache); default 300000 (5m). */
  get embeddingCacheTtlMs(): number {
    return Number(this.config.get('RAG_EMBED_CACHE_TTL_MS') ?? 300_000);
  }

  /** Max entries in the query-embedding cache (LRU eviction); default 500. */
  get embeddingCacheMaxEntries(): number {
    return Number(this.config.get('RAG_EMBED_CACHE_MAX') ?? 500);
  }

  /** Per-window request cap for POST /rag/chat; default 20. */
  get chatRateLimit(): number {
    return Number(this.config.get('RAG_CHAT_RATE_LIMIT') ?? 20);
  }

  /** Rate-limit window in ms for POST /rag/chat; default 60000 (1m). */
  get chatRateTtlMs(): number {
    return Number(this.config.get('RAG_CHAT_RATE_TTL_MS') ?? 60_000);
  }

  /**
   * FINDING-003: request timeout (ms) for OpenAI chat/embedding calls. Neither
   * client is given one by default, so a slow/hanging upstream response can
   * hold a request open for the SDK's own multi-minute default — under the
   * tight 20 req/60s chat rate limit, a handful of stuck calls can pin many
   * event-loop/HTTP-agent slots during an OpenAI incident. Bounded to a
   * multiple of chatMaxTokens' realistic generation time; default 20000 (20s).
   */
  get llmTimeoutMs(): number {
    return Number(this.config.get('RAG_LLM_TIMEOUT_MS') ?? 20_000);
  }

  /** True only when the feature is enabled and an API key is present. */
  isConfigured(): boolean {
    return this.enabled && !!this.openaiApiKey;
  }
}
