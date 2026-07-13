import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ApiClientsController } from './api-clients.controller';
import { ApiClientsService } from './api-clients.service';
import { ApiKeyGuard } from './api-key.guard';

/**
 * Public API client management (Phase 7). Imports AuthModule for the JWT/permission
 * guards used by the management controller. Exports {@link ApiClientsService} and
 * {@link ApiKeyGuard} so the public `/api/v1` module can authenticate machine
 * callers. Uses the global Prisma/Audit modules.
 */
@Module({
  imports: [AuthModule],
  controllers: [ApiClientsController],
  providers: [ApiClientsService, ApiKeyGuard],
  exports: [ApiClientsService, ApiKeyGuard],
})
export class ApiClientsModule {}
