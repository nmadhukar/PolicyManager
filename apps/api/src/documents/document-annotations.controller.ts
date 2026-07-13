import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@policymanager/shared';
import type { AuthUser } from '@policymanager/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { ReqContext, type RequestContext } from '../audit/request-context';
import { DocumentAnnotationsService } from './document-annotations.service';
import { CreateAnnotationDto } from './dto/create-annotation.dto';

@ApiTags('document annotations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('documents/:documentId/versions/:versionId/annotations')
export class DocumentAnnotationsController {
  constructor(private readonly annotations: DocumentAnnotationsService) {}

  @Get()
  @RequirePermission(PERMISSIONS.DOCUMENT_READ)
  @ApiOperation({ summary: 'List internal review annotations for a document version.' })
  list(
    @Param('documentId') documentId: string,
    @Param('versionId') versionId: string,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.annotations.list(documentId, versionId, user, ctx);
  }

  @Post()
  @RequirePermission(PERMISSIONS.DOCUMENT_READ)
  @ApiOperation({
    summary: 'Create an internal review annotation (requires document.comment or reviewer assignment).',
  })
  create(
    @Param('documentId') documentId: string,
    @Param('versionId') versionId: string,
    @Body() dto: CreateAnnotationDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.annotations.create(documentId, versionId, dto, user, ctx);
  }

  @Post(':annotationId/resolve')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.DOCUMENT_READ)
  @ApiOperation({ summary: 'Resolve an annotation.' })
  resolve(
    @Param('documentId') documentId: string,
    @Param('versionId') versionId: string,
    @Param('annotationId') annotationId: string,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.annotations.resolve(documentId, versionId, annotationId, user, ctx);
  }

  @Post(':annotationId/reopen')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.DOCUMENT_READ)
  @ApiOperation({ summary: 'Reopen a resolved annotation.' })
  reopen(
    @Param('documentId') documentId: string,
    @Param('versionId') versionId: string,
    @Param('annotationId') annotationId: string,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.annotations.reopen(documentId, versionId, annotationId, user, ctx);
  }

  @Delete(':annotationId')
  @HttpCode(204)
  @RequirePermission(PERMISSIONS.DOCUMENT_READ)
  @ApiOperation({ summary: 'Soft-delete an annotation (author or compliance staff).' })
  async softDelete(
    @Param('documentId') documentId: string,
    @Param('versionId') versionId: string,
    @Param('annotationId') annotationId: string,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    await this.annotations.softDelete(documentId, versionId, annotationId, user, ctx);
  }
}
