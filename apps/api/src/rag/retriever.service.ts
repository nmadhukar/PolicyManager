import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { toSql } from 'pgvector';
import type { AuthUser } from '@policymanager/shared';
import { PrismaService } from '../prisma/prisma.service';
import { DocumentAccessService } from '../documents/document-access.service';
import { RagConfigService } from './rag-config.service';
import { EmbeddingCache } from './embedding-cache.service';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from './embedding-provider';

/** A retrieved chunk with enough context for grounding + citation (Phase 3/4). */
export interface RetrievedChunk {
  documentId: string;
  versionId: string;
  chunkId: string;
  chunkIndex: number;
  content: string;
  /** Relevance score derived from cosine distance as `1 - distance` (cosine
   *  distance ∈ [0,2] ⇒ score ∈ [-1,1]); higher = more relevant. */
  score: number;
  documentTitle: string;
  documentNumber: string | null;
}

export interface RetrieveOptions {
  /** When present, results are re-filtered to what this user may view (ACL). */
  user?: AuthUser;
  /** Override the configured topK for this call. */
  topK?: number;
}

interface VectorRow {
  chunkId: string;
  documentId: string;
  versionId: string;
  chunkIndex: number;
  content: string;
  distance: number;
}

interface FtsRow {
  chunkId: string;
  documentId: string;
  versionId: string;
  chunkIndex: number;
  content: string;
  rank: number;
}

/** A chunk ranked by either leg, keyed for fusion + hydration. */
interface FusedChunk {
  chunkId: string;
  documentId: string;
  versionId: string;
  chunkIndex: number;
  content: string;
  /** Best (lowest) cosine distance this chunk had in the vector leg, if any. */
  distance: number | null;
  score: number;
}

/**
 * TRUE hybrid retriever (RAG Phase 2). Runs pgvector cosine-similarity KNN and
 * Postgres full-text search over chunk content as two FULLY INDEPENDENT legs —
 * neither depends on the other's results — then fuses them with Reciprocal
 * Rank Fusion. This is what lets an exact lexical match (a policy number,
 * regulation name, section title, acronym) surface a chunk even when semantic
 * similarity alone would rank it too far away: FTS is a real retrieval path,
 * not merely a re-ranker over whatever vector search already found.
 *
 * The fused candidates are then RE-FILTERED through the same ACL/visibility
 * seam as document access (AGENTS.md §8). Only the CURRENT published,
 * non-deleted version's chunks are ever returned — superseded versions' chunks
 * still exist but are filtered out by both legs' current-version join.
 *
 * Egress is gated: with the provider unconfigured, retrieve() returns [] and
 * makes zero embed calls / zero vector SQL (FTS still requires an embed-free
 * query, but the whole method short-circuits before either leg runs).
 */
@Injectable()
export class RetrieverService {
  private readonly logger = new Logger(RetrieverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: DocumentAccessService,
    private readonly ragConfig: RagConfigService,
    @Inject(EMBEDDING_PROVIDER) private readonly provider: EmbeddingProvider,
    private readonly cache: EmbeddingCache,
  ) {}

  /**
   * Retrieve the most relevant current-version chunks for `query`, ranked by a
   * hybrid vector+FTS score and filtered to what `opts.user` may view.
   */
  async retrieve(query: string, opts: RetrieveOptions = {}): Promise<RetrievedChunk[]> {
    const term = query.trim();
    if (term.length === 0) return [];
    // Fail closed: no key/flag → no egress, no vector SQL.
    if (!this.provider.isConfigured()) return [];

    const topK = Math.max(1, opts.topK ?? this.ragConfig.retrievalTopK);
    const vectorPool = Math.max(topK, this.ragConfig.retrievalCandidatePool);
    const ftsPool = Math.max(topK, this.ragConfig.ftsCandidatePool);

    // 1. Vector KNN over current-version published chunks. The query embedding is
    //    cached (per query+model) to cut repeat latency/cost; the cache never
    //    holds retrieved rows (those are ACL-scoped per user).
    let queryVector: number[];
    const cached = this.cache.get(term, this.provider.model);
    if (cached) {
      queryVector = cached;
    } else {
      try {
        const [vec] = await this.provider.embed([term]);
        queryVector = vec;
        this.cache.set(term, this.provider.model, vec);
      } catch (err) {
        this.logger.warn(`Query embedding failed: ${(err as Error).message}`);
        return [];
      }
    }

    // 2. Run both retrieval legs INDEPENDENTLY — neither depends on the other's
    //    results. This is what lets an exact lexical match (policy number,
    //    regulation name, section title) surface a chunk that vector search
    //    ranks too far away, and vice versa.
    const [allVectorRows, ftsRows] = await Promise.all([
      this.vectorSearch(queryVector, vectorPool),
      this.ftsSearch(term, ftsPool),
    ]);
    // Drop weak vector matches: a chunk beyond the distance floor is not really
    // "about" the query on the semantic leg. This filters ONLY the vector leg's
    // own candidates — it is a quality gate on that leg, not a cross-leg gate on
    // FTS. A strong independent FTS match still enters fusion on its own merit.
    const maxDistance = this.ragConfig.retrievalMaxDistance;
    const vectorRows = allVectorRows.filter((r) => r.distance <= maxDistance);

    // 3. Reciprocal Rank Fusion over CHUNKS (not documents), keyed by chunkId.
    const fused = this.fuseChunks(vectorRows, ftsRows);
    if (fused.length === 0) return [];

    // 4. ACL/visibility re-filter: keep only documents the user may view AND that
    //    are published + not deleted.
    const fusedDocIds = [...new Set(fused.map((c) => c.documentId))];
    const visibleDocIds = await this.filterVisible(fusedDocIds, opts.user);
    if (visibleDocIds.size === 0) return [];

    // 5. Assemble ranked chunks from the fused list — capped at topK. A chunk
    //    may have come from either leg (or both); content is hydrated from
    //    whichever leg found it.
    return this.assembleHits(fused, visibleDocIds, topK);
  }

