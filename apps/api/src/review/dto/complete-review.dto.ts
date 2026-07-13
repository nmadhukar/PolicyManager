import { ApiPropertyOptional } from '@nestjs/swagger';
import type { CompleteReviewInput } from '@policymanager/shared';
import { IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body for POST /reviews/:taskId/complete. `newNextReviewDate` is REQUIRED by the
 * service when the document cadence is `none`/`custom`; for `quarterly`/`annual` it
 * is an optional override (otherwise the date auto-advances from completion day).
 */
export class CompleteReviewDto implements CompleteReviewInput {
  @ApiPropertyOptional({ description: 'Reviewer notes captured on the task.' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;

  @ApiPropertyOptional({ description: 'ISO date for the next review (required for none/custom cadence).' })
  @IsOptional()
  @IsISO8601()
  newNextReviewDate?: string;
}
