import { ApiPropertyOptional } from '@nestjs/swagger';
import { NOTIFICATION_TYPES, type NotificationType } from '@policymanager/shared';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

/** Filters + pagination for GET /smtp/notifications (newest-first delivery log). */
export class ListNotificationsQueryDto {
  @ApiPropertyOptional({ enum: NOTIFICATION_TYPES as unknown as string[] })
  @IsOptional()
  @IsIn(NOTIFICATION_TYPES as unknown as string[])
  type?: NotificationType;

  @ApiPropertyOptional({ enum: ['sent', 'failed'] })
  @IsOptional()
  @IsIn(['sent', 'failed'])
  status?: 'sent' | 'failed';

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;
}
