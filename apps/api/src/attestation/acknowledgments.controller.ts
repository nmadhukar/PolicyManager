import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '@policymanager/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { ReqContext, type RequestContext } from '../audit/request-context';
import { AcknowledgmentService } from './acknowledgment.service';
import { AcknowledgeDto } from './dto/acknowledge.dto';

/**
 * Staff-facing acknowledgment surface (PM-0607). Both routes are authenticated
 * only (any signed-in user may be an assignee); the SERVICE enforces ownership —
 * a user may only see and act on their OWN assignments (AGENTS.md §8).
 */
@ApiTags('acknowledgments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('acknowledgments')
export class AcknowledgmentsController {
  constructor(private readonly acknowledgment: AcknowledgmentService) {}

  @Get()
  @ApiOperation({ summary: 'List my acknowledgment assignments (pending/overdue first, then completed).' })
  mine(@CurrentUser() user: AuthUser) {
    return this.acknowledgment.listMine(user);
  }

  @Post(':id/acknowledge')
  @HttpCode(200)
  @ApiOperation({ summary: 'Acknowledge (read & understand) an assignment — records an immutable sign-off.' })
  acknowledge(
    @Param('id') id: string,
    @Body() dto: AcknowledgeDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.acknowledgment.acknowledge(id, dto, user, ctx);
  }
}
