import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import {
  ACCESS_LEVELS,
  DOCUMENT_DUE_STATES,
  DOCUMENT_STATUSES,
  EXTRACTION_STATUSES,
  REVIEW_CADENCES,
  type AccessLevel,
  type DocumentDueState,
  type DocumentStatus,
  type ExtractionStatus,
  type ReviewCadence,
} from '@policymanager/shared';
import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsISO8601,
  IsIn,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

/**
 * Filter subset accepted by the bulk review scheduler. It mirrors the library
 * filters but intentionally omits paging/sorting and never exposes the trash
 * (`deleted`) flag; bulk scheduling must not touch soft-deleted documents.
 */
export class BulkReviewScheduleFiltersDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  categoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ownerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  tag?: string;

  @ApiPropertyOptional({ description: 'Comma-separated tags; all listed tags must be present.' })
  @IsOptional()
  @IsString()
  tags?: string;

  @ApiPropertyOptional({ enum: DOCUMENT_STATUSES as unknown as string[] })
  @IsOptional()
  @IsIn(DOCUMENT_STATUSES as unknown as string[])
  status?: DocumentStatus;

  @ApiPropertyOptional({ enum: ACCESS_LEVELS as unknown as string[] })
  @IsOptional()
  @IsIn(ACCESS_LEVELS as unknown as string[])
  accessLevel?: AccessLevel;

  @ApiPropertyOptional({ enum: EXTRACTION_STATUSES as unknown as string[] })
  @IsOptional()
  @IsIn(EXTRACTION_STATUSES as unknown as string[])
  extractionStatus?: ExtractionStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reviewBefore?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reviewAfter?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  effectiveBefore?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  effectiveAfter?: string;

  @ApiPropertyOptional({ enum: DOCUMENT_DUE_STATES as unknown as string[] })
  @IsOptional()
  @IsIn(DOCUMENT_DUE_STATES as unknown as string[])
  dueState?: DocumentDueState;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  includeArchived?: boolean;
}

export class BulkReviewScheduleDto {
  @ApiPropertyOptional({
    type: [String],
    description: 'Explicit document ids selected in the library table.',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  documentIds?: string[];

  @ApiPropertyOptional({
    type: BulkReviewScheduleFiltersDto,
    description: 'Current library filters; targets every matching active document.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => BulkReviewScheduleFiltersDto)
  filters?: BulkReviewScheduleFiltersDto;

  @ApiProperty({ enum: REVIEW_CADENCES as unknown as string[] })
  @IsIn(REVIEW_CADENCES as unknown as string[])
  reviewCadence!: ReviewCadence;

  @ApiPropertyOptional({ nullable: true, example: '2026-10-01' })
  @IsOptional()
  @IsISO8601()
  nextReviewDate?: string | null;
}

export class UpdateReviewScheduleDto {
  @ApiProperty({ enum: REVIEW_CADENCES as unknown as string[] })
  @IsIn(REVIEW_CADENCES as unknown as string[])
  reviewCadence!: ReviewCadence;

  @ApiPropertyOptional({ nullable: true, example: '2026-10-01' })
  @IsOptional()
  @IsISO8601()
  nextReviewDate?: string | null;
}
