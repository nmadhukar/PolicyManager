import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

/**
 * Global audit module so any feature (documents, auth, access control) can inject
 * the shared {@link AuditService} without re-wiring. Imports AuthModule for the
 * guards used by {@link AuditController}. Exports AuditService for cross-module use.
 */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
