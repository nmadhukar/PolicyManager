import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile as UploadedFileDecorator,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { PERMISSIONS } from '@policymanager/shared';
import type { AuthUser } from '@policymanager/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { DocumentsService, type UploadedFile } from './documents.service';
import { CreateDocumentDto } from './dto/create-document.dto';
import { CreateVersionDto } from './dto/create-version.dto';
import { ListDocumentsQueryDto } from './dto/list-documents-query.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';

/** Upload guardrail: reject files above this size before buffering to S3. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

/**
 * Document CRUD + immutable versioning. Read routes require `document.read`;
 * create/update/upload require `document.write`. Authorization is enforced
 * server-side by JwtAuthGuard + PermissionsGuard (AGENTS.md §8).
 */
@ApiTags('documents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  @RequirePermission(PERMISSIONS.DOCUMENT_READ)
  @ApiOperation({
    summary: 'List documents (paginated, filterable, sortable).',
    description:
      'Excludes soft-deleted and archived documents by default. `includeArchived=true` ' +
      'surfaces archived; `deleted=true` is the trash view (only soft-deleted) and ' +
      'additionally requires document.write.',
  })
  list(@Query() query: ListDocumentsQueryDto, @CurrentUser() user: AuthUser) {
    // The trash view exposes deleted records, so it is gated to write-capable
    // users even though the base route only needs document.read (AGENTS.md §8).
    if (query.deleted && !user.permissions.includes(PERMISSIONS.DOCUMENT_WRITE)) {
      throw new ForbiddenException('Viewing deleted documents requires document.write');
    }
    return this.documents.list(query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.DOCUMENT_READ)
  @ApiOperation({ summary: 'Get a document with its full version history.' })
  get(@Param('id') id: string) {
    return this.documents.get(id);
  }

  @Post()
  @RequirePermission(PERMISSIONS.DOCUMENT_WRITE)
  @ApiOperation({ summary: 'Create a document (title required; owner = caller).' })
  create(@Body() dto: CreateDocumentDto, @CurrentUser() user: AuthUser) {
    return this.documents.create(dto, user.id);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.DOCUMENT_WRITE)
  @ApiOperation({ summary: 'Update document metadata (tags, category, status, cadence…).' })
  update(@Param('id') id: string, @Body() dto: UpdateDocumentDto) {
    return this.documents.update(id, dto);
  }

  @Post(':id/versions')
  @RequirePermission(PERMISSIONS.DOCUMENT_WRITE)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
        changeSummary: { type: 'string' },
      },
    },
  })
  @ApiOperation({ summary: 'Upload a new immutable version (multipart file).' })
  addVersion(
    @Param('id') id: string,
    @UploadedFileDecorator() file: UploadedFile | undefined,
    @Body() dto: CreateVersionDto,
    @CurrentUser() user: AuthUser,
  ) {
    if (!file) throw new BadRequestException('A file is required');
    return this.documents.addVersion(id, file, dto, user.id);
  }

  @Get(':id/versions/:versionId/download')
  @RequirePermission(PERMISSIONS.DOCUMENT_READ)
  @ApiOperation({ summary: 'Get a short-lived presigned download URL for a version.' })
  download(@Param('id') id: string, @Param('versionId') versionId: string) {
    return this.documents.getVersionDownloadTicket(id, versionId);
  }

  @Post(':id/versions/:versionId/restore')
  @RequirePermission(PERMISSIONS.DOCUMENT_WRITE)
  @ApiOperation({
    summary: 'Restore an older version as a new current version (history preserved).',
  })
  restoreVersion(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.documents.restoreVersion(id, versionId, user.id);
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.DOCUMENT_WRITE)
  @ApiOperation({
    summary: 'Soft-delete a document (moves it to the trash; never destroys bytes).',
  })
  softDelete(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.documents.softDelete(id, user.id);
  }

  @Post(':id/restore')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.DOCUMENT_WRITE)
  @ApiOperation({ summary: 'Restore a soft-deleted document from the trash.' })
  restore(@Param('id') id: string) {
    return this.documents.restore(id);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.DOCUMENT_WRITE)
  @ApiOperation({ summary: 'Archive a document (keeps it accessible but out of active lists).' })
  archive(@Param('id') id: string) {
    return this.documents.archive(id);
  }

  @Post(':id/unarchive')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.DOCUMENT_WRITE)
  @ApiOperation({ summary: 'Unarchive a document, restoring its prior status.' })
  unarchive(@Param('id') id: string) {
    return this.documents.unarchive(id);
  }
}
