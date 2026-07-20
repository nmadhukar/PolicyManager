import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { NotificationsService } from './notifications.service';

@Injectable()
export class NotificationsScheduler {
  private readonly logger = new Logger(NotificationsScheduler.name);
  // FINDING-005: guards against re-entrant overlap the same way
  // DocumentExtractionService.pollPending does — if runDigest() is still
  // in-flight when the next hourly tick fires (e.g. under an SMTP slowdown),
  // that tick is a no-op instead of re-selecting and re-sending to the same
  // digest-eligible users.
  private running = false;

  constructor(private readonly notifications: NotificationsService) {}

  @Cron('0 * * * *')
  async hourlyDigestSweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.notifications.runDigest(new Date());
      if (result.digestsSent || result.failed) {
        this.logger.log(
          `Notification digest sweep: ${result.digestsSent} sent, ${result.failed} failed`,
        );
      }
    } catch (err) {
      this.logger.error(`Notification digest sweep failed: ${String(err)}`);
    } finally {
      this.running = false;
    }
  }
}
