import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@policymanager/shared';
import type { AuthUser } from '@policymanager/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { ReqContext, type RequestContext } from '../audit/request-context';
import { AssignReviewerDto } from './dto/assign-reviewer.dto';
import { ReviewService } from './review.service';

/**
 * Per-document reviewer assignment (PM-0501). Every route requires `review.manage`
 * (guard) — enforced server-side. Mutations write a `review.assigned` audit event.
 */
@ApiTags('reviewers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.REVIEW_MANAGE)
@Controller('documents/:id/reviewers')
export class ReviewersController {
  constructor(private readonly review: ReviewService) {}

  @Get()
  @ApiOperation({ summary: 'List a document\'s assigned reviewers.' })
  list(@Param('id') id: string) {
    return this.review.listReviewers(id);
  }

  @Post()
  @ApiOperation({ summary: 'Assign a user as a reviewer for the document (idempotent).' })
  assign(
    @Param('id') id: string,
    @Body() dto: AssignReviewerDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.review.assignReviewer(id, dto.reviewerId, user, ctx);
  }

  @Delete(':userId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a reviewer assignment from the document.' })
  async unassign(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ): Promise<void> {
    await this.review.unassignReviewer(id, userId, user, ctx);
  }
}
