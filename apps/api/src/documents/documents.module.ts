import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DocumentCategoriesController } from './document-categories.controller';
import { DocumentCategoriesService } from './document-categories.service';
import { DocumentsEditorController } from './documents-editor.controller';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { OnlyOfficeService } from './onlyoffice.service';
import { RenditionService } from './rendition.service';
import { TextExtractionService } from './text-extraction.service';

/**
 * Documents & Versioning (Phase 3 + 3b viewing/editing). Depends on the global
 * StorageModule for S3Service and AuthModule for the guards/strategy.
 */
@Module({
  imports: [AuthModule],
  controllers: [DocumentsController, DocumentsEditorController, DocumentCategoriesController],
  providers: [
    DocumentsService,
    DocumentCategoriesService,
    TextExtractionService,
    RenditionService,
    OnlyOfficeService,
  ],
  exports: [DocumentsService],
})
export class DocumentsModule {}
