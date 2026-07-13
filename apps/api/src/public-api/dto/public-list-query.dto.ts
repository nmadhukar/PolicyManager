import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** Filters + pagination for GET /api/v1/documents. */
export class PublicListQueryDto {
  @ApiPropertyOptional({ description: 'Free-text over title, number, and description.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({ description: 'Restrict to a category id (must be within the client scope).' })
  @IsOptional()
  @IsString()
  categoryId?: string;

  @ApiPropertyOptional({ description: 'Restrict to documents carrying this tag.' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  tag?: string;

  @ApiPropertyOptional({ description: 'ISO timestamp; only documents updated at/after this.' })
  @IsOptional()
  @IsString()
  updatedSince?: string;

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
}
