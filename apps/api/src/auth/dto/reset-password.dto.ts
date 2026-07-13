import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';
import { PASSWORD_MIN_LENGTH } from '@policymanager/shared';

export class ResetPasswordDto {
  @ApiProperty({ description: 'The raw reset token from the emailed link.' })
  @IsString()
  @MinLength(1)
  token!: string;

  @ApiProperty({ description: 'The new password (policy enforced server-side).', minLength: PASSWORD_MIN_LENGTH })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  newPassword!: string;
}
