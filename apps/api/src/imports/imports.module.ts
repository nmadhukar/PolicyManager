import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DocumentsModule } from '../documents/documents.module';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';

/**
 * Import & Consolidation (Phase 8). Imports AuthModule for the JWT/permission
 * guards and DocumentsModule for {@link DocumentsService} (document creation +
 * immutable version upload are REUSED, never duplicated). Prisma, Storage, and
 * Audit come from their global modules.
 */
@Module({
  imports: [AuthModule, DocumentsModule],
  controllers: [ImportsController],
  providers: [ImportsService],
})
export class ImportsModule {}
