import { Injectable, Logger } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import type { MessageContent } from '@langchain/core/messages';
import { ChatLlmProvider, ChatMessage } from './chat-llm-provider';
import { RagConfigService } from '../rag-config.service';

/**
 * OpenAI-backed {@link ChatLlmProvider} implemented over LangChain's ChatOpenAI.
 *
 * Egress is strictly gated: the underlying ChatOpenAI client is built lazily on
 * the first configured complete() call, so merely constructing this provider
 * while RAG is disabled (no key) never touches the network and never throws.
 * This mirrors {@link OpenAiEmbeddingProvider} for the retrieval half. When
 * unconfigured, complete() throws before any client is created — guaranteeing
 * zero OpenAI calls until an operator opts in.
 */
@Injectable()
export class OpenAiChatProvider implements ChatLlmProvider {
  private readonly logger = new Logger(OpenAiChatProvider.name);
  /** Lazily-constructed LangChain client; null until the first configured complete(). */
  private client: ChatOpenAI | null = null;

  constructor(private readonly ragConfig: RagConfigService) {}

  isConfigured(): boolean {
    return this.ragConfig.isConfigured();
  }

  get model(): string {
    return this.ragConfig.chatModel;
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    if (!this.isConfigured()) {
      // Hard gate: fail closed before constructing any client, so no request
      // can leave the process while the feature is disabled or unkeyed.
      throw new Error('Chat provider is not configured');
    }
    if (messages.length === 0) {
      throw new Error('Chat provider requires at least one message');
    }

    try {
      const result = await this.getClient().invoke(
        messages.map((m) => [m.role, m.content] as [string, string]),
      );
      return this.coerceContent(result.content);
    } catch (err) {
      // Never log raw message content or the API key; surface only the message.
      this.logger.warn(`Chat completion request failed: ${(err as Error).message}`);
      // Re-throw so callers can fall back honestly; do not swallow.
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /**
   * Coerce a LangChain message content (string, or an array of content parts)
   * into a plain string. For the array shape we concatenate the text parts and
   * ignore non-text parts (images etc.), which chat answers never produce.
   */
  private coerceContent(content: MessageContent): string {
    if (typeof content === 'string') return content;
    return content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('');
  }

  /** Builds (once) and returns the LangChain client from current RAG config. */
  private getClient(): ChatOpenAI {
    if (!this.client) {
      this.client = new ChatOpenAI({
        apiKey: this.ragConfig.openaiApiKey ?? undefined,
        model: this.model,
        maxTokens: this.ragConfig.chatMaxTokens,
        temperature: this.ragConfig.chatTemperature,
        // FINDING-003: bound how long a single call can hang — without this the
        // OpenAI SDK's own multi-minute default applies, and ChatService.chat()
        // can issue up to two sequential calls per request.
        timeout: this.ragConfig.llmTimeoutMs,
      });
    }
    return this.client;
  }
}
