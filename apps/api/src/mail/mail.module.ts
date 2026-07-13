import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';

/**
 * Reusable mailer. Marked @Global so any feature module (auth password flows now,
 * review reminders in Phase 5) can inject MailService without re-importing.
 */
@Global()
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
