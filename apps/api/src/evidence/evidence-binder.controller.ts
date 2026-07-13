import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@policymanager/shared';
import type { AuthUser } from '@policymanager/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { ReqContext, type RequestContext } from '../audit/request-context';
import { EvidenceBinderDto } from './dto/evidence-binder.dto';
import { EvidenceBinderService } from './evidence-binder.service';

@ApiTags('evidence-binder')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.EVIDENCE_EXPORT)
@Controller('documents/:id/evidence-binders')
export class EvidenceBinderController {
  constructor(private readonly evidence: EvidenceBinderService) {}

  @Get()
  @ApiOperation({ summary: 'Recent evidence binder export history for a document.' })
  history(@Param('id') documentId: string, @CurrentUser() user: AuthUser) {
    return this.evidence.history(documentId, user);
  }

  @Post('export')
  @ApiProduces('application/zip', 'application/pdf')
  @ApiOperation({ summary: 'Export a compliance evidence binder as ZIP or combined PDF.' })
  export(
    @Param('id') documentId: string,
    @Body() dto: EvidenceBinderDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.evidence.export(documentId, dto, user, ctx);
  }
}
