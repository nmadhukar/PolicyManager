import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SmtpController } from './smtp.controller';
import { SmtpService } from './smtp.service';

/**
 * SMTP admin (Phase 5, PM-0507). Uses the global MailService/PrismaService/
 * AuditService and the AuthModule guards. All routes are gated by `smtp.manage`.
 */
@Module({
  imports: [AuthModule],
  controllers: [SmtpController],
  providers: [SmtpService],
})
export class SmtpModule {}
