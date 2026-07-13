import { ApiPropertyOptional } from '@nestjs/swagger';
import { API_SCOPES, type ApiScope, type UpdateApiClientInput } from '@policymanager/shared';
import { IsArray, IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';

/** Body for PATCH /api-clients/:id — adjust scopes, category allow-list, enabled. */
export class UpdateApiClientDto implements UpdateApiClientInput {
  @ApiPropertyOptional({ isArray: true, enum: API_SCOPES as unknown as string[] })
  @IsOptional()
  @IsArray()
  @IsIn(API_SCOPES as unknown as string[], { each: true })
  scopes?: ApiScope[];

  @ApiPropertyOptional({ isArray: true, type: String })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedCategoryIds?: string[];

  @ApiPropertyOptional({ description: 'Disable/enable the client without revoking it.' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
