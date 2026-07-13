import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ACCESS_LEVELS,
  DOCUMENT_SORT_FIELDS,
  DOCUMENT_STATUSES,
  type AccessLevel,
  type DocumentSortField,
  type DocumentStatus,
  type SortOrder,
} from '@policymanager/shared';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

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

  @ApiPropertyOptional({ enum: DOCUMENT_STATUSES as unknown as string[] })
  @IsOptional()
  @IsIn(DOCUMENT_STATUSES as unknown as string[])
  status?: DocumentStatus;

  @ApiPropertyOptional({ enum: ACCESS_LEVELS as unknown as string[] })
  @IsOptional()
  @IsIn(ACCESS_LEVELS as unknown as string[])
  accessLevel?: AccessLevel;

  @ApiPropertyOptional({ description: 'nextReviewDate <= this date (ISO).' })
  @IsOptional()
  @IsString()
  reviewBefore?: string;

  @ApiPropertyOptional({ description: 'nextReviewDate >= this date (ISO).' })
  @IsOptional()
  @IsString()
  reviewAfter?: string;

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
