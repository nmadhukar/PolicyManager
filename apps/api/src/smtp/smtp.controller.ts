import { Body, Controller, Get, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@policymanager/shared';
import type { AuthUser } from '@policymanager/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { ReqContext, type RequestContext } from '../audit/request-context';
import { ListNotificationsQueryDto } from './dto/list-notifications-query.dto';
import { TestEmailDto } from './dto/test-email.dto';
import { UpdateSmtpConfigDto } from './dto/update-smtp-config.dto';
import { SmtpService } from './smtp.service';

/**
 * SMTP admin API (PM-0507). Every route requires `smtp.manage` (Admin) — enforced
 * server-side by JwtAuthGuard + PermissionsGuard. The stored password is never
 * returned (GET exposes only `hasPassword`) and is AES-encrypted at rest.
 */
@ApiTags('smtp')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.SMTP_MANAGE)
@Controller('smtp')
export class SmtpController {
  constructor(private readonly smtp: SmtpService) {}

  @Get('config')
  @ApiOperation({ summary: 'Get the effective SMTP configuration (never the password).' })
  getConfig() {
    return this.smtp.getConfig();
  }

  @Put('config')
  @ApiOperation({
    summary:
      'Upsert the SMTP configuration. Password is write-only + encrypted at rest; ' +
      'omit to keep it, empty string clears it.',
  })
  updateConfig(
    @Body() dto: UpdateSmtpConfigDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.smtp.updateConfig(dto, user, ctx);
  }

  @Post('test')
  @ApiOperation({ summary: 'Send a test email via the effective config (logged + audited).' })
  test(
    @Body() dto: TestEmailDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.smtp.sendTest(dto.to, user, ctx);
  }

  @Get('notifications')
  @ApiOperation({ summary: 'Paginated notification delivery log (newest first).' })
  notifications(@Query() query: ListNotificationsQueryDto) {
    return this.smtp.listNotifications(query);
  }
}
