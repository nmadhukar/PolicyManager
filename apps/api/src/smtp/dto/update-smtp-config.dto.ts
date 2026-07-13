import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { UpdateSmtpConfigInput } from '@policymanager/shared';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Body for PUT /smtp/config. `password` is WRITE-ONLY: it is never echoed back by
 * the API and, when present, is AES-256-GCM encrypted before storage (AGENTS.md
 * §8). Omit `password` to keep the stored one; send an empty string to clear it.
 */
export class UpdateSmtpConfigDto implements UpdateSmtpConfigInput {
  @ApiProperty({ example: 'smtp.example.com' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  host!: string;

  @ApiProperty({ example: 587, minimum: 1, maximum: 65535 })
  @IsInt()
  @Min(1)
  @Max(65535)
  port!: number;

  @ApiProperty({ description: 'Use implicit TLS (SMTPS, typically port 465).' })
  @IsBoolean()
  secure!: boolean;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  username?: string | null;

  @ApiPropertyOptional({
    description: 'Write-only. Omit to keep the current password; empty string clears it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  password?: string;

  @ApiProperty({ example: 'noreply@clinic.example' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  fromAddress!: string;

  @ApiProperty({ example: 'PolicyManager' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  fromName!: string;

  @ApiProperty({ description: 'When true, MailService uses this config over the SMTP_* env.' })
  @IsBoolean()
  enabled!: boolean;
}
