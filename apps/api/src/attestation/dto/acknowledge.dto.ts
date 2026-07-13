import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { AcknowledgeInput } from '@policymanager/shared';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body for POST /acknowledgments/:id/acknowledge. `hasViewed` MUST be true — the
 * assignee has to open and read the document before the acknowledge is accepted
 * (AGENTS.md §10b). `signatureName` defaults to the acting user's name.
 */
export class AcknowledgeDto implements AcknowledgeInput {
  @ApiProperty({ description: 'Must be true — confirms the assignee has read the document.' })
  @IsBoolean()
  hasViewed!: boolean;

  @ApiPropertyOptional({ description: 'Typed sign-off name (defaults to the acting user).' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  signatureName?: string;

  @ApiPropertyOptional({ description: "Signer's role/title recorded with the acknowledgment." })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  signatureRole?: string;

  @ApiPropertyOptional({ description: 'Optional acknowledgment comments.' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  comments?: string;
}
