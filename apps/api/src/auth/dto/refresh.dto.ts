import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class RefreshDto {
  @ApiProperty({ description: 'The raw refresh token issued at login/refresh.' })
  @IsString()
  @MinLength(1)
  refreshToken!: string;
}
