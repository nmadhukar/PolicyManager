import { ApiProperty } from '@nestjs/swagger';
import {
  ACL_PERMISSIONS,
  ACL_PRINCIPAL_TYPES,
  type AclPermission,
  type AclPrincipalType,
} from '@policymanager/shared';
import { IsIn, IsString, MinLength } from 'class-validator';

/** Body for POST /documents/:id/acl — grants a principal a capability. */
export class AddAclDto {
  @ApiProperty({ enum: ACL_PRINCIPAL_TYPES as unknown as string[] })
  @IsIn(ACL_PRINCIPAL_TYPES as unknown as string[])
  principalType!: AclPrincipalType;

  @ApiProperty({ description: 'A roleId when principalType=role, else a userId.' })
  @IsString()
  @MinLength(1)
  principalId!: string;

  @ApiProperty({ enum: ACL_PERMISSIONS as unknown as string[] })
  @IsIn(ACL_PERMISSIONS as unknown as string[])
  permission!: AclPermission;
}
