import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ACCESS_LEVELS,
  DOCUMENT_SORT_FIELDS,
  DOCUMENT_STATUSES,
  DOCUMENT_DUE_STATES,
  EXTRACTION_STATUSES,
  type AccessLevel,
  type DocumentDueState,
  type DocumentSortField,
  type DocumentStatus,
  type ExtractionStatus,
  type SortOrder,
} from '@policymanager/shared';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** Coerces a wire string ('true'/'false') or real boolean into a boolean. */
const toBool = ({ value }: { value: unknown }): boolean => value === true || value === 'true';

/**
 * Query parameters for the paginated/sortable document library. All values are
 * strings on the wire; `@Type` coerces the numeric ones under the global
 * transforming ValidationPipe.
 */
export class ListDocumentsQueryDto {
  @ApiPropertyOptional({ description: 'Free-text search over title/number/description.' })
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

  @ApiPropertyOptional({ description: 'Match documents carrying this tag.' })
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

  @ApiPropertyOptional({
    enum: EXTRACTION_STATUSES as unknown as string[],
    description: 'Filter to documents whose current version has this extraction status.',
  })
  @IsOptional()
  @IsIn(EXTRACTION_STATUSES as unknown as string[])
  extractionStatus?: ExtractionStatus;

  @ApiPropertyOptional({ description: 'nextReviewDate <= this date (ISO).' })
  @IsOptional()
  @IsString()
  reviewBefore?: string;

  @ApiPropertyOptional({ description: 'nextReviewDate >= this date (ISO).' })
  @IsOptional()
  @IsString()
  reviewAfter?: string;

  @ApiPropertyOptional({ description: 'effectiveDate <= this date (ISO).' })
  @IsOptional()
  @IsString()
  effectiveBefore?: string;

  @ApiPropertyOptional({ description: 'effectiveDate >= this date (ISO).' })
  @IsOptional()
  @IsString()
  effectiveAfter?: string;

  @ApiPropertyOptional({ enum: DOCUMENT_DUE_STATES as unknown as string[] })
  @IsOptional()
  @IsIn(DOCUMENT_DUE_STATES as unknown as string[])
  dueState?: DocumentDueState;

  @ApiPropertyOptional({
    description: 'Trash view: only soft-deleted documents. Requires document.write.',
  })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  deleted?: boolean;

  @ApiPropertyOptional({ description: 'Include archived documents in the active list.' })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  includeArchived?: boolean;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  @ApiPropertyOptional({ enum: DOCUMENT_SORT_FIELDS as unknown as string[] })
  @IsOptional()
  @IsIn(DOCUMENT_SORT_FIELDS as unknown as string[])
  sort?: DocumentSortField;

  @ApiPropertyOptional({ enum: ['asc', 'desc'] })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: SortOrder;
}
