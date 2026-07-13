import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type {
  StorageBucket,
  StorageConfigView,
  StoragePrefix,
} from '@policymanager/shared';
import { S3Service } from '../storage/s3.service';
import { normalizeFolderPrefix, validateBucketName } from '../storage/s3-key.util';

/**
 * Storage administration (AGENTS.md §9; PM-0313). Wraps the S3 gateway with
 * validation + clean HTTP error mapping.
 *
 * Scope is deliberately NON-destructive in v1: create + list of buckets and
 * prefixes only. There is NO delete-bucket / delete-object surface here — that
 * stays out of scope until a separate ticket approves it. Every method is gated
 * by `storage.manage` at the controller.
 */
@Injectable()
export class StorageAdminService {
  constructor(private readonly s3: S3Service) {}

  /** Effective storage configuration (default bucket + prefixes). */
  getConfig(): StorageConfigView {
    return this.s3.getStorageConfig();
  }

  /** Lists all buckets, flagging the app's configured default. */
  listBuckets(): Promise<StorageBucket[]> {
    return this.s3.listBuckets();
  }

  /**
   * Creates a private, versioned bucket. Rejects invalid names with 400 and an
   * already-existing bucket with 409. Private + versioned are hard invariants
   * enforced by the S3 gateway (AGENTS.md §8/§9).
   */
  async createBucket(name: string): Promise<StorageBucket> {
    const reason = validateBucketName(name);
    if (reason) throw new BadRequestException(reason);
    try {
      return await this.s3.createBucket(name);
    } catch (err) {
      const code = (err as { name?: string; Code?: string }).name ?? (err as { Code?: string }).Code;
      if (code === 'BucketAlreadyExists' || code === 'BucketAlreadyOwnedByYou') {
        throw new ConflictException('A bucket with that name already exists.');
      }
      throw err;
    }
  }

  /** Lists the immediate folders (common prefixes) under an optional parent. */
  async listPrefixes(bucket: string, parentPrefix?: string): Promise<StoragePrefix[]> {
    if (!bucket) throw new BadRequestException('A bucket is required.');
    return this.s3.listPrefixes(bucket, parentPrefix ?? '');
  }

  /** Creates a zero-byte folder marker. Rejects unsafe/empty names with 400. */
  async createFolder(bucket: string, prefix: string): Promise<StoragePrefix> {
    if (!bucket) throw new BadRequestException('A bucket is required.');
    if (!normalizeFolderPrefix(prefix)) {
      throw new BadRequestException('A valid folder name is required.');
    }
    return this.s3.createFolder(bucket, prefix);
  }
}
