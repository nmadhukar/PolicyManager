import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

/** Body for POST /documents/:id/reviewers — assigns a user as a reviewer. */
export class AssignReviewerDto {
  @ApiProperty({ description: 'The userId to assign as a reviewer for this document.' })
  @IsString()
  @MinLength(1)
  reviewerId!: string;
}
