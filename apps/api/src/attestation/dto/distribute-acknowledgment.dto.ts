import { ApiPropertyOptional } from '@nestjs/swagger';
import type { DistributeAcknowledgmentInput } from '@policymanager/shared';
import { ArrayMaxSize, IsArray, IsISO8601, IsOptional, IsString } from 'class-validator';

/**
 * Body for POST /documents/:id/acknowledgments. Supply explicit `assigneeIds`
 * and/or `roleNames` (expanded to their members); the union is de-duplicated and
 * assigned idempotently against the document's current version.
 */
export class DistributeAcknowledgmentDto implements DistributeAcknowledgmentInput {
  @ApiPropertyOptional({ description: 'Explicit user ids to assign.', type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  assigneeIds?: string[];

  @ApiPropertyOptional({ description: 'Role names whose members are assigned.', type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  roleNames?: string[];

  @ApiPropertyOptional({ description: 'Optional ISO due date for the assignments.' })
  @IsOptional()
  @IsISO8601()
  dueDate?: string;
}
