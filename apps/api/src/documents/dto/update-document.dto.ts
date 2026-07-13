import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ACCESS_LEVELS,
  DOCUMENT_STATUSES,
  REVIEW_CADENCES,
  type AccessLevel,
  type DocumentStatus,
  type ReviewCadence,
} from '@policymanager/shared';
import {
  ArrayUnique,
  IsArray,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Partial metadata update. Every field is optional; only provided fields change.
 * `tags` REPLACES the full set (the UI computes add/remove and sends the result),
 * and `status` drives the lifecycle (draft -> in_review -> ... -> retired).
 * Date fields accept `null` to clear them.
 */
export class UpdateDocumentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  documentNumber?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  categoryId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayUnique()
  tags?: string[];

  @ApiPropertyOptional({ enum: DOCUMENT_STATUSES as unknown as string[] })
  @IsOptional()
  @IsIn(DOCUMENT_STATUSES as unknown as string[])
  status?: DocumentStatus;

  @ApiPropertyOptional({ enum: ACCESS_LEVELS as unknown as string[] })
  @IsOptional()
  @IsIn(ACCESS_LEVELS as unknown as string[])
  accessLevel?: AccessLevel;

  @ApiPropertyOptional({ enum: REVIEW_CADENCES as unknown as string[] })
  @IsOptional()
  @IsIn(REVIEW_CADENCES as unknown as string[])
  reviewCadence?: ReviewCadence;

  @ApiPropertyOptional({ nullable: true, example: '2026-09-01' })
  @IsOptional()
  @IsISO8601()
  nextReviewDate?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '2026-01-15' })
  @IsOptional()
  @IsISO8601()
  effectiveDate?: string | null;
}
