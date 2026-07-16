/** A single message in an LLM chat completion request. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Vendor-agnostic seam for chat completion (the answer-generation half of RAG,
 * mirroring EmbeddingProvider for the retrieval half). Consumers depend only on
 * this; swapping OpenAI for another vendor is an adapter behind {@link CHAT_LLM_PROVIDER}.
 */
export interface ChatLlmProvider {
  /** True when configured and safe to call (key present, feature enabled). */
  isConfigured(): boolean;
  /** The chat model id (for audit/telemetry). */
  readonly model: string;
  /**
   * Generate a completion for the given messages. MUST throw if not configured
   * (callers gate on isConfigured() first) and on provider/network error.
   */
  complete(messages: ChatMessage[]): Promise<string>;
}

/** Nest DI token for injecting the active chat provider. */
export const CHAT_LLM_PROVIDER = Symbol('CHAT_LLM_PROVIDER');
