import { Global, Module } from '@nestjs/common';
import { S3Service } from './s3.service';

/**
 * Global storage module so any feature can inject the shared, env-driven
 * S3Service without re-wiring configuration.
 */
@Global()
@Module({
  providers: [S3Service],
  exports: [S3Service],
})
export class StorageModule {}
