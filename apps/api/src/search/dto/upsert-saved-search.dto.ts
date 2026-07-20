import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SAVED_SEARCH_SCOPES, type SavedSearchScope } from '@policymanager/shared';
import { IsIn, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { MaxJsonSize } from './max-json-size.validator';

/**
 * FINDING-017: a saved search's filters/sort are a handful of field/value
 * pairs in normal use — this generously bounds them while staying far above
 * any legitimate size, so it only rejects abuse.
 */
const MAX_SAVED_SEARCH_JSON_BYTES = 50_000;

export class UpsertSavedSearchDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ enum: SAVED_SEARCH_SCOPES as unknown as string[] })
  @IsOptional()
  @IsIn(SAVED_SEARCH_SCOPES as unknown as string[])
  scope?: SavedSearchScope;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  roleName?: string | null;

  @ApiProperty({ type: Object })
  @IsObject()
  @MaxJsonSize(MAX_SAVED_SEARCH_JSON_BYTES)
  filters!: Record<string, unknown>;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  @MaxJsonSize(MAX_SAVED_SEARCH_JSON_BYTES)
  sort?: Record<string, unknown> | null;
}
