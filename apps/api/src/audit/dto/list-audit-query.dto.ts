import { ApiPropertyOptional } from '@nestjs/swagger';
import { AUDIT_SOURCES, type AuditSource } from '@policymanager/shared';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * Filters + pagination for `GET /api/audit`. All wire values are strings;
 * `@Type` coerces the numeric ones under the global transforming ValidationPipe.
 */
export class ListAuditQueryDto {
  @ApiPropertyOptional({ description: 'Filter by the acting user id.' })
  @IsOptional()
  @IsString()
  actorUserId?: string;

  @ApiPropertyOptional({ description: 'Filter by the target document id.' })
  @IsOptional()
  @IsString()
  documentId?: string;

  @ApiPropertyOptional({ description: 'Exact audit action, e.g. document.downloaded.' })
  @IsOptional()
  @IsString()
  action?: string;

  @ApiPropertyOptional({ enum: AUDIT_SOURCES as unknown as string[] })
  @IsOptional()
  @IsIn(AUDIT_SOURCES as unknown as string[])
  source?: AuditSource;

  @ApiPropertyOptional({ description: 'Inclusive lower bound on time (ISO).' })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional({ description: 'Inclusive upper bound on time (ISO).' })
  @IsOptional()
  @IsString()
  to?: string;

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
