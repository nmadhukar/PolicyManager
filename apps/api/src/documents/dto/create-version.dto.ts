import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Multipart body accompanying a new-version file upload. The file itself is read
 * from the `file` part by FileInterceptor; this carries the optional change note.
 */
export class CreateVersionDto {
  @ApiPropertyOptional({ description: 'What changed in this version (revision history).' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  changeSummary?: string;
}
