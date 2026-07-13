import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { Prisma } from '@prisma/client';
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
/** How many times a `failed` version is auto-retried before it stays terminal. */
const MAX_EXTRACTION_ATTEMPTS = 3;
/** A `processing` row older than this is treated as orphaned (worker crashed). */
const STALE_PROCESSING_MS = 10 * 60_000;
/** Cap on concurrent eager (post-upload) extractions so a bulk import can't spawn
 *  hundreds of simultaneous downloads/OCR calls; overflow waits for the poller. */
const MAX_EAGER_CONCURRENCY = 4;

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
  private eagerActive = 0;

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

  /**
   * Eagerly extract a freshly-written version. Bounded by {@link MAX_EAGER_CONCURRENCY}
   * so a bulk import cannot spawn hundreds of concurrent downloads/OCR calls; any
   * overflow simply stays `pending` and is drained by {@link pollPending}.
   */
  startVersion(versionId: string): void {
    if (this.eagerActive >= MAX_EAGER_CONCURRENCY) return;
    this.eagerActive += 1;
    void this.processVersion(versionId)
      .catch((err) =>
        this.logger.warn(`Extraction failed for version ${versionId}: ${(err as Error).message}`),
      )
      .finally(() => {
        this.eagerActive -= 1;
      });
  }

  async reindexAll(user: AuthUser, ctx: RequestContext = {}): Promise<ExtractionBatchResult> {
    // Only re-queue versions that are NOT already `done`: re-extracting a done row
    // would needlessly re-run OCR and (on a transient failure) risk its indexed text.
    // Reset the retry budget so previously-terminal `failed` rows get a fresh chance.
    const queued = await this.prisma.documentVersion.updateMany({
      where: { document: { deletedAt: null }, extractionStatus: { not: 'done' } },
      data: {
        extractionStatus: 'pending',
        extractionError: null,
        ocrApplied: false,
        extractionAttempts: 0,
        extractionStartedAt: null,
      },
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
      where: { document: { deletedAt: null }, OR: this.claimableConditions() },
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

  /**
   * The set of states a version may be claimed from: freshly `pending`, a `failed`
   * row still under its retry budget, or a `processing` row whose worker crashed
   * (its claim went stale). Recomputed per call so the stale cutoff moves with time.
   */
  private claimableConditions(): Prisma.DocumentVersionWhereInput[] {
    const staleCutoff = new Date(Date.now() - STALE_PROCESSING_MS);
    return [
      { extractionStatus: 'pending' },
      { extractionStatus: 'failed', extractionAttempts: { lt: MAX_EXTRACTION_ATTEMPTS } },
      { extractionStatus: 'processing', extractionStartedAt: { lt: staleCutoff } },
    ];
  }

  async processVersion(versionId: string): Promise<ExtractionStatus | null> {
    // Atomic compare-and-swap claim: the WHERE matches the current claimable state,
    // so concurrent workers (poller + eager start) can never both win the same row.
    const claimed = await this.prisma.documentVersion.updateMany({
      where: { id: versionId, OR: this.claimableConditions() },
      data: {
        extractionStatus: 'processing',
        extractionError: null,
        extractionStartedAt: new Date(),
        extractionAttempts: { increment: 1 },
      },
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
          extractionStartedAt: null,
          // A successful extraction clears the retry budget.
          ...(extracted.status === 'done' ? { extractionAttempts: 0 } : {}),
        },
      });
      await this.recordProcessed(version.documentId, version.id, extracted.status, extracted.ocrApplied);
      return extracted.status;
    } catch (err) {
      const message = (err as Error).message;
      // Mark failed WITHOUT wiping any previously-extracted text: a transient failure
      // (OCR endpoint down, S3 blip) must never make an already-indexed doc
      // unsearchable. The attempt counter (incremented on claim) bounds retries.
      await this.prisma.documentVersion.update({
        where: { id: version.id },
        data: {
          extractionStatus: 'failed',
          extractionError: message.slice(0, MAX_ERROR_CHARS),
          extractionStartedAt: null,
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
