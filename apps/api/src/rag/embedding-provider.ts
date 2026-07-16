/**
 * Vendor-agnostic seam for text embedding.
 *
 * This interface is the Dependency-Inversion boundary for the RAG pipeline:
 * higher-level services (EmbeddingService, ingestion, retrieval) depend only on
 * this contract, never on a concrete SDK. Swapping OpenAI for a different vendor
 * (Cohere, a self-hosted model, etc.) is an adapter swap behind {@link EMBEDDING_PROVIDER}
 * with no change to consumers.
 */
export interface EmbeddingProvider {
  /** True when the provider is configured and safe to call (key present, feature enabled). */
  isConfigured(): boolean;
  /** The model identifier persisted per-chunk (e.g. 'text-embedding-3-small'). */
  readonly model: string;
  /** The vector dimensionality (e.g. 1536). */
  readonly dimensions: number;
  /**
   * Embed a batch of texts. Returns one vector per input, in order.
   * MUST throw if not configured (callers gate on isConfigured() first).
   * MUST throw on provider/network error (callers handle failure → embeddingStatus=failed).
   */
  embed(texts: string[]): Promise<number[][]>;
}

/** Nest DI token for injecting the active EmbeddingProvider. */
export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER');
