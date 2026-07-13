import { Module } from '@nestjs/common';
import { ApiClientsModule } from '../api-clients/api-clients.module';
import { PublicDocumentsController } from './public-documents.controller';
import { PublicDocumentsService } from './public-documents.service';

/**
 * Public read-only API v1 (`/api/v1`). Imports {@link ApiClientsModule} for the
 * {@link ApiKeyGuard} + client authentication; uses the global Prisma/Storage/
 * Audit modules for data, presigned URLs, and the per-call audit trail.
 */
@Module({
  imports: [ApiClientsModule],
  controllers: [PublicDocumentsController],
  providers: [PublicDocumentsService],
})
export class PublicApiModule {}
