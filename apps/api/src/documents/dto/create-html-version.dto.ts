import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body for saving an app-authored (TipTap) HTML document as a new version. The
 * HTML is stored as the version's bytes (mime `text/html`) and a PDF rendition
 * is generated. Save == a new immutable version (AGENTS.md §10a).
 */
export class CreateHtmlVersionDto {
  @ApiProperty({ description: 'The document body as sanitized HTML.' })
  @IsString()
  // Generous cap: a large rich-text doc, but bounded to avoid abuse.
  @MaxLength(5_000_000)
  html!: string;

  @ApiPropertyOptional({ description: 'What changed in this version (revision history).' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  changeSummary?: string;
}
