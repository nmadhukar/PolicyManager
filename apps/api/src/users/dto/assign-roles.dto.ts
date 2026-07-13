import { ApiProperty } from '@nestjs/swagger';
import { ArrayUnique, IsArray, IsString } from 'class-validator';

export class AssignRolesDto {
  @ApiProperty({
    type: [String],
    description: 'Full set of role names for the user (replaces existing assignments).',
    example: ['Manager', 'Auditor'],
  })
  @IsArray()
  @IsString({ each: true })
  @ArrayUnique()
  roles!: string[];
}
