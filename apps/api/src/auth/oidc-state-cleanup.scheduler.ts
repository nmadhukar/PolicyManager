import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

/**
 * FINDING-019: OidcState rows are deleted on a successful callback
 * (AzureOidcService.handleCallback), but an abandoned login — the user closes
 * the tab, or never returns from Azure AD — leaves its row behind forever with
 * nothing to reap it. Low-frequency sweep of rows already past `expiresAt`
 * keeps the table from growing unbounded under normal login-abandonment
 * traffic. Mirrors NotificationsScheduler / EmbeddingScheduler's re-entrancy
 * guard.
 */
@Injectable()
export class OidcStateCleanupScheduler {
  private readonly logger = new Logger(OidcStateCleanupScheduler.name);
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  @Cron('0 * * * *')
  async cleanupExpiredState(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { count } = await this.prisma.oidcState.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });
      if (count) {
        this.logger.log(`OidcState cleanup: removed ${count} expired row(s)`);
      }
    } catch (err) {
      this.logger.error(`OidcState cleanup failed: ${String(err)}`);
    } finally {
      this.running = false;
    }
  }
}
