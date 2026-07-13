import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, type AuthUser } from '@policymanager/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { ReqContext, type RequestContext } from '../audit/request-context';
import type { UploadedFile } from '../documents/documents.service';
import { ImportListQueryDto } from './dto/import-list-query.dto';
import { ImportsService } from './imports.service';

/** Per-file size guardrail (mirrors the documents upload cap). */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
/** Upper bound on files accepted in one import request. */
const MAX_FILES = 200;

/** Uploaded-files shape from FileFieldsInterceptor for the manifest route. */
interface ManifestUpload {
  manifest?: UploadedFile[];
  files?: UploadedFile[];
}

/**
 * Bulk import & consolidation (Phase 8, PM-0801..PM-0806). Every route requires
 * `document.write` (JwtAuthGuard + PermissionsGuard) — importing creates documents,
 * so it is a write surface. Duplicate detection, per-row error isolation, and the
 * import report all live in {@link ImportsService}; storage/versioning is reused
 * from DocumentsService (never duplicated).
 */
@ApiTags('imports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.DOCUMENT_WRITE)
@Controller('imports')
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @Post()
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'manifest', maxCount: 1 },
        { name: 'files', maxCount: MAX_FILES },
      ],
      { limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_FILES + 1 } },
    ),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['manifest'],
      properties: {
        manifest: { type: 'string', format: 'binary', description: 'CSV manifest file' },
        files: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
          description: 'Documents referenced by the manifest (matched by file name)',
        },
      },
    },
  })
  @ApiOperation({
    summary: 'Import documents from a CSV manifest + referenced files (returns the report).',
  })
  importManifest(
    @UploadedFiles() uploaded: ManifestUpload | undefined,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.imports.runManifestImport(
      uploaded?.manifest?.[0],
      uploaded?.files ?? [],
      user,
      ctx,
    );
  }

  @Post('bulk')
  @UseInterceptors(
    FilesInterceptor('files', MAX_FILES, { limits: { fileSize: MAX_UPLOAD_BYTES } }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['files'],
      properties: {
        files: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
          description: 'Files to import; each becomes a document titled from its name',
        },
      },
    },
  })
  @ApiOperation({
    summary: 'Bulk-upload files with no manifest (each file becomes a document; dedupe by checksum).',
  })
  importBulk(
    @UploadedFiles() files: UploadedFile[] | undefined,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.imports.runBulkImport(files ?? [], user, ctx);
  }

  @Get()
  @ApiOperation({ summary: 'List import batches (paginated, newest first).' })
  list(@Query() query: ImportListQueryDto) {
    return this.imports.listBatches(query.page ?? 1, query.pageSize ?? 20);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an import batch with its full per-row report.' })
  get(@Param('id') id: string) {
    return this.imports.getBatch(id);
  }
}
