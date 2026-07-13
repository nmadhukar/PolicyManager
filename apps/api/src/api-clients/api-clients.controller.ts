import { Body, Controller, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, type AuthUser } from '@policymanager/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { ReqContext, type RequestContext } from '../audit/request-context';
import { ApiClientsService } from './api-clients.service';
import { CreateApiClientDto } from './dto/create-api-client.dto';
import { UpdateApiClientDto } from './dto/update-api-client.dto';

/**
 * INTERNAL management of public API clients (Phase 7, PM-0701). Every route is
 * gated by `api.manage` (Admin) via JwtAuthGuard + PermissionsGuard — this is the
 * JWT-guarded side, entirely separate from the ApiKey-guarded `/api/v1` surface.
 * Secrets are shown exactly once (create/rotate) and only their Argon2 hash is
 * stored; list responses never include the hash (AGENTS.md §8).
 */
@ApiTags('api-clients')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.API_MANAGE)
@Controller('api-clients')
export class ApiClientsController {
  constructor(private readonly clients: ApiClientsService) {}

  @Get()
  @ApiOperation({ summary: 'List API clients (never the secret).' })
  list() {
    return this.clients.list();
  }

  @Post()
  @ApiOperation({ summary: 'Create an API client; returns the secret ONCE.' })
  create(
    @Body() dto: CreateApiClientDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.clients.create(dto, user, ctx);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a client’s scopes, category allow-list, or enabled flag.' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateApiClientDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.clients.update(id, dto, user, ctx);
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @ApiOperation({ summary: 'Revoke a client (disables it; all future calls 401).' })
  revoke(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.clients.revoke(id, user, ctx);
  }

  @Post(':id/rotate-secret')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rotate the secret in place; returns the new secret ONCE.' })
  rotate(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.clients.rotateSecret(id, user, ctx);
  }
}
