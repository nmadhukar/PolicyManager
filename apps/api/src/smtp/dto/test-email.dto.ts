import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

/** Body for POST /smtp/test — sends a one-off test message to `to`. */
export class TestEmailDto {
  @ApiProperty({ example: 'me@clinic.example', description: 'Recipient of the test email.' })
  @IsEmail()
  to!: string;
}
