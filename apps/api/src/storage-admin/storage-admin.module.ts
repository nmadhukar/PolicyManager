import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StorageAdminController } from './storage-admin.controller';
import { StorageAdminService } from './storage-admin.service';

/**
 * Storage Admin (PM-0313). Uses the global StorageModule's S3Service and the
 * AuthModule guards. All routes are gated by `storage.manage`.
 */
@Module({
  imports: [AuthModule],
  controllers: [StorageAdminController],
  providers: [StorageAdminService],
})
export class StorageAdminModule {}
