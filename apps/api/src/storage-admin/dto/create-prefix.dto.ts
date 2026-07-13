import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

/** Body for creating a folder (prefix) marker within a bucket. The full folder
 *  path is given in `prefix` (e.g. "policies/intake") and normalized server-side. */
export class CreatePrefixDto {
  @ApiProperty({ description: 'Target bucket.' })
  @IsString()
  @MaxLength(63)
  bucket!: string;

  @ApiProperty({ description: 'Folder path, e.g. "policies/intake". Normalized server-side.' })
  @IsString()
  @MaxLength(1024)
  prefix!: string;
}
