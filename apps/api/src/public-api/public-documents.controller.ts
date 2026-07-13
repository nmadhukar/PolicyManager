import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiKeyGuard } from '../api-clients/api-key.guard';
import { CurrentApiClient } from '../api-clients/current-api-client.decorator';
import { RequireScope } from '../api-clients/require-scope.decorator';
import type { AuthenticatedApiClient } from '../api-clients/api-client.types';
import { ReqContext, type RequestContext } from '../audit/request-context';
import { PublicListQueryDto } from './dto/public-list-query.dto';
import { PublicSearchQueryDto } from './dto/public-search-query.dto';
import { PublicDocumentsService } from './public-documents.service';

/**
 * Public read-only API v1 for EMR/AI integration (Phase 7). Authenticated by
 * {@link ApiKeyGuard} (NOT the JWT guard) and scoped per-route by `@RequireScope`.
 * This surface is STRICTLY read-only — there are no POST/PATCH/DELETE handlers.
 * Every handler audits with `source=api` inside the service (AGENTS.md §8).
 *
 * The `api` global prefix + this `v1` controller path yield `/api/v1/...`.
 */
@ApiTags('public-api-v1')
@ApiSecurity('api-key')
@UseGuards(ApiKeyGuard)
@Controller('v1')
export class PublicDocumentsController {
  constructor(private readonly documents: PublicDocumentsService) {}

  @Get('documents')
  @RequireScope('documents:read')
  @ApiOperation({ summary: 'List published, non-confidential documents (paginated, filterable).' })
  list(
    @Query() query: PublicListQueryDto,
    @CurrentApiClient() client: AuthenticatedApiClient,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.documents.list(client, query, ctx);
  }

  @Get('search')
  @RequireScope('documents:read')
  @ApiOperation({ summary: 'Keyword search over title + extracted text (semantic-ready contract).' })
  search(
    @Query() query: PublicSearchQueryDto,
    @CurrentApiClient() client: AuthenticatedApiClient,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.documents.search(client, query.q, query.page, query.pageSize, ctx);
  }

  @Get('documents/:id')
  @RequireScope('documents:read')
  @ApiOperation({ summary: 'Get one published, non-confidential document.' })
  get(
    @Param('id') id: string,
    @CurrentApiClient() client: AuthenticatedApiClient,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.documents.get(client, id, ctx);
  }

  @Get('documents/:id/content')
  @RequireScope('content:read')
  @ApiOperation({ summary: 'Get the extracted text of the current version (scope content:read).' })
  content(
    @Param('id') id: string,
    @CurrentApiClient() client: AuthenticatedApiClient,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.documents.getContent(client, id, ctx);
  }

  @Get('documents/:id/download')
  @RequireScope('download')
  @ApiOperation({ summary: 'Get a short-lived presigned download URL (scope download).' })
  download(
    @Param('id') id: string,
    @CurrentApiClient() client: AuthenticatedApiClient,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.documents.getDownload(client, id, ctx);
  }

  @Get('documents/:id/versions')
  @RequireScope('documents:read')
  @ApiOperation({ summary: 'List the version history (metadata only) of a document.' })
  versions(
    @Param('id') id: string,
    @CurrentApiClient() client: AuthenticatedApiClient,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.documents.getVersions(client, id, ctx);
  }
}
