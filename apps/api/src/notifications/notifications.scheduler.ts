import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { NotificationsService } from './notifications.service';

@Injectable()
export class NotificationsScheduler {
  private readonly logger = new Logger(NotificationsScheduler.name);

  constructor(private readonly notifications: NotificationsService) {}

  @Cron('0 * * * *')
  async hourlyDigestSweep(): Promise<void> {
    try {
      const result = await this.notifications.runDigest(new Date());
      if (result.digestsSent || result.failed) {
        this.logger.log(
          `Notification digest sweep: ${result.digestsSent} sent, ${result.failed} failed`,
        );
      }
    } catch (err) {
      this.logger.error(`Notification digest sweep failed: ${String(err)}`);
    }
  }
}
