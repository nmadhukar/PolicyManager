import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

export class ForgotPasswordDto {
  @ApiProperty({ example: 'jane.doe@policymanager.local' })
  @IsEmail()
  email!: string;
}
