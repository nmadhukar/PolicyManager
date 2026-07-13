import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { ExtractionStatus, AuthUser } from '@policymanager/shared';
import { AUDIT_ACTIONS } from '@policymanager/shared';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../storage/s3.service';
import { AuditService } from '../audit/audit.service';
import type { RequestContext } from '../audit/request-context';
import { TextExtractionService } from './text-extraction.service';

export interface ExtractionBatchResult {
  queued?: number;
  processed: number;
  done: number;
  skipped: number;
  failed: number;
}

const POLL_INTERVAL_MS = 30_000;
const DEFAULT_BATCH_LIMIT = 10;
const MANUAL_BATCH_LIMIT = 25;
const MAX_ERROR_CHARS = 4000;

/**
 * Async text/OCR extraction worker.
 *
 * Uploads never wait on OCR or parsers. A version starts as `pending`, then this
 * worker downloads the private source object server-side, extracts text, and
 * updates only searchable metadata. Source bytes and prior versions stay
 * immutable.
 */
@Injectable()
export class DocumentExtractionService {
  private readonly logger = new Logger(DocumentExtractionService.name);
  private polling = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
    private readonly textExtraction: TextExtractionService,
    private readonly audit: AuditService,
  ) {}

  @Interval(POLL_INTERVAL_MS)
  async pollPending(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.processPending(DEFAULT_BATCH_LIMIT);
    } catch (err) {
      this.logger.warn(`Extraction poll failed: ${(err as Error).message}`);
    } finally {
      this.polling = false;
    }
  }

  startVersion(versionId: string): void {
    void this.processVersion(versionId).catch((err) =>
      this.logger.warn(`Extraction failed for version ${versionId}: ${(err as Error).message}`),
    );
  }

  async reindexAll(user: AuthUser, ctx: RequestContext = {}): Promise<ExtractionBatchResult> {
    const queued = await this.prisma.documentVersion.updateMany({
      where: { document: { deletedAt: null } },
      data: { extractionStatus: 'pending', extractionError: null, ocrApplied: false },
    });
    await this.audit.record({
      action: AUDIT_ACTIONS.EXTRACTION_REINDEXED,
      actorUserId: user.id,
      targetType: 'version',
      ...ctx,
      metadata: { queued: queued.count },
    });
    const batch = await this.processPending(MANUAL_BATCH_LIMIT);
    return { queued: queued.count, ...batch };
  }

  async processPending(limit = DEFAULT_BATCH_LIMIT): Promise<ExtractionBatchResult> {
    const rows = await this.prisma.documentVersion.findMany({
      where: { extractionStatus: 'pending', document: { deletedAt: null } },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    const result: ExtractionBatchResult = { processed: 0, done: 0, skipped: 0, failed: 0 };
    for (const row of rows) {
      const status = await this.processVersion(row.id);
      if (!status) continue;
      result.processed += 1;
      if (status === 'done') result.done += 1;
      if (status === 'skipped') result.skipped += 1;
      if (status === 'failed') result.failed += 1;
    }
    return result;
  }

  async processVersion(versionId: string): Promise<ExtractionStatus | null> {
    const claimed = await this.prisma.documentVersion.updateMany({
      where: { id: versionId, extractionStatus: 'pending' },
      data: { extractionStatus: 'processing', extractionError: null },
    });
    if (claimed.count === 0) return null;

    const version = await this.prisma.documentVersion.findUnique({
      where: { id: versionId },
      select: {
        id: true,
        documentId: true,
        s3Key: true,
        fileName: true,
        mimeType: true,
      },
    });
    if (!version) return null;

    try {
      const buffer = await this.s3.getObjectBuffer(version.s3Key);
      const extracted = await this.textExtraction.extractWithStatus(
        buffer,
        version.mimeType,
        version.fileName,
      );
      await this.prisma.documentVersion.update({
        where: { id: version.id },
        data: {
          extractedText: extracted.text.length > 0 ? extracted.text : null,
          hasExtractedText: extracted.text.length > 0,
          extractionStatus: extracted.status,
          extractionError: extracted.error ? extracted.error.slice(0, MAX_ERROR_CHARS) : null,
          ocrApplied: extracted.ocrApplied,
        },
      });
      await this.recordProcessed(version.documentId, version.id, extracted.status, extracted.ocrApplied);
      return extracted.status;
    } catch (err) {
      const message = (err as Error).message;
      await this.prisma.documentVersion.update({
        where: { id: version.id },
        data: {
          extractedText: null,
          hasExtractedText: false,
          extractionStatus: 'failed',
          extractionError: message.slice(0, MAX_ERROR_CHARS),
          ocrApplied: false,
        },
      });
      await this.recordProcessed(version.documentId, version.id, 'failed', false, message);
      return 'failed';
    }
  }

  private async recordProcessed(
    documentId: string,
    versionId: string,
    status: ExtractionStatus,
    ocrApplied: boolean,
    error?: string,
  ): Promise<void> {
    await this.audit.record({
      action: AUDIT_ACTIONS.EXTRACTION_PROCESSED,
      documentId,
      versionId,
      targetType: 'version',
      source: 'system',
      metadata: { status, ocrApplied, error: error ? error.slice(0, MAX_ERROR_CHARS) : undefined },
    });
  }
}
