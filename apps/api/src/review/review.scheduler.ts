import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ReviewService } from './review.service';

/**
 * Drives the daily QC review sweep. Kept separate from {@link ReviewService} so the
 * service stays clock-free and unit-testable (this thin wrapper is the only place a
 * real `new Date()` enters the sweep). Failures are swallowed + logged — a sweep
 * outage must never crash the scheduler or the process.
 */
@Injectable()
export class ReviewScheduler {
  private readonly logger = new Logger(ReviewScheduler.name);

  constructor(private readonly review: ReviewService) {}

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async dailySweep(): Promise<void> {
    try {
      const res = await this.review.runReviewSweep(new Date());
      this.logger.log(
        `Daily review sweep: ${res.tasksCreated} tasks created, ${res.overdueMarked} marked overdue`,
      );
    } catch (err) {
      this.logger.error(`Daily review sweep failed: ${String(err)}`);
    }
  }
}
