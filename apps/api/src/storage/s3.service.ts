import { Readable } from 'stream';
import {
  CopyObjectCommand,
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutBucketVersioningCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
  S3Client,
  type ServerSideEncryption,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  buildDocumentObjectKey,
  buildRenditionObjectKey,
  normalizeFolderPrefix,
  validateBucketName,
} from './s3-key.util';

/** A bucket as surfaced to the Storage Admin UI. */
export interface BucketInfo {
  name: string;
  createdAt: string | null;
  /** True for the app's configured default document bucket. */
  isDefault: boolean;
}

/** A top-level "folder" (common prefix) within a bucket. */
export interface PrefixInfo {
  prefix: string;
}

/** Read-only view of the storage configuration for the Storage Admin UI. */
export interface StorageConfig {
  bucket: string;
  prefixes: {
    documents: string;
    renditions: string;
  };
  endpoint: string | null;
  region: string;
}

/** Parses a string/boolean env flag into a real boolean. */
function envBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return fallback;
}

export interface PutObjectResult {
  /** S3/MinIO version id when bucket versioning is enabled (AGENTS.md §9 backstop). */
  versionId?: string;
}

/**
 * Env-driven S3/MinIO gateway. One image serves local MinIO and production
 * AWS/S3-compatible storage purely from environment configuration.
 *
 * Safety invariants (AGENTS.md §8/§9):
 *  - the bucket is never made public here;
 *  - object keys are deterministic and versioned by document/version;
 *  - downloads are served ONLY via short-lived presigned URLs, and only after
 *    the caller has been authorized in the service layer.
 */
