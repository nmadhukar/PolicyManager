import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ACCESS_LEVELS,
  REVIEW_CADENCES,
  type AccessLevel,
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
 * Create a logical Document. `title` is REQUIRED; the owner defaults to the
 * authenticated user server-side. Bytes are added separately via the versions
 * endpoint, so a document starts with no current version (status = draft).
 */
export class CreateDocumentDto {
  @ApiProperty({ example: 'Seclusion & Restraint Policy' })
  @IsString()
  @MinLength(1, { message: 'title is required' })
  @MaxLength(300)
  title!: string;

  @ApiPropertyOptional({ example: 'PP-042' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  documentNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  categoryId?: string;

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

  @ApiPropertyOptional({ enum: ACCESS_LEVELS as unknown as string[] })
  @IsOptional()
  @IsIn(ACCESS_LEVELS as unknown as string[])
  accessLevel?: AccessLevel;

  @ApiPropertyOptional({ enum: REVIEW_CADENCES as unknown as string[] })
  @IsOptional()
  @IsIn(REVIEW_CADENCES as unknown as string[])
  reviewCadence?: ReviewCadence;

  @ApiPropertyOptional({ example: '2026-09-01' })
  @IsOptional()
  @IsISO8601()
  nextReviewDate?: string;

  @ApiPropertyOptional({ example: '2026-01-15' })
  @IsOptional()
  @IsISO8601()
  effectiveDate?: string;
}
