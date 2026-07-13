import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@policymanager/shared';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { AuditService } from './audit.service';
import { ListAuditQueryDto } from './dto/list-audit-query.dto';

/**
 * Read-only audit trail API. Gated by the new `audit.read` permission (Admin,
 * Compliance Officer, Auditor). There is intentionally NO write/update/delete
 * surface: audit rows are immutable through app paths (AGENTS.md §8).
 */
@ApiTags('audit')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.AUDIT_READ)
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @ApiOperation({
    summary: 'Query the audit trail (paginated; filter by actor, document, action, source, date).',
  })
  list(@Query() query: ListAuditQueryDto) {
    return this.audit.query(query);
  }
}
