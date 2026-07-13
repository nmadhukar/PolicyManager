import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/** Body for creating a private, versioned bucket. Name is validated in depth
 *  server-side (DNS-style rules) before any S3 call. */
export class CreateBucketDto {
  @ApiProperty({ description: 'DNS-style bucket name (lowercase, 3–63 chars).' })
  @IsString()
  @MinLength(3)
  @MaxLength(63)
  name!: string;
}
