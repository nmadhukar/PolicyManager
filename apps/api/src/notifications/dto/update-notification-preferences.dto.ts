import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  NOTIFICATION_DIGEST_FREQUENCIES,
  type NotificationDigestFrequency,
} from '@policymanager/shared';
import { IsBoolean, IsIn, IsObject, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class UpdateNotificationPreferencesDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  inAppEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  emailDigestEnabled?: boolean;

  @ApiPropertyOptional({ enum: NOTIFICATION_DIGEST_FREQUENCIES as unknown as string[] })
  @IsOptional()
  @IsIn(NOTIFICATION_DIGEST_FREQUENCIES as unknown as string[])
  digestFrequency?: NotificationDigestFrequency;

  @ApiPropertyOptional({ description: 'Local HH:mm digest time.' })
  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  digestTimeLocal?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  timezone?: string;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  typeOverrides?: Record<string, unknown>;
}