@Injectable()
export class S3Service implements OnModuleInit {
  private readonly logger = new Logger(S3Service.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly documentsPrefix: string;
  private readonly renditionsPrefix: string;
  private readonly endpoint?: string;
  private readonly region: string;
  private readonly sse?: string;
  private readonly kmsKeyId?: string;
  private readonly autoCreate: boolean;

  constructor(private readonly config: ConfigService) {
    const endpoint = config.get<string>('S3_ENDPOINT') || undefined;
    const region = config.get<string>('S3_REGION') || 'us-east-2';
    this.endpoint = endpoint;
    this.region = region;
    this.bucket = config.get<string>('S3_BUCKET') || 'policymanager-docs';
    this.documentsPrefix = config.get<string>('S3_PREFIX_DOCUMENTS') || 'documents/';
    this.renditionsPrefix = config.get<string>('S3_PREFIX_RENDITIONS') || 'renditions/';
    this.sse = config.get<string>('S3_SSE') || undefined;
    this.kmsKeyId = config.get<string>('S3_KMS_KEY_ID') || undefined;
    this.autoCreate = envBool(config.get('S3_AUTO_CREATE'));

    this.client = new S3Client({
      region,
      endpoint,
      forcePathStyle: envBool(config.get('S3_FORCE_PATH_STYLE'), Boolean(endpoint)),
      credentials: {
        accessKeyId: config.get<string>('S3_ACCESS_KEY_ID') || 'minioadmin',
        secretAccessKey: config.get<string>('S3_SECRET_ACCESS_KEY') || 'minioadmin',
      },
    });
  }

  /**
   * Self-provisioning boot step. Only runs when `S3_AUTO_CREATE=true` (safe for
   * local MinIO; production bucket/KMS/public-access changes stay gated behind
   * explicit env flags — AGENTS.md §9). Creates the bucket if absent and enables
   * versioning. Failures are logged, not fatal, so unrelated boot still succeeds.
   */
  async onModuleInit(): Promise<void> {
    if (!this.autoCreate) return;
    try {
      try {
        await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      } catch {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
        this.logger.log(`Created bucket "${this.bucket}"`);
      }
      // Versioning is required so an accidental same-key put keeps prior bytes.
      await this.client.send(
        new PutBucketVersioningCommand({
          Bucket: this.bucket,
          VersioningConfiguration: { Status: 'Enabled' },
        }),
      );
    } catch (err) {
      this.logger.warn(
        `Storage auto-provisioning skipped for "${this.bucket}": ${(err as Error).message}`,
      );
    }
  }

  /** Deterministic key for a document version's source bytes. */
  buildDocumentKey(documentId: string, versionNumber: number, fileName: string): string {
    return buildDocumentObjectKey(this.documentsPrefix, documentId, versionNumber, fileName);
  }

  /** Deterministic key for a version's derived PDF rendition (never the source). */
  buildRenditionKey(documentId: string, versionNumber: number): string {
    return buildRenditionObjectKey(this.renditionsPrefix, documentId, versionNumber);
  }

  /**
   * Downloads an object's full bytes into a Buffer. Used for server-to-server
   * flows (Gotenberg conversion, OnlyOffice content streaming) where bytes must
   * pass through the API rather than a browser-reachable presigned URL. The
   * caller MUST have authorized the request first (AGENTS.md §8).
   */
  async getObjectBuffer(key: string): Promise<Buffer> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const body = result.Body as Readable | undefined;
    if (!body) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer));
    }
    return Buffer.concat(chunks);
  }

  /**
   * Server-side copy of an existing object to a NEW key. Used to restore an older
   * document version: the source (immutable) object is never moved or deleted —
   * its bytes are duplicated to a fresh version-scoped key (AGENTS.md §9).
   *
   * `CopySource` is URL-encoded per segment so path separators survive while any
   * unusual filename characters are escaped. Returns the destination object's S3
   * version id when bucket versioning is enabled.
   */
  async copyObject(
    sourceKey: string,
    destKey: string,
    contentType?: string,
  ): Promise<PutObjectResult> {
    const copySource = `${this.bucket}/${sourceKey}`
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    const result = await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: destKey,
        CopySource: copySource,
        // REPLACE so the new object gets an explicit content-type rather than
        // inheriting stale metadata; omit to fall back to a straight copy.
        ...(contentType ? { ContentType: contentType, MetadataDirective: 'REPLACE' } : {}),
        ...(this.sse ? { ServerSideEncryption: this.sse as ServerSideEncryption } : {}),
        ...(this.sse === 'aws:kms' && this.kmsKeyId ? { SSEKMSKeyId: this.kmsKeyId } : {}),
      }),
    );
    return { versionId: result.VersionId };
  }

  /** Uploads bytes at `key`; returns the S3 version id when available. */
  async putObject(key: string, body: Buffer, contentType: string): Promise<PutObjectResult> {
    const result = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ...(this.sse ? { ServerSideEncryption: this.sse as ServerSideEncryption } : {}),
        ...(this.sse === 'aws:kms' && this.kmsKeyId ? { SSEKMSKeyId: this.kmsKeyId } : {}),
      }),
    );
    return { versionId: result.VersionId };
  }

  /**
   * Issues a short-lived presigned GET URL. The bucket stays private — this is
   * the ONLY way document bytes leave the system, and callers MUST authorize the
   * request before calling this (AGENTS.md §8).
   *
   * @param ttlSeconds URL lifetime; defaults to 300s (5 min).
   */
  async getPresignedDownloadUrl(
    key: string,
    ttlSeconds = 300,
    downloadFileName?: string,
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(downloadFileName
        ? { ResponseContentDisposition: `attachment; filename="${sanitizeHeader(downloadFileName)}"` }
        : {}),
    });
    return getSignedUrl(this.client, command, { expiresIn: ttlSeconds });
  }

  // ---- Storage Admin (AGENTS.md §9; STORAGE_MANAGE-gated in the controller) --
  //
  // v1 is deliberately NON-destructive: create + list only. There is no delete
  // bucket / delete object surface here — that stays out of scope until a
  // separate ticket approves it.

  /** Read-only snapshot of the effective storage configuration. */
  getStorageConfig(): StorageConfig {
    return {
      bucket: this.bucket,
      prefixes: { documents: this.documentsPrefix, renditions: this.renditionsPrefix },
      endpoint: this.endpoint ?? null,
      region: this.region,
    };
  }

  /** Lists all buckets, flagging the app's configured default. */
  async listBuckets(): Promise<BucketInfo[]> {
    const result = await this.client.send(new ListBucketsCommand({}));
    return (result.Buckets ?? []).map((b) => ({
      name: b.Name ?? '',
      createdAt: b.CreationDate ? b.CreationDate.toISOString() : null,
      isDefault: b.Name === this.bucket,
    }));
  }

  /**
   * Creates a bucket, then enables versioning and blocks all public access.
   * Rejects invalid names before any API call. Private-by-default and versioned
   * are hard invariants (AGENTS.md §8/§9) — a created bucket is never public.
   *
   * `PutPublicAccessBlock` is best-effort: MinIO does not implement it, so a
   * failure there is logged and does not fail bucket creation (MinIO buckets are
   * private by default). On real AWS the call succeeds and enforces the block.
   */
  async createBucket(name: string): Promise<BucketInfo> {
    const reason = validateBucketName(name);
    if (reason) throw new Error(reason);

    await this.client.send(new CreateBucketCommand({ Bucket: name }));
    await this.client.send(
      new PutBucketVersioningCommand({
        Bucket: name,
        VersioningConfiguration: { Status: 'Enabled' },
      }),
    );
    try {
      await this.client.send(
        new PutPublicAccessBlockCommand({
          Bucket: name,
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            IgnorePublicAcls: true,
            BlockPublicPolicy: true,
            RestrictPublicBuckets: true,
          },
        }),
      );
    } catch (err) {
      this.logger.warn(
        `Public-access-block not applied to "${name}" (private by default): ${(err as Error).message}`,
      );
    }
    return { name, createdAt: new Date().toISOString(), isDefault: name === this.bucket };
  }

  /**
   * Lists the immediate "folders" (common prefixes) under `parentPrefix` in a
   * bucket, using a `/` delimiter so only one level is returned.
   */
  async listPrefixes(bucket: string, parentPrefix = ''): Promise<PrefixInfo[]> {
    const normalizedParent =
      parentPrefix && !parentPrefix.endsWith('/') ? `${parentPrefix}/` : parentPrefix;
    const result = await this.client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Delimiter: '/',
        Prefix: normalizedParent || undefined,
      }),
    );
    return (result.CommonPrefixes ?? [])
      .map((p) => p.Prefix)
      .filter((p): p is string => !!p)
      .map((prefix) => ({ prefix }));
  }

  /**
   * Creates a zero-byte "folder marker" object at `{prefix}/` so the folder is
   * visible in listings even while empty. Returns the normalized marker key.
   * Rejects unsafe/empty prefixes.
   */
  async createFolder(bucket: string, prefix: string): Promise<PrefixInfo> {
    const marker = normalizeFolderPrefix(prefix);
    if (!marker) throw new Error('A valid folder name is required.');
    await this.client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: marker,
        Body: Buffer.alloc(0),
        ...(this.sse ? { ServerSideEncryption: this.sse as ServerSideEncryption } : {}),
        ...(this.sse === 'aws:kms' && this.kmsKeyId ? { SSEKMSKeyId: this.kmsKeyId } : {}),
      }),
    );
    return { prefix: marker };
  }
}

/** Strips characters that could break the Content-Disposition header. */
function sanitizeHeader(value: string): string {
  return value.replace(/["\r\n]/g, '');
}