  /**
   * pgvector cosine-distance KNN. Restricts to chunks of each document's CURRENT
   * version, for published, non-deleted documents. The cosine operator `<=>`
   * matches the HNSW `vector_cosine_ops` index; the query vector is cast to the
   * schema-qualified `policytracker.vector` type (resolves regardless of the
   * caller's search_path).
   */
  private async vectorSearch(queryVector: number[], limit: number): Promise<VectorRow[]> {
    const literal = toSql(queryVector);
    return this.prisma.$queryRaw<VectorRow[]>(Prisma.sql`
      SELECT dc."id"           AS "chunkId",
             dc."documentId"   AS "documentId",
             dc."versionId"    AS "versionId",
             dc."chunkIndex"   AS "chunkIndex",
             dc."content"      AS "content",
             (dc."embedding" OPERATOR("policytracker".<=>) ${literal}::"policytracker"."vector")::float8 AS "distance"
      FROM "policytracker"."DocumentChunk" dc
      JOIN "policytracker"."Document" d ON d."id" = dc."documentId"
      WHERE dc."versionId" = d."currentVersionId"
        AND d."status" = 'published'
        AND d."deletedAt" IS NULL
        AND dc."embedding" IS NOT NULL
      ORDER BY dc."embedding" OPERATOR("policytracker".<=>) ${literal}::"policytracker"."vector"
      LIMIT ${limit}
    `);
  }

  /**
   * Full-text candidate CHUNKS, best-first — an INDEPENDENT retrieval leg (not a
   * re-rank of vector search's output). Ranks each chunk's own tsvector
   * (`DocumentChunk.searchVector`, a stored-generated column over `content`)
   * plus the parent document's title/number/description, so an exact phrase —
   * a policy number, regulation name, section title, acronym — can retrieve the
   * specific chunk that contains it even when vector search ranks it too far
   * away. Scoped to the current version, published, non-deleted documents —
   * the same scoping vectorSearch applies.
   */
  private async ftsSearch(term: string, limit: number): Promise<FtsRow[]> {
    const query = Prisma.sql`plainto_tsquery('english', ${term})`;
    const vector = Prisma.sql`(
      setweight(to_tsvector('english', coalesce(d."title", '')), 'A') ||
      setweight(to_tsvector('english', coalesce(d."documentNumber", '')), 'B') ||
      setweight(to_tsvector('english', coalesce(d."description", '')), 'B') ||
      coalesce(dc."searchVector", to_tsvector('english', ''))
    )`;
    return this.prisma.$queryRaw<FtsRow[]>(Prisma.sql`
      SELECT dc."id"           AS "chunkId",
             dc."documentId"   AS "documentId",
             dc."versionId"    AS "versionId",
             dc."chunkIndex"   AS "chunkIndex",
             dc."content"      AS "content",
             ts_rank_cd(${vector}, ${query})::float8 AS "rank"
      FROM "policytracker"."DocumentChunk" dc
      JOIN "policytracker"."Document" d ON d."id" = dc."documentId"
      WHERE dc."versionId" = d."currentVersionId"
        AND d."status" = 'published'
        AND d."deletedAt" IS NULL
        AND ${vector} @@ ${query}
      ORDER BY ts_rank_cd(${vector}, ${query}) DESC
      LIMIT ${limit}
    `);
  }

