import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { toSql } from 'pgvector';
import type { EmbeddingStatus, AuthUser } from '@policymanager/shared';
import { AUDIT_ACTIONS } from '@policymanager/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { RequestContext } from '../audit/request-context';
import { type TextChunk } from './chunking.service';
import { StructureAwareChunkingService } from './structure-aware-chunking.service';
import { RagConfigService } from './rag-config.service';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from './embedding-provider';

/** Tally returned by batch embedding operations (mirrors ExtractionBatchResult). */
export interface EmbeddingBatchResult {
  queued?: number;
  processed: number;
  done: number;
  skipped: number;
  failed: number;
}

const MAX_ERROR_CHARS = 4000;
/** How many times a `failed` version is auto-retried before it stays terminal. */
const MAX_EMBEDDING_ATTEMPTS = 3;
/** A `processing` row older than this is treated as orphaned (worker crashed). */
const STALE_PROCESSING_MS = 10 * 60_000;
const DEFAULT_BATCH_LIMIT = 10;
/** Chunks written per multi-row INSERT (keeps round-trips low for big documents). */
const INSERT_BATCH_SIZE = 100;
/** Interactive-transaction budget for the delete+insert of one version's chunks.
 *  Well above Prisma's 5s default so a large document (many hundreds of chunks)
 *  never trips "Transaction already closed"; batching keeps real time far below this. */
const REPLACE_CHUNKS_TX_TIMEOUT_MS = 120_000;

/**
 * Semantic embedding worker (RAG Phase 1, ADR-0002).
 *
 * After extraction produces `extractedText`, this service chunks that text,
 * embeds each chunk via the vendor-agnostic {@link EmbeddingProvider}, and
 * upserts the vectors into `DocumentChunk`. It reuses the extraction worker's
 * proven design: a compare-and-swap claim over `embeddingStatus`, bounded
 * retries, stale-claim recovery, and best-effort semantics — an embedding
 * failure never touches version bytes and never fails the upload/extraction.
 *
 * Egress is gated: when the provider is not configured (RAG disabled or no key)
 * a version is marked `skipped` and NO text is sent anywhere.
 */
