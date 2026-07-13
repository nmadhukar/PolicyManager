import {
  CopyObjectCommand,
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
  type ServerSideEncryption,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { buildDocumentObjectKey } from './s3-key.util';

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
  private readonly sse?: string;
  private readonly kmsKeyId?: string;
  private readonly autoCreate: boolean;

  constructor(private readonly config: ConfigService) {
    const endpoint = config.get<string>('S3_ENDPOINT') || undefined;
    const region = config.get<string>('S3_REGION') || 'us-east-2';
    this.bucket = config.get<string>('S3_BUCKET') || 'policymanager-docs';
    this.documentsPrefix = config.get<string>('S3_PREFIX_DOCUMENTS') || 'documents/';
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
}

/** Strips characters that could break the Content-Disposition header. */
function sanitizeHeader(value: string): string {
  return value.replace(/["\r\n]/g, '');
}
