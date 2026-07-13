import { ApiPropertyOptional } from '@nestjs/swagger';
import type { ApproveDocumentInput } from '@policymanager/shared';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body for POST /documents/:id/approve. All fields optional: `signatureName`
 * defaults to the acting user's name server-side; `publish` promotes the document
 * to `published` (and re-triggers acknowledgment) instead of `approved`.
 */
export class ApproveDocumentDto implements ApproveDocumentInput {
  @ApiPropertyOptional({ description: 'Typed sign-off name (defaults to the acting user).' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  signatureName?: string;

  @ApiPropertyOptional({ description: "Signer's role/title recorded with the sign-off." })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  signatureRole?: string;

  @ApiPropertyOptional({ description: 'Optional sign-off comments.' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  comments?: string;

  @ApiPropertyOptional({ description: 'Publish (vs approve): sets status=published and re-triggers acknowledgment.' })
  @IsOptional()
  @IsBoolean()
  publish?: boolean;
}
