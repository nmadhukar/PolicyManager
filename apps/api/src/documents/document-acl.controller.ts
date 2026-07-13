import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@policymanager/shared';
import type { AuthUser } from '@policymanager/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { ReqContext, type RequestContext } from '../audit/request-context';
import { DocumentAclService } from './document-acl.service';
import { AddAclDto } from './dto/add-acl.dto';

/**
 * Per-document access-control management (PM-0403). Requires `document.write`
 * (guard) PLUS document-level edit access (owner/Admin/grant for confidential),
 * enforced in the service. Every mutation writes an `acl.changed` audit event.
 */
@ApiTags('document-acl')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.DOCUMENT_WRITE)
@Controller('documents/:id/acl')
export class DocumentAclController {
  constructor(private readonly acl: DocumentAclService) {}

  @Get()
  @ApiOperation({ summary: 'List the access-control grants on a document.' })
  list(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.acl.list(id, user);
  }

  @Post()
  @ApiOperation({ summary: 'Grant a role or user a capability on the document.' })
  add(
    @Param('id') id: string,
    @Body() dto: AddAclDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.acl.add(id, dto, user, ctx);
  }

  @Delete(':aclId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove an access-control grant from the document.' })
  async remove(
    @Param('id') id: string,
    @Param('aclId') aclId: string,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ): Promise<void> {
    await this.acl.remove(id, aclId, user, ctx);
  }
}
