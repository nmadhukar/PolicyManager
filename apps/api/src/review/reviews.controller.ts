import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@policymanager/shared';
import type { AuthUser } from '@policymanager/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { ReqContext, type RequestContext } from '../audit/request-context';
import { CompleteReviewDto } from './dto/complete-review.dto';
import { ListReviewsQueryDto } from './dto/list-reviews-query.dto';
import { ReviewService } from './review.service';

/**
 * QC review dashboard + actions (PM-0502..PM-0506).
 *
 * Authorization is mixed and enforced server-side (AGENTS.md §8):
 *  - listing/detail/completion are open to any authenticated user but the SERVICE
 *    scopes non-`review.manage` callers to their OWN tasks (list) / rejects others'
 *    tasks (detail/complete);
 *  - the compliance summary + the manual sweep trigger require `review.manage`.
 *
 * Static routes are declared before the `:taskId` param route so they never get
 * captured as a task id.
 */
@ApiTags('reviews')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('reviews')
export class ReviewsController {
  constructor(private readonly review: ReviewService) {}

  @Get()
  @ApiOperation({
    summary: 'List review tasks (own tasks for non-managers; filterable for managers).',
  })
  list(@Query() query: ListReviewsQueryDto, @CurrentUser() user: AuthUser) {
    return this.review.listTasks(query, user);
  }

  @Get('compliance-summary')
  @RequirePermission(PERMISSIONS.REVIEW_MANAGE)
  @ApiOperation({ summary: 'Clinic-wide review-compliance snapshot (% current, due-soon, overdue).' })
  compliance() {
    return this.review.complianceSummary(new Date());
  }

  @Post('run-sweep')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.REVIEW_MANAGE)
  @ApiOperation({
    summary: 'Run the review sweep now (generate due tasks + mark overdue). Admin/test.',
  })
  runSweep() {
    return this.review.runReviewSweep(new Date());
  }

  @Get('tasks/:taskId')
  @ApiOperation({ summary: 'Get a single review task (own task unless review.manage).' })
  getTask(@Param('taskId') taskId: string, @CurrentUser() user: AuthUser) {
    return this.review.getTask(taskId, user);
  }

  @Post(':taskId/complete')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Complete a review task; advances the document nextReviewDate by cadence.',
  })
  complete(
    @Param('taskId') taskId: string,
    @Body() dto: CompleteReviewDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.review.completeTask(taskId, dto, user, ctx);
  }
}
