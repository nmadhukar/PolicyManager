import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EmbeddingService } from './embedding.service';

@Injectable()
export class EmbeddingScheduler {
  private readonly logger = new Logger(EmbeddingScheduler.name);
  // FINDING-015: guards against re-entrant overlap the same way
  // NotificationsScheduler.hourlyDigestSweep does — if processPending() is
  // still in-flight when the next tick fires (e.g. under an embedding-provider
  // slowdown), that tick is a no-op instead of re-claiming the same backlog.
  private running = false;

  constructor(private readonly embedding: EmbeddingService) {}

  @Cron('*/5 * * * *')
  async embeddingBacklogSweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.embedding.processPending();
      if (result.processed) {
        this.logger.log(
          `Embedding backlog sweep: ${result.done} done, ${result.skipped} skipped, ${result.failed} failed`,
        );
      }
    } catch (err) {
      this.logger.error(`Embedding backlog sweep failed: ${String(err)}`);
    } finally {
      this.running = false;
    }
  }
}
