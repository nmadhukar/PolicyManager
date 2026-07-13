import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { DocumentsService } from './documents.service';
import { OnlyOfficeService, type OnlyOfficeCallbackBody } from './onlyoffice.service';

/**
 * OnlyOffice server-to-server routes. These are deliberately NOT behind the JWT
 * guards on {@link DocumentsController}: the Docs server (a container) calls them
 * directly and cannot present a user JWT. They are instead authenticated by
 * short-lived, purpose-scoped signed tokens (and, for the callback, the Docs
 * server's own JWT signature). Excluded from Swagger — internal contract only.
 *
 * Networking: the Docs server reaches these via `ONLYOFFICE_API_INTERNAL_URL`
 * (host.docker.internal on Docker Desktop), not localhost — see OnlyOfficeService.
 */
@ApiExcludeController()
@Controller('documents')
export class DocumentsEditorController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly onlyOffice: OnlyOfficeService,
  ) {}

  /**
   * Streams a version's SOURCE bytes to the Docs server for editing. Authorized
   * by a scoped `content` token bound to this exact document+version. Served
   * inline; the bucket stays private (bytes never leave except via this scoped,
   * signed route or a presigned URL).
   */
  @Get(':id/versions/:versionId/content')
  async content(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Query('token') token: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const payload = this.onlyOffice.verifyScopedToken(token ?? '', 'content', id, versionId);
    const { buffer, mimeType, fileName } = await this.documents.getVersionSource(
      id,
      versionId,
      payload.userId,
    );
    res.set({
      'Content-Type': mimeType,
      'Content-Disposition': `inline; filename="${fileName.replace(/["\r\n]/g, '')}"`,
    });
    return new StreamableFile(buffer);
  }

  /**
   * Receives the OnlyOffice save callback. Doubly authenticated: the scoped
   * `callback` token in the URL (which also carries the edited versionId + editor
   * user), AND the Docs server's JWT signature over the body. On a save status
   * (2/6) a NEW immutable version is created; other statuses just ack. Always
   * returns `{ error: 0 }` so the Docs server marks the save handled.
   */
  @Post(':id/editor-callback')
  @HttpCode(200)
  async editorCallback(
    @Param('id') id: string,
    @Query('token') token: string,
    @Body() body: OnlyOfficeCallbackBody,
    @Headers('authorization') authHeader?: string,
  ): Promise<{ error: number }> {
    const { versionId, userId } = this.onlyOffice.verifyCallbackToken(token ?? '', id);
    const authenticated = this.onlyOffice.verifyCallbackBody(body, authHeader);
    return this.documents.applyEditorCallback(id, versionId, authenticated, userId);
  }
}
