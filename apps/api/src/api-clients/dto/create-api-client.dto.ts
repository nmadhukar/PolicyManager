import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { API_SCOPES, type ApiScope, type CreateApiClientInput } from '@policymanager/shared';
import { ArrayNotEmpty, IsArray, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Body for POST /api-clients — create a public API client. */
export class CreateApiClientDto implements CreateApiClientInput {
  @ApiProperty({ example: 'EMR Integration', maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiProperty({
    isArray: true,
    enum: API_SCOPES as unknown as string[],
    description: 'documents:read (baseline), content:read, download.',
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(API_SCOPES as unknown as string[], { each: true })
  scopes!: ApiScope[];

  @ApiPropertyOptional({
    isArray: true,
    type: String,
    description: 'Restrict visibility to these category ids. Empty/omitted = all categories.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedCategoryIds?: string[];
}
