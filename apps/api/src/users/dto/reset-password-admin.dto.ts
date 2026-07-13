import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export class ResetPasswordAdminDto {
  @ApiProperty({
    enum: ['temp', 'email'],
    description:
      "`temp` sets a temporary password returned to the admin once (user must change it); " +
      "`email` sends the user a self-service reset link.",
  })
  @IsIn(['temp', 'email'])
  mode!: 'temp' | 'email';
}
