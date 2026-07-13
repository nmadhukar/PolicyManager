import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AttestationModule } from '../attestation/attestation.module';
import { ReviewScheduler } from './review.scheduler';
import { ReviewService } from './review.service';
import { ReviewersController } from './reviewers.controller';
import { ReviewsController } from './reviews.controller';

/**
 * QC review scheduling + sign-off (Phase 5, PM-0501..PM-0506). Uses the global
 * MailService/PrismaService/AuditService and the AuthModule guards. The scheduler
 * runs the daily sweep; ScheduleModule.forRoot() is registered in AppModule.
 *
 * Imports AttestationModule (Phase 6) so completion records an immutable `reviewed`
 * sign-off and the sweep can flag overdue acknowledgments.
 */
@Module({
  imports: [AuthModule, AttestationModule],
  controllers: [ReviewersController, ReviewsController],
  providers: [ReviewService, ReviewScheduler],
  exports: [ReviewService],
})
export class ReviewModule {}
