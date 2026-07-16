import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RagConfigService } from '../rag-config.service';

/** The five terminal/transient states of the embedding lifecycle. */
type EmbeddingStatusKey = 'pending' | 'processing' | 'done' | 'failed' | 'skipped';

/** Per-status counts of `DocumentVersion.embeddingStatus`; every key is always present (0 when none). */
export interface EmbeddingBacklog {
  pending: number;
  processing: number;
  done: number;
  failed: number;
  skipped: number;
}

/**
 * Operator-facing RAG status snapshot. Deliberately excludes every secret —
 * notably the OpenAI API key is NEVER included (see {@link RagMetricsService.getStatus}).
 */
export interface RagStatus {
  enabled: boolean;
  configured: boolean;
  embeddingModel: string;
  embeddingDimensions: number;
  chatModel: string;
  embeddingBacklog: EmbeddingBacklog;
}

/** A zero-filled backlog, used as the base that groupBy results are merged onto. */
const EMPTY_BACKLOG = (): EmbeddingBacklog => ({
  pending: 0,
  processing: 0,
  done: 0,
  failed: 0,
  skipped: 0,
});

/**
 * Exposes a read-only RAG status/metrics snapshot for the authenticated status
 * endpoint (Phase 6). It reports the feature flags, the configured models, and
 * the embedding backlog derived from `DocumentVersion.embeddingStatus`.
 *
 * SECURITY: the returned {@link RagStatus} never carries a secret. It reads the
 * safe config getters only (enabled/models/dims) and deliberately does NOT touch
 * `RagConfigService.openaiApiKey`, so no key can leak through this surface —
 * asserted by a dedicated test.
 */
@Injectable()
export class RagMetricsService {
  constructor(
    private readonly ragConfig: RagConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /** Build the status snapshot: safe config values + the embedding backlog counts. */
  async getStatus(): Promise<RagStatus> {
    return {
      enabled: this.ragConfig.enabled,
      configured: this.ragConfig.isConfigured(),
      embeddingModel: this.ragConfig.embeddingModel,
      embeddingDimensions: this.ragConfig.embeddingDimensions,
      chatModel: this.ragConfig.chatModel,
      embeddingBacklog: await this.embeddingBacklog(),
    };
  }

  /**
   * One grouped query over `DocumentVersion.embeddingStatus`, mapped onto the
   * five fixed keys with missing statuses defaulting to 0.
   */
  private async embeddingBacklog(): Promise<EmbeddingBacklog> {
    const rows = await this.prisma.documentVersion.groupBy({
      by: ['embeddingStatus'],
      _count: true,
    });

    const backlog = EMPTY_BACKLOG();
    for (const row of rows) {
      const status = row.embeddingStatus as EmbeddingStatusKey;
      if (status in backlog) {
        backlog[status] = typeof row._count === 'number' ? row._count : 0;
      }
    }
    return backlog;
  }
}
