import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ANNOTATION_TYPES, type AnnotationType } from '@policymanager/shared';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class CreateAnnotationDto {
  @ApiPropertyOptional({ enum: ANNOTATION_TYPES as unknown as string[] })
  @IsOptional()
  @IsIn(ANNOTATION_TYPES as unknown as string[])
  type?: AnnotationType;

  @ApiProperty({ minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageNumber!: number;

  @ApiProperty({ minimum: 0, maximum: 1 })
  @Type(() => Number)
  @Min(0)
  @Max(1)
  x!: number;

  @ApiProperty({ minimum: 0, maximum: 1 })
  @Type(() => Number)
  @Min(0)
  @Max(1)
  y!: number;

  @ApiProperty({ minimum: 0.001, maximum: 1 })
  @Type(() => Number)
  @Min(0.001)
  @Max(1)
  width!: number;

  @ApiProperty({ minimum: 0.001, maximum: 1 })
  @Type(() => Number)
  @Min(0.001)
  @Max(1)
  height!: number;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  body!: string;
}
