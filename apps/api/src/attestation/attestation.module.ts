import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DocumentsModule } from '../documents/documents.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AcknowledgmentService } from './acknowledgment.service';
import { AcknowledgmentsController } from './acknowledgments.controller';
import { AttestationService } from './attestation.service';
import { CoverPageService } from './cover-page.service';
import { DocumentApprovalService } from './document-approval.service';
import { DocumentSignoffController } from './document-signoff.controller';

/**
 * Attestation (sign-off), cover page, and staff acknowledgment distribution
 * (Phase 6). Depends on:
 *  - AuthModule for the JWT + permission guards,
 *  - DocumentsModule for DocumentAccessService (confidential ACL enforcement),
 *  - the global StorageModule (S3Service) + AuditModule (AuditService).
 *
 * Exports AttestationService + AcknowledgmentService so ReviewModule can fill the
 * Phase 5 completion seam (record a `reviewed` sign-off) and sweep acknowledgments.
 */
@Module({
  imports: [AuthModule, DocumentsModule, NotificationsModule],
  controllers: [DocumentSignoffController, AcknowledgmentsController],
  providers: [
    AttestationService,
    AcknowledgmentService,
    CoverPageService,
    DocumentApprovalService,
  ],
  exports: [AttestationService, AcknowledgmentService, CoverPageService],
})
export class AttestationModule {}
