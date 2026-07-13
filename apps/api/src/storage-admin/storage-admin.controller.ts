import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@policymanager/shared';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CreateBucketDto } from './dto/create-bucket.dto';
import { CreatePrefixDto } from './dto/create-prefix.dto';
import { StorageAdminService } from './storage-admin.service';

/**
 * Storage Admin (PM-0313). Every route requires `storage.manage`, enforced
 * server-side (JwtAuthGuard -> PermissionsGuard). NON-destructive by design:
 * create + list only, no delete surface (AGENTS.md §9).
 */
@ApiTags('storage')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.STORAGE_MANAGE)
@Controller('storage')
export class StorageAdminController {
  constructor(private readonly storage: StorageAdminService) {}

  @Get('config')
  @ApiOperation({ summary: 'Get the effective storage configuration (default bucket + prefixes).' })
  config() {
    return this.storage.getConfig();
  }

  @Get('buckets')
  @ApiOperation({ summary: 'List all buckets.' })
  listBuckets() {
    return this.storage.listBuckets();
  }

  @Post('buckets')
  @ApiOperation({ summary: 'Create a private, versioned bucket.' })
  createBucket(@Body() dto: CreateBucketDto) {
    return this.storage.createBucket(dto.name);
  }

  @Get('prefixes')
  @ApiOperation({ summary: 'List the immediate folders (prefixes) in a bucket.' })
  listPrefixes(@Query('bucket') bucket: string, @Query('prefix') prefix?: string) {
    return this.storage.listPrefixes(bucket, prefix);
  }

  @Post('prefixes')
  @ApiOperation({ summary: 'Create a folder (prefix) marker in a bucket.' })
  createPrefix(@Body() dto: CreatePrefixDto) {
    return this.storage.createFolder(dto.bucket, dto.prefix);
  }
}
