import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@policymanager/shared';
import type { AuthUser } from '@policymanager/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { AssignRolesDto } from './dto/assign-roles.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { ResetPasswordAdminDto } from './dto/reset-password-admin.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UsersService } from './users.service';

/**
 * Admin user management. Every route requires `user.manage` and is enforced
 * server-side (JwtAuthGuard -> PermissionsGuard). Password hashes are never
 * returned. Self-destructive actions (disable/lock on own account) are blocked
 * in the service.
 */
@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.USER_MANAGE)
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'List all users.' })
  list() {
    return this.users.list();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a user by id.' })
  get(@Param('id') id: string) {
    return this.users.get(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a user with a temporary password (returned once).' })
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a user (name, title, status).' })
  update(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.users.update(id, dto);
  }

  @Post(':id/disable')
  @ApiOperation({ summary: 'Disable a user and revoke their refresh tokens.' })
  disable(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    return this.users.setStatus(id, 'disabled', actor.id);
  }

  @Post(':id/enable')
  @ApiOperation({ summary: 'Re-enable a disabled user.' })
  enable(@Param('id') id: string) {
    return this.users.setStatus(id, 'active');
  }

  @Post(':id/lock')
  @ApiOperation({ summary: 'Lock a user out of sign-in (credential lockout, distinct from disable).' })
  lock(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    return this.users.lockUser(id, actor.id);
  }

  @Post(':id/unlock')
  @ApiOperation({ summary: 'Clear a user lock and reset their failed-login counter.' })
  unlock(@Param('id') id: string) {
    return this.users.unlockUser(id);
  }

  @Post(':id/reset-password')
  @ApiOperation({
    summary: 'Admin password reset: set a temp password (returned once) or email a reset link.',
  })
  resetPassword(@Param('id') id: string, @Body() dto: ResetPasswordAdminDto) {
    return this.users.adminResetPassword(id, dto.mode);
  }

  @Post(':id/roles')
  @ApiOperation({ summary: "Replace a user's role assignments." })
  assignRoles(@Param('id') id: string, @Body() dto: AssignRolesDto) {
    return this.users.assignRoles(id, dto);
  }
}
