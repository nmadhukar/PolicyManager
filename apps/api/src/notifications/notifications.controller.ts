import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@policymanager/shared';
import type { AuthUser } from '@policymanager/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { ReqContext, type RequestContext } from '../audit/request-context';
import { ListNotificationsQueryDto } from './dto/list-notifications-query.dto';
import { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';
import { NotificationsService } from './notifications.service';

@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'List my in-app notifications.' })
  list(@Query() query: ListNotificationsQueryDto, @CurrentUser() user: AuthUser) {
    return this.notifications.list(user, query);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'My unread notification count.' })
  unreadCount(@CurrentUser() user: AuthUser) {
    return this.notifications.unreadCount(user);
  }

  @Get('preferences')
  @ApiOperation({ summary: 'My notification preferences.' })
  preferences(@CurrentUser() user: AuthUser) {
    return this.notifications.getPreferences(user);
  }

  @Patch('preferences')
  @ApiOperation({ summary: 'Update my notification preferences.' })
  updatePreferences(
    @Body() dto: UpdateNotificationPreferencesDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.notifications.updatePreferences(dto, user, ctx);
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark one notification read.' })
  markRead(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.notifications.markRead(id, user);
  }

  @Patch('read-all')
  @ApiOperation({ summary: 'Mark all my notifications read.' })
  readAll(@CurrentUser() user: AuthUser) {
    return this.notifications.readAll(user);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Dismiss one notification.' })
  dismiss(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.notifications.dismiss(id, user);
  }

  @Post('digest/run')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.SMTP_MANAGE)
  @ApiOperation({ summary: 'Run digest generation now.' })
  runDigest() {
    return this.notifications.runDigest(new Date(), true);
  }
}
