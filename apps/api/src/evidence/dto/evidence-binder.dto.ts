import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EVIDENCE_BINDER_FORMATS, type EvidenceBinderFormat } from '@policymanager/shared';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';

export class EvidenceBinderDto {
  @ApiProperty({ enum: EVIDENCE_BINDER_FORMATS as unknown as string[] })
  @IsIn(EVIDENCE_BINDER_FORMATS as unknown as string[])
  format!: EvidenceBinderFormat;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  includePolicyPdf?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  includeCoverPage?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  includeApprovalChain?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  includeAcknowledgmentRoster?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  includeReviewHistory?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  includeRevisionHistory?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  includeAuditLog?: boolean;
}
