import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

/**
 * A single grounded-chat question. `message` is REQUIRED and length-bounded to
 * keep prompts sane. `conversationId` continues an existing thread — if it is
 * absent, unknown, or not owned by the caller, the service starts a fresh one.
 */
export class ChatRequestDto {
  @ApiProperty({ example: 'What is our seclusion and restraint policy?' })
  @IsString()
  @MinLength(1, { message: 'message is required' })
  @MaxLength(4000)
  message!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  conversationId?: string;
}
