import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@policymanager/shared';
import type { AuthUser } from '@policymanager/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { ReqContext, type RequestContext } from '../audit/request-context';
import { AcknowledgmentService } from './acknowledgment.service';
import { AttestationService } from './attestation.service';
import { CoverPageService } from './cover-page.service';
import { DocumentApprovalService } from './document-approval.service';
import { ApproveDocumentDto } from './dto/approve-document.dto';
import { DistributeAcknowledgmentDto } from './dto/distribute-acknowledgment.dto';

/**
 * Document sign-off surface (PM-0602..PM-0608): approval, the approval-chain read,
 * cover-page + cover-prepended export, and acknowledgment distribution/status.
 *
 * Authorization (server-side, AGENTS.md §8):
 *  - approve → `document.approve` (+ per-document access in the service),
 *  - attestations / cover-page / export → `document.read` (+ access in the service),
 *  - distribute + status → `review.manage`.
 *
 * There is deliberately NO update/delete route for attestations — sign-offs are
 * immutable evidence.
 */
@ApiTags('sign-off')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('documents')
export class DocumentSignoffController {
  constructor(
    private readonly approval: DocumentApprovalService,
    private readonly attestation: AttestationService,
    private readonly coverPage: CoverPageService,
    private readonly acknowledgment: AcknowledgmentService,
  ) {}

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.DOCUMENT_APPROVE)
  @ApiOperation({
    summary: 'Approve (or publish) a document — records an immutable approved sign-off.',
  })
  approve(
    @Param('id') id: string,
    @Body() dto: ApproveDocumentDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.approval.approve(id, dto, user, ctx);
  }

  @Get(':id/attestations')
  @RequirePermission(PERMISSIONS.DOCUMENT_READ)
  @ApiOperation({ summary: 'The document approval chain (reviewed/approved sign-offs, newest first).' })
  attestations(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    // SH1: enforce per-document VIEW access (confidential ACL), not just document.read.
    return this.attestation.listApprovalChainForDocument(id, user, ctx);
  }

  @Get(':id/cover-page')
  @RequirePermission(PERMISSIONS.DOCUMENT_READ)
  @ApiProduces('application/pdf')
  @ApiOperation({ summary: 'Generate the compliance cover-page PDF from live metadata.' })
  async coverPagePdf(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ): Promise<StreamableFile> {
    const { buffer, fileName } = await this.coverPage.generateCoverPage(id, user, ctx);
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `inline; filename="${fileName}"`,
    });
  }

  @Get(':id/export')
  @RequirePermission(PERMISSIONS.DOCUMENT_READ)
  @ApiProduces('application/pdf')
  @ApiOperation({ summary: 'Export the cover page prepended to the current version PDF (merged).' })
  async exportPdf(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ): Promise<StreamableFile> {
    const { buffer, fileName } = await this.coverPage.exportWithCoverPage(id, user, ctx);
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="${fileName}"`,
    });
  }

  @Post(':id/acknowledgments')
  @RequirePermission(PERMISSIONS.REVIEW_MANAGE)
  @ApiOperation({ summary: 'Distribute the current version to users/roles for acknowledgment.' })
  distribute(
    @Param('id') id: string,
    @Body() dto: DistributeAcknowledgmentDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.acknowledgment.distribute(id, dto, user, ctx);
  }

  @Get(':id/acknowledgments')
  @RequirePermission(PERMISSIONS.REVIEW_MANAGE)
  @ApiOperation({ summary: 'Per-assignee acknowledgment status + completion % for the document.' })
  acknowledgmentStatus(@Param('id') id: string) {
    return this.acknowledgment.statusForDocument(id);
  }
}
