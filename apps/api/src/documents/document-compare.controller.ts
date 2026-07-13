import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@policymanager/shared';
import type { AuthUser } from '@policymanager/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { ReqContext, type RequestContext } from '../audit/request-context';
import { DocumentCompareService } from './document-compare.service';

@ApiTags('document-compare')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.DOCUMENT_READ)
@Controller('documents/:id/versions/:fromVersionId/compare/:toVersionId')
export class DocumentCompareController {
  constructor(private readonly compareService: DocumentCompareService) {}

  @Get()
  @ApiOperation({ summary: 'Compare two immutable document versions with redline hunks.' })
  compare(
    @Param('id') documentId: string,
    @Param('fromVersionId') fromVersionId: string,
    @Param('toVersionId') toVersionId: string,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.compareService.compare(documentId, fromVersionId, toVersionId, user, ctx);
  }

  @Get('export')
  @ApiProduces('application/pdf')
  @ApiOperation({ summary: 'Export the compare/redline summary as a PDF.' })
  export(
    @Param('id') documentId: string,
    @Param('fromVersionId') fromVersionId: string,
    @Param('toVersionId') toVersionId: string,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.compareService.exportPdf(documentId, fromVersionId, toVersionId, user, ctx);
  }
}
