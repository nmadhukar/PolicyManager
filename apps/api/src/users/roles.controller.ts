import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@policymanager/shared';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Read-only role catalog for the admin UI's role picker. Gated by `user.manage`.
 */
@ApiTags('roles')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.USER_MANAGE)
@Controller('roles')
export class RolesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'List all roles (for assignment UI).' })
  async list() {
    const roles = await this.prisma.role.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true, description: true, isSystem: true },
    });
    return roles;
  }
}