  /**
   * Reciprocal Rank Fusion over the two INDEPENDENT rankings, keyed by chunkId.
   * A chunk's fused score is Σ 1/(k + rank) across the legs it appears in, so a
   * chunk ranking in BOTH beats one ranking in only one — but a chunk found by
   * only ONE leg still competes on that leg's rank alone. This is the fix:
   * neither leg gates the other, so a strong lexical-only match (exact policy
   * number, regulation name, section title) surfaces on its own merit, and a
   * strong semantic-only match likewise needs no lexical corroboration.
   * Returns fused chunks best-first.
   */
  private fuseChunks(vectorRows: VectorRow[], ftsRows: FtsRow[]): FusedChunk[] {
    const k = this.ragConfig.rrfK;
    const scores = new Map<string, number>();
    const chunks = new Map<string, FusedChunk>();
    const add = (chunkId: string, rank: number) => {
      scores.set(chunkId, (scores.get(chunkId) ?? 0) + 1 / (k + rank));
    };

    vectorRows.forEach((row, rank) => {
      add(row.chunkId, rank);
      chunks.set(row.chunkId, {
        chunkId: row.chunkId,
        documentId: row.documentId,
        versionId: row.versionId,
        chunkIndex: row.chunkIndex,
        content: row.content,
        distance: row.distance,
        score: 0,
      });
    });
    ftsRows.forEach((row, rank) => {
      add(row.chunkId, rank);
      const existing = chunks.get(row.chunkId);
      if (existing) {
        // Same chunk found by both legs: keep the vector row's distance, content
        // is identical either way.
        return;
      }
      chunks.set(row.chunkId, {
        chunkId: row.chunkId,
        documentId: row.documentId,
        versionId: row.versionId,
        chunkIndex: row.chunkIndex,
        content: row.content,
        distance: null,
        score: 0,
      });
    });

    return [...chunks.values()]
      .map((c) => ({ ...c, score: scores.get(c.chunkId) ?? 0 }))
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Re-filter candidate document ids through the ACL/visibility seam. Reuses
   * DocumentAccessService.buildListWhere (confidential/grant logic; Admins see
   * all) and re-asserts published + not-deleted. Returns the set that survives.
   */
  private async filterVisible(docIds: string[], user?: AuthUser): Promise<Set<string>> {
    const accessWhere = user ? await this.access.buildListWhere(user) : {};
    const rows = await this.prisma.document.findMany({
      where: {
        AND: [
          { id: { in: docIds } },
          { status: 'published', deletedAt: null },
          accessWhere,
        ],
      },
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  }

  /**
   * Build the final ranked chunk list from the fused ranking: keep chunks whose
   * document is visible, in fused-score order, capped at topK. A chunk may have
   * been found by vector search, FTS, or both — fusion (not document grouping)
   * decides the order, so an FTS-only chunk from a document vector search never
   * touched can still surface here.
   */
  private assembleHits(
    fused: FusedChunk[],
    visible: Set<string>,
    topK: number,
  ): Promise<RetrievedChunk[]> | RetrievedChunk[] {
    const ordered = fused.filter((c) => visible.has(c.documentId)).slice(0, topK);
    if (ordered.length === 0) return [];
    return this.hydrateDocuments(ordered);
  }

  /** Attach document title/number to the ranked chunks. */
  private async hydrateDocuments(rows: FusedChunk[]): Promise<RetrievedChunk[]> {
    const docIds = [...new Set(rows.map((r) => r.documentId))];
    const docs = await this.prisma.document.findMany({
      where: { id: { in: docIds } },
      select: { id: true, title: true, documentNumber: true },
    });
    const byId = new Map(docs.map((d) => [d.id, d]));
    return rows.map((r) => {
      const doc = byId.get(r.documentId);
      return {
        documentId: r.documentId,
        versionId: r.versionId,
        chunkId: r.chunkId,
        chunkIndex: r.chunkIndex,
        content: r.content,
        // Cosine distance ∈ [0,2] maps to a [~-1,1] relevance where higher = closer,
        // when the chunk was found by the vector leg. An FTS-only chunk has no
        // distance, so its RRF fused score is exposed instead — still "higher is
        // more relevant", just not on the same numeric scale as the vector score.
        score: r.distance !== null ? 1 - r.distance : r.score,
        documentTitle: doc?.title ?? '',
        documentNumber: doc?.documentNumber ?? null,
      };
    });
  }
}
