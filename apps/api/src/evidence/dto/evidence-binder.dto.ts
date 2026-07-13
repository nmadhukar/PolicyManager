import { ApiProperty } from '@nestjs/swagger';
import { EVIDENCE_BINDER_FORMATS, type EvidenceBinderFormat } from '@policymanager/shared';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';

export class EvidenceBinderDto {
  @ApiProperty({ enum: EVIDENCE_BINDER_FORMATS as unknown as string[] })
  @IsIn(EVIDENCE_BINDER_FORMATS as unknown as string[])
  format!: EvidenceBinderFormat;

  @IsOptional()
  @IsBoolean()
  includePolicyPdf?: boolean;

  @IsOptional()
  @IsBoolean()
  includeCoverPage?: boolean;

  @IsOptional()
  @IsBoolean()
  includeApprovalChain?: boolean;

  @IsOptional()
  @IsBoolean()
  includeAcknowledgmentRoster?: boolean;

  @IsOptional()
  @IsBoolean()
  includeReviewHistory?: boolean;

  @IsOptional()
  @IsBoolean()
  includeRevisionHistory?: boolean;

  @IsOptional()
  @IsBoolean()
  includeAuditLog?: boolean;
}
