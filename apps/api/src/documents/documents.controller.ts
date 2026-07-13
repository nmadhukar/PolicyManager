import {
  BadRequestException,
  Body,
  Controller,
  Get,
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
  @ApiOperation({ summary: 'List documents (paginated, filterable, sortable).' })
  list(@Query() query: ListDocumentsQueryDto) {
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
}
