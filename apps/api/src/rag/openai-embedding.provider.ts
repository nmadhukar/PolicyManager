import { Injectable, Logger } from '@nestjs/common';
import { OpenAIEmbeddings } from '@langchain/openai';
import { EmbeddingProvider } from './embedding-provider';
import { RagConfigService } from './rag-config.service';

/**
 * OpenAI-backed {@link EmbeddingProvider} implemented over LangChain's
 * OpenAIEmbeddings.
 *
 * Egress is strictly gated: the underlying OpenAIEmbeddings client is built
 * lazily on the first successful embed() call, so merely constructing this
 * provider while RAG is disabled (no key) never touches the network and never
 * throws. This mirrors OcrService, which is safe to instantiate when the
 * feature is off. When unconfigured, embed() throws before any client is
 * created — guaranteeing zero OpenAI calls until an operator opts in.
 */
@Injectable()
export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  private readonly logger = new Logger(OpenAiEmbeddingProvider.name);
  /** Lazily-constructed LangChain client; null until the first configured embed(). */
  private client: OpenAIEmbeddings | null = null;

  constructor(private readonly ragConfig: RagConfigService) {}

  isConfigured(): boolean {
    return this.ragConfig.isConfigured();
  }

  get model(): string {
    return this.ragConfig.embeddingModel;
  }

  get dimensions(): number {
    return this.ragConfig.embeddingDimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.isConfigured()) {
      // Hard gate: fail closed before constructing any client, so no request
      // can leave the process while the feature is disabled or unkeyed.
      throw new Error('Embedding provider is not configured');
    }
    if (texts.length === 0) return [];

    try {
      const vectors = await this.getClient().embedDocuments(texts);
      return vectors;
    } catch (err) {
      // Never log raw text or the API key; surface only the vendor message.
      this.logger.warn(`Embedding request failed: ${(err as Error).message}`);
      // Re-throw so callers can mark embeddingStatus=failed; do not swallow.
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /** Builds (once) and returns the LangChain client from current RAG config. */
  private getClient(): OpenAIEmbeddings {
    if (!this.client) {
      this.client = new OpenAIEmbeddings({
        apiKey: this.ragConfig.openaiApiKey ?? undefined,
        model: this.model,
        dimensions: this.dimensions,
      });
    }
    return this.client;
  }
}
