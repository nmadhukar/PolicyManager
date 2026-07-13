import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DocumentAccessService } from './document-access.service';
import { DocumentAclController } from './document-acl.controller';
import { DocumentAclService } from './document-acl.service';
import { DocumentCategoriesController } from './document-categories.controller';
import { DocumentCategoriesService } from './document-categories.service';
import { DocumentsEditorController } from './documents-editor.controller';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { OnlyOfficeService } from './onlyoffice.service';
import { RenditionService } from './rendition.service';
import { TextExtractionService } from './text-extraction.service';

/**
 * Documents & Versioning (Phase 3) + viewing/editing (3b) + access control &
 * audit (Phase 4). Depends on the global StorageModule for S3Service, the global
 * AuditModule for AuditService, and AuthModule for the guards/strategy.
 */
@Module({
  imports: [AuthModule],
  controllers: [
    DocumentsController,
    DocumentsEditorController,
    DocumentCategoriesController,
    DocumentAclController,
  ],
  providers: [
    DocumentsService,
    DocumentAccessService,
    DocumentAclService,
    DocumentCategoriesService,
    TextExtractionService,
    RenditionService,
    OnlyOfficeService,
  ],
  exports: [DocumentsService, DocumentAccessService],
})
export class DocumentsModule {}
