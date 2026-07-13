import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AttestationModule } from '../attestation/attestation.module';
import { DocumentsModule } from '../documents/documents.module';
import { EvidenceBinderController } from './evidence-binder.controller';
import { EvidenceBinderService } from './evidence-binder.service';

@Module({
  imports: [AuthModule, DocumentsModule, AttestationModule],
  controllers: [EvidenceBinderController],
  providers: [EvidenceBinderService],
})
export class EvidenceModule {}
