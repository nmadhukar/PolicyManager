import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DocumentCategoriesController } from './document-categories.controller';
import { DocumentCategoriesService } from './document-categories.service';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { TextExtractionService } from './text-extraction.service';

/**
 * Documents & Versioning (Phase 3). Depends on the global StorageModule for
 * S3Service and AuthModule for the guards/strategy.
 */
@Module({
  imports: [AuthModule],
  controllers: [DocumentsController, DocumentCategoriesController],
  providers: [DocumentsService, DocumentCategoriesService, TextExtractionService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
