import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Create a document category (folder). `parentId` nests it under another. */
export class CreateCategoryDto {
  @ApiProperty({ example: 'Policies & Procedures' })
  @IsString()
  @MinLength(1, { message: 'name is required' })
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({ description: 'Parent category id for a nested folder.' })
  @IsOptional()
  @IsString()
  parentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;
}
