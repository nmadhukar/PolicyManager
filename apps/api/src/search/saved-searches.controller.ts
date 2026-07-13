import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '@policymanager/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { ReqContext, type RequestContext } from '../audit/request-context';
import { UpsertSavedSearchDto } from './dto/upsert-saved-search.dto';
import { SavedSearchesService } from './saved-searches.service';

@ApiTags('saved-searches')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('saved-searches')
export class SavedSearchesController {
  constructor(private readonly savedSearches: SavedSearchesService) {}

  @Get()
  @ApiOperation({ summary: 'List saved searches visible to the current user.' })
  list(@CurrentUser() user: AuthUser) {
    return this.savedSearches.list(user);
  }

  @Post()
  @ApiOperation({ summary: 'Create a saved document-library search.' })
  create(
    @Body() dto: UpsertSavedSearchDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.savedSearches.create(dto, user, ctx);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a saved search.' })
  update(
    @Param('id') id: string,
    @Body() dto: UpsertSavedSearchDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.savedSearches.update(id, dto, user, ctx);
  }

  @Post(':id/run')
  @ApiOperation({ summary: 'Record that a saved search was used.' })
  run(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.savedSearches.markRun(id, user);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a saved search.' })
  remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.savedSearches.remove(id, user, ctx);
  }
}
