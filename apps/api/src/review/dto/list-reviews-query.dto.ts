import { ApiPropertyOptional } from '@nestjs/swagger';
import { REVIEW_TASK_STATUSES, type ReviewTaskStatus } from '@policymanager/shared';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** Coerces a wire string ('true'/'false') or real boolean into a boolean. */
const toBool = ({ value }: { value: unknown }): boolean => value === true || value === 'true';

/**
 * Filters + pagination for GET /reviews. Non-managers are ALWAYS scoped to their
 * own tasks server-side regardless of these filters; `mine=true` lets a manager
 * request their own tasks explicitly.
 */
export class ListReviewsQueryDto {
  @ApiPropertyOptional({ description: 'Filter by assignee userId (managers only).' })
  @IsOptional()
  @IsString()
  assignedToId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  documentId?: string;

  @ApiPropertyOptional({ enum: REVIEW_TASK_STATUSES as unknown as string[] })
  @IsOptional()
  @IsIn(REVIEW_TASK_STATUSES as unknown as string[])
  status?: ReviewTaskStatus;

  @ApiPropertyOptional({ description: 'dueDate >= this date (ISO).' })
  @IsOptional()
  @IsString()
  dueFrom?: string;

  @ApiPropertyOptional({ description: 'dueDate <= this date (ISO).' })
  @IsOptional()
  @IsString()
  dueTo?: string;

  @ApiPropertyOptional({ description: 'Restrict to the caller\'s own tasks.' })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  mine?: boolean;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;
}
