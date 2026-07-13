import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SAVED_SEARCH_SCOPES, type SavedSearchScope } from '@policymanager/shared';
import { IsIn, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

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
  filters!: Record<string, unknown>;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  sort?: Record<string, unknown> | null;
}