@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);

  constructor(
    private readonly prisma: PrismaService,
    // Structure-aware chunker (Phase 2): detects generic structural boundaries and
    // chunks WITHIN each unit, stamping section/page metadata; falls back to plain
    // token chunking for unstructured text. Same TextChunk[] contract as before.
    private readonly chunking: StructureAwareChunkingService,
    private readonly ragConfig: RagConfigService,
    private readonly audit: AuditService,
    @Inject(EMBEDDING_PROVIDER) private readonly provider: EmbeddingProvider,
  ) {}

  /**
   * States a version may be claimed from for embedding: freshly `pending`, a
   * `failed` row still under its retry budget, or a `processing` row whose worker
   * crashed (stale claim). Recomputed per call so the stale cutoff moves with time.
   */
  private claimableConditions(): Prisma.DocumentVersionWhereInput[] {
    const staleCutoff = new Date(Date.now() - STALE_PROCESSING_MS);
    return [
      { embeddingStatus: 'pending' },
      { embeddingStatus: 'failed', embeddingAttempts: { lt: MAX_EMBEDDING_ATTEMPTS } },
      { embeddingStatus: 'processing', embeddingStartedAt: { lt: staleCutoff } },
    ];
  }

  /**
   * Embed a single version. Idempotent: re-running replaces that version's prior
   * chunks. Returns the terminal status, or null if the row could not be claimed
   * (another worker won it, or it doesn't exist).
   */
  async embedVersion(versionId: string): Promise<EmbeddingStatus | null> {
    // Atomic compare-and-swap claim — concurrent workers can't both win a row.
    const claimed = await this.prisma.documentVersion.updateMany({
      where: { id: versionId, OR: this.claimableConditions() },
      data: {
        embeddingStatus: 'processing',
        embeddingError: null,
        embeddingStartedAt: new Date(),
        embeddingAttempts: { increment: 1 },
      },
    });
    if (claimed.count === 0) return null;

    const version = await this.prisma.documentVersion.findUnique({
      where: { id: versionId },
      select: {
        id: true,
        documentId: true,
        extractionStatus: true,
        extractedText: true,
      },
    });
    if (!version) return null;

    // Nothing to embed → skipped (no chunks, no egress). Covers: provider not
    // configured, extraction not done, or empty text. `skipped` is terminal but
    // re-runnable via reindex (which resets status to pending).
    if (!this.provider.isConfigured()) {
      return this.finishSkipped(version.documentId, version.id, 'RAG is disabled or unconfigured.');
    }
    if (version.extractionStatus !== 'done') {
      return this.finishSkipped(
        version.documentId,
        version.id,
        `Extraction status is '${version.extractionStatus}', not 'done'.`,
      );
    }
    const text = version.extractedText?.trim() ?? '';
    if (text.length === 0) {
      return this.finishSkipped(version.documentId, version.id, 'No extracted text to embed.');
    }

    try {
      const chunks = this.chunking.chunk(text, {
        maxTokens: this.ragConfig.chunkMaxTokens,
        overlapTokens: this.ragConfig.chunkOverlapTokens,
      });
      if (chunks.length === 0) {
        return this.finishSkipped(version.documentId, version.id, 'Chunker produced no chunks.');
      }

      // Safe reprocessing (Phase 2): only pay for embeddings when chunk CONTENT or
      // BOUNDARIES actually change. Reprocessing an unchanged version (e.g. a
      // structure-metadata backfill sweep) must not re-hit OpenAI or churn vectors.
      const existing = await this.prisma.documentChunk.findMany({
        where: { versionId: version.id },
        orderBy: { chunkIndex: 'asc' },
        select: { content: true, embeddingModel: true },
      });
      const contentUnchanged =
        existing.length === chunks.length &&
        existing.every((row, i) => row.content === chunks[i].content) &&
        existing.every((row) => row.embeddingModel === this.provider.model);

      if (contentUnchanged) {
        // Boundaries + content + model identical: refresh ONLY the structural
        // metadata (cheap, no embed) so a re-chunk that changed section fields but
        // not chunk text is still reflected, without a single OpenAI call.
        await this.refreshChunkMetadata(version.id, chunks);
        await this.prisma.documentVersion.update({
          where: { id: version.id },
          data: {
            embeddingStatus: 'done',
            embeddingError: null,
            embeddingStartedAt: null,
            embeddedAt: new Date(),
            embeddingAttempts: 0,
          },
        });
        await this.audit.record({
          action: AUDIT_ACTIONS.EMBEDDING_INDEXED,
          documentId: version.documentId,
          versionId: version.id,
          targetType: 'version',
          source: 'system',
          metadata: { chunks: chunks.length, model: this.provider.model, reembedded: false },
        });
        // Keep only this (current, published) version's chunks in the index.
        await this.pruneOtherVersionChunks(version.documentId, version.id);
        return 'done';
      }

      const vectors = await this.embedInBatches(chunks.map((c) => c.content));
      await this.replaceChunks(version.documentId, version.id, chunks, vectors);

      await this.prisma.documentVersion.update({
        where: { id: version.id },
        data: {
          embeddingStatus: 'done',
          embeddingError: null,
          embeddingStartedAt: null,
          embeddedAt: new Date(),
          embeddingAttempts: 0, // success clears the retry budget
        },
      });
      await this.audit.record({
        action: AUDIT_ACTIONS.EMBEDDING_INDEXED,
        documentId: version.documentId,
        versionId: version.id,
        targetType: 'version',
        source: 'system',
        metadata: { chunks: chunks.length, model: this.provider.model, reembedded: true },
      });
      // Keep only this (current, published) version's chunks in the index — a new
      // version supersedes the prior version's now-stale embeddings.
      await this.pruneOtherVersionChunks(version.documentId, version.id);
      return 'done';
    } catch (err) {
      const message = (err as Error).message ?? 'Unknown embedding error';
      await this.prisma.documentVersion.update({
        where: { id: version.id },
        data: {
          embeddingStatus: 'failed',
          embeddingError: message.slice(0, MAX_ERROR_CHARS),
          embeddingStartedAt: null,
        },
      });
      await this.audit.record({
        action: AUDIT_ACTIONS.EMBEDDING_FAILED,
        documentId: version.documentId,
        versionId: version.id,
        targetType: 'version',
        source: 'system',
        metadata: { error: message.slice(0, MAX_ERROR_CHARS) },
      });
      this.logger.warn(`Embedding failed for version ${version.id}: ${message}`);
      return 'failed';
    }
  }

  /** Marks a version `skipped` (no chunks written) and returns 'skipped'. */
  private async finishSkipped(
    documentId: string,
    versionId: string,
    reason: string,
  ): Promise<EmbeddingStatus> {
    await this.prisma.documentVersion.update({
      where: { id: versionId },
      data: {
        embeddingStatus: 'skipped',
        embeddingError: reason.slice(0, MAX_ERROR_CHARS),
        embeddingStartedAt: null,
        embeddingAttempts: 0,
      },
    });
    return 'skipped';
  }

  /** Embed chunk texts in provider-sized batches, preserving order. */
  private async embedInBatches(texts: string[]): Promise<number[][]> {
    const batchSize = Math.max(1, this.ragConfig.embeddingBatchSize);
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const vectors = await this.provider.embed(batch);
      out.push(...vectors);
    }
    return out;
  }

  /**
   * Transactionally replace all chunks for a version. Delete-then-insert makes
   * re-indexing idempotent: prior rows for the version are removed and replaced
   * with contiguous chunkIndexes. Uses raw SQL for the pgvector `embedding`
   * column (Prisma can't write an Unsupported("vector") field). Any error rolls
   * back the whole set, so chunks are never left half-written.
   */
  private async replaceChunks(
    documentId: string,
    versionId: string,
    chunks: TextChunk[],
    vectors: number[][],
  ): Promise<void> {
    if (vectors.length !== chunks.length) {
      throw new Error(
        `Embedding count (${vectors.length}) does not match chunk count (${chunks.length}).`,
      );
    }
    const model = this.provider.model;
    await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`
          DELETE FROM "policytracker"."DocumentChunk" WHERE "versionId" = ${versionId}
        `;
        // Insert in BATCHES of multi-row VALUES rather than one round-trip per chunk.
        // A large document produces many hundreds of chunks; ~1 INSERT per chunk
        // inside a single interactive transaction blows the (default 5s) timeout
        // (a real failure hit on a ~700-chunk manual). Batching cuts the round-trips
        // by INSERT_BATCH_SIZE× and, with the raised timeout below, keeps even very
        // large documents well inside the transaction budget.
        for (let start = 0; start < chunks.length; start += INSERT_BATCH_SIZE) {
          const slice = chunks.slice(start, start + INSERT_BATCH_SIZE);
          const rows = slice.map((chunk, j) => {
            const headingPath = chunk.headingPath ?? [];
            const metadata = JSON.stringify(chunk.metadata ?? {});
            // Structural metadata (ADR-0004, Option A). headingPath binds as a
            // Postgres text[] array param; metadata as ::jsonb.
            return Prisma.sql`(
              gen_random_uuid(), ${documentId}, ${versionId}, ${chunk.chunkIndex}, ${chunk.content},
              ${chunk.tokenCount}, ${toSql(vectors[start + j])}::"policytracker"."vector", ${model},
              ${chunk.sectionType ?? null}, ${chunk.sectionIdentifier ?? null},
              ${chunk.normalizedSectionIdentifier ?? null}, ${chunk.sectionTitle ?? null},
              ${headingPath}, ${chunk.pageStart ?? null}, ${chunk.pageEnd ?? null},
              ${metadata}::jsonb, now()
            )`;
          });
          await tx.$executeRaw`
            INSERT INTO "policytracker"."DocumentChunk"
              ("id", "documentId", "versionId", "chunkIndex", "content", "tokenCount",
               "embedding", "embeddingModel",
               "sectionType", "sectionIdentifier", "normalizedSectionIdentifier",
               "sectionTitle", "headingPath", "pageStart", "pageEnd", "metadata",
               "createdAt")
            VALUES ${Prisma.join(rows)}
          `;
        }
      },
      // Raise the interactive-transaction timeout well above the default 5s so a
      // large document's delete+insert completes; batching keeps actual time low.
      { timeout: REPLACE_CHUNKS_TX_TIMEOUT_MS },
    );
  }

  /**
   * Refresh ONLY the structural metadata of a version's existing chunks, keyed by
   * chunkIndex — used by safe reprocessing when chunk content + boundaries are
   * unchanged (so the embeddings are still valid) but a re-chunk produced updated
   * section fields. No embedding is regenerated and no vector is touched: this is
   * a metadata-only UPDATE, so it costs zero OpenAI calls. Runs in a transaction
   * so a partial update can't leave chunks inconsistent.
   */
  private async refreshChunkMetadata(versionId: string, chunks: TextChunk[]): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      for (const chunk of chunks) {
        const headingPath = chunk.headingPath ?? [];
        const metadata = JSON.stringify(chunk.metadata ?? {});
        await tx.$executeRaw`
          UPDATE "policytracker"."DocumentChunk"
          SET "sectionType" = ${chunk.sectionType ?? null},
              "sectionIdentifier" = ${chunk.sectionIdentifier ?? null},
              "normalizedSectionIdentifier" = ${chunk.normalizedSectionIdentifier ?? null},
              "sectionTitle" = ${chunk.sectionTitle ?? null},
              "headingPath" = ${headingPath},
              "pageStart" = ${chunk.pageStart ?? null},
              "pageEnd" = ${chunk.pageEnd ?? null},
              "metadata" = ${metadata}::jsonb
          WHERE "versionId" = ${versionId} AND "chunkIndex" = ${chunk.chunkIndex}
        `;
      }
    });
  }

  /**
   * Delete chunks belonging to OTHER versions of the same document, keeping only
   * `keepVersionId`'s chunks. Called after a version is embedded so that only the
   * latest-embedded (current, published) version's chunks remain in the index — a
   * new version's publish supersedes the prior version's embeddings, which are
   * retrieval-invisible anyway (retrieval filters to `currentVersionId`) and only
   * waste storage + bloat the vector index. Best-effort: a failure here is logged
   * and swallowed — it must never turn a successful embed into a failure, and the
   * leftover rows remain harmless (never retrieved). Version BYTES are untouched
   * (AGENTS.md §9 immutability applies to source objects, not the derived index).
   */
  private async pruneOtherVersionChunks(documentId: string, keepVersionId: string): Promise<void> {
    try {
      const deleted = await this.prisma.documentChunk.deleteMany({
        where: { documentId, versionId: { not: keepVersionId } },
      });
      if (deleted.count > 0) {
        await this.audit.record({
          action: AUDIT_ACTIONS.EMBEDDING_INDEXED,
          documentId,
          versionId: keepVersionId,
          targetType: 'version',
          source: 'system',
          metadata: { prunedStaleChunks: deleted.count },
        });
      }
    } catch (err) {
      this.logger.warn(
        `Pruning stale chunks for document ${documentId} failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Backfill: re-queue non-`done` embeddings for the current versions of live,
   * published documents and drain a bounded batch. Used by an operator action to
   * catch up the index (mirrors DocumentExtractionService.reindexAll).
   */
  async embedPending(user?: AuthUser, ctx: RequestContext = {}): Promise<EmbeddingBatchResult> {
    // The set we care about: current-version-published, extracted, not-yet-embedded.
    const publishedFilter = {
      embeddingStatus: { not: 'done' as const },
      extractionStatus: 'done' as const,
      hasExtractedText: true,
      document: { deletedAt: null, status: 'published' as const },
    };
    const requeued = await this.prisma.documentVersion.updateMany({
      where: publishedFilter,
      data: {
        embeddingStatus: 'pending',
        embeddingError: null,
        embeddingAttempts: 0,
        embeddingStartedAt: null,
      },
    });
    if (user) {
      await this.audit.record({
        action: AUDIT_ACTIONS.EMBEDDING_INDEXED,
        actorUserId: user.id,
        targetType: 'system',
        ...ctx,
        metadata: { requeued: requeued.count, backfill: true },
      });
    }
    // Process EXACTLY the published set we just requeued — not the global oldest-N
    // (a small published set must not be starved behind a large unrelated backlog
    // of non-published pending versions).
    const targets = await this.prisma.documentVersion.findMany({
      where: publishedFilter,
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    const result: EmbeddingBatchResult = { processed: 0, done: 0, skipped: 0, failed: 0 };
    for (const row of targets) {
      const status = await this.embedVersion(row.id);
      if (!status) continue;
      result.processed += 1;
      if (status === 'done') result.done += 1;
      else if (status === 'skipped') result.skipped += 1;
      else if (status === 'failed') result.failed += 1;
    }
    return { queued: requeued.count, ...result };
  }

  /** Claim and embed up to `limit` pending versions. */
  async processPending(limit = DEFAULT_BATCH_LIMIT): Promise<EmbeddingBatchResult> {
    const rows = await this.prisma.documentVersion.findMany({
      where: { document: { deletedAt: null }, OR: this.claimableConditions() },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    const result: EmbeddingBatchResult = { processed: 0, done: 0, skipped: 0, failed: 0 };
    for (const row of rows) {
      const status = await this.embedVersion(row.id);
      if (!status) continue;
      result.processed += 1;
      if (status === 'done') result.done += 1;
      else if (status === 'skipped') result.skipped += 1;
      else if (status === 'failed') result.failed += 1;
    }
    return result;
  }
}
