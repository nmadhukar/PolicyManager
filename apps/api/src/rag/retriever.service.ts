import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { toSql } from 'pgvector';
import type { AuthUser } from '@policymanager/shared';
import { PrismaService } from '../prisma/prisma.service';
import { DocumentAccessService } from '../documents/document-access.service';
import { RagConfigService } from './rag-config.service';
import { EmbeddingCache } from './embedding-cache.service';
import { StructureDetectorService } from './structure-detector.service';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from './embedding-provider';

/**
 * The structural metadata columns every retrieval leg SELECTs, so a fused chunk
 * can surface section/page in citations without a second fetch. Defined once and
 * spliced into each raw query (identical alias set → uniform LegRow shape).
 */
const STRUCTURE_COLUMNS = Prisma.sql`
  dc."sectionType"                 AS "sectionType",
  dc."sectionIdentifier"           AS "sectionIdentifier",
  dc."normalizedSectionIdentifier" AS "normalizedSectionIdentifier",
  dc."sectionTitle"                AS "sectionTitle",
  dc."headingPath"                 AS "headingPath",
  dc."pageStart"                   AS "pageStart",
  dc."pageEnd"                     AS "pageEnd"
`;

/** Structural provenance surfaced on a retrieved chunk (Phase 1/2 metadata). */
export interface RetrievedChunkStructure {
  sectionType: string | null;
  sectionIdentifier: string | null;
  normalizedSectionIdentifier: string | null;
  sectionTitle: string | null;
  headingPath: string[];
  pageStart: number | null;
  pageEnd: number | null;
}

/** A retrieved chunk with enough context for grounding + citation (Phase 3/4). */
export interface RetrievedChunk extends RetrievedChunkStructure {
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
  /** Version-aware citation fields (Phase 4): the source version's number and the
   *  document's effective date. Null when unknown/unset. */
  versionNumber: number | null;
  effectiveDate: Date | null;
  /** True when this chunk matched the EXACT-identifier leg (query named its id). */
  exactMatch: boolean;
  /** True when this chunk was pulled in as an ADJACENT-context neighbor, not a
   *  primary ranked hit — lets the context builder mark expansion context. */
  adjacent: boolean;
}

/**
 * A group of visible documents that share the SAME requested identifier (RAG
 * Phase 4 duplicate-identifier disambiguation). When a query names an identifier
 * that resolves to more than one distinct document, the chat layer can present the
 * options / ask one clarifying question instead of silently blending them.
 */
export interface IdentifierCollision {
  normalizedIdentifier: string;
  documents: { documentId: string; documentTitle: string; documentNumber: string | null }[];
}

/** Retrieval result plus multi-document intelligence signals (Phase 4). */
export interface RetrievalResult {
  chunks: RetrievedChunk[];
  /** Non-empty when a named identifier matched multiple distinct visible documents. */
  collisions: IdentifierCollision[];
}

export interface RetrieveOptions {
  /** When present, results are re-filtered to what this user may view (ACL). */
  user?: AuthUser;
  /** Override the configured topK for this call. */
  topK?: number;
}

/** Common shape every retrieval leg returns (structural fields included so the
 *  fused chunk can surface section/page in citations without a re-fetch). */
interface LegRow extends RetrievedChunkStructure {
  chunkId: string;
  documentId: string;
  versionId: string;
  chunkIndex: number;
  content: string;
}

interface VectorRow extends LegRow {
  distance: number;
}

interface FtsRow extends LegRow {
  rank: number;
}

/** Exact-identifier leg row — same shape as the others (no per-row score; its
 *  contribution is a rank in the fusion plus the exact-match boost). */
type ExactRow = LegRow;

/** A chunk ranked by any leg, keyed for fusion + hydration. */
interface FusedChunk extends RetrievedChunkStructure {
  chunkId: string;
  documentId: string;
  versionId: string;
  chunkIndex: number;
  content: string;
  /** Best (lowest) cosine distance this chunk had in the vector leg, if any. */
  distance: number | null;
  score: number;
  /** True when this chunk came from the exact-identifier leg. */
  exactMatch: boolean;
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
    private readonly detector: StructureDetectorService,
  ) {}

  /**
   * Retrieve the most relevant current-version chunks for `query`, ranked by a
   * hybrid vector+FTS score and filtered to what `opts.user` may view. Thin wrapper
   * over {@link retrieveWithIntelligence} that returns just the chunks (backward-
   * compatible contract for the agent tool / callers that don't need collisions).
   */
  async retrieve(query: string, opts: RetrieveOptions = {}): Promise<RetrievedChunk[]> {
    const { chunks } = await this.retrieveWithIntelligence(query, opts);
    return chunks;
  }

  /**
   * Full multi-document retrieval (RAG Phase 4): the hybrid three-leg retrieval PLUS
   * document diversity / per-document caps and DUPLICATE-IDENTIFIER detection. Returns
   * the ranked chunks and any identifier COLLISIONS (the same named identifier found
   * in more than one visible document) so the chat layer can disambiguate rather than
   * silently blend unrelated sections.
   */
  async retrieveWithIntelligence(query: string, opts: RetrieveOptions = {}): Promise<RetrievalResult> {
    const empty: RetrievalResult = { chunks: [], collisions: [] };
    const term = query.trim();
    if (term.length === 0) return empty;
    // Fail closed: no key/flag → no egress, no vector SQL.
    if (!this.provider.isConfigured()) return empty;

    const topK = Math.max(1, opts.topK ?? this.ragConfig.retrievalTopK);
    const vectorPool = Math.max(topK, this.ragConfig.retrievalCandidatePool);
    const ftsPool = Math.max(topK, this.ragConfig.ftsCandidatePool);

    // 0. Query analysis: does the query NAME a structural identifier (Policy 705,
    //    SOP-0045, Section 504, Clause 8.3, Article IV)? If so, we add a third,
    //    independent EXACT-identifier leg. For plain semantic queries no extra leg
    //    runs (so ordinary retrieval is unchanged).
    const exactIds = this.extractQueryIdentifiers(term);

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
        return empty;
      }
    }

    // 2. Run the retrieval legs INDEPENDENTLY — no leg depends on another's output.
    //    Vector + FTS always run; the exact-identifier leg runs only when the query
    //    named an identifier. This is what lets an exact request ("Policy 705")
    //    surface the right SECTION, a lexical phrase surface via FTS, and a semantic
    //    question surface via the vector leg — each on its own merit.
    const [allVectorRows, ftsRows, exactRows] = await Promise.all([
      this.vectorSearch(queryVector, vectorPool),
      this.ftsSearch(term, ftsPool),
      exactIds.length > 0
        ? this.exactIdentifierSearch(exactIds, this.ragConfig.exactCandidatePool)
        : Promise.resolve([] as ExactRow[]),
    ]);
    // Drop weak vector matches: a chunk beyond the distance floor is not really
    // "about" the query on the semantic leg. This filters ONLY the vector leg's
    // own candidates — it is a quality gate on that leg, not a cross-leg gate on
    // FTS/exact. A strong independent lexical/exact match still enters fusion.
    const maxDistance = this.ragConfig.retrievalMaxDistance;
    const vectorRows = allVectorRows.filter((r) => r.distance <= maxDistance);

    // 3. Reciprocal Rank Fusion over CHUNKS (keyed by chunkId), across all legs.
    //    A chunk from the exact leg additionally receives the exact-match boost so
    //    the explicitly-requested section ranks ahead of merely-similar chunks.
    const fused = this.fuseChunks(vectorRows, ftsRows, exactRows);
    if (fused.length === 0) return empty;

    // 4. ACL/visibility re-filter: keep only documents the user may view AND that
    //    are published + not deleted.
    const fusedDocIds = [...new Set(fused.map((c) => c.documentId))];
    const visibleDocIds = await this.filterVisible(fusedDocIds, opts.user);
    if (visibleDocIds.size === 0) return empty;

    // 5. Assemble ranked anchors with document diversity + per-document caps
    //    (Phase 4 anti-monopolization; exact-section requests bypass the cap).
    const anchors = this.assembleAnchors(fused, visibleDocIds, topK);
    if (anchors.length === 0) return empty;

    // 6. Adjacent-chunk expansion: pull chunkIndex±N neighbors around each anchor
    //    (same version + same section) for continuous context. Deterministic and
    //    ACL-safe (neighbors share the anchor's already-visible document).
    const expanded = await this.expandAdjacent(anchors);

    // 7. Hydrate title/number/version/effectiveDate and finalize the ranked list.
    const chunks = await this.hydrateDocuments(expanded);

    // 8. Duplicate-identifier detection (Phase 4): if a named identifier matched
    //    more than one visible document, report it so the caller can disambiguate.
    const collisions = this.detectCollisions(chunks, exactIds);

    return { chunks, collisions };
  }

  /**
   * Extract normalized structural identifiers NAMED in the query. Generic and
   * document-type-neutral (reuses the same detector the ingestion path uses), so
   * "Policy 705", "Section 504", "SOP-0045", "Clause 8.3", "Article IV",
   * "42 CFR Part 2" all resolve to a normalized id the exact leg can look up. A
   * query with no identifier yields [] and no exact leg runs.
   */
  private extractQueryIdentifiers(term: string): string[] {
    const ids = new Set<string>();
    // Try the whole line as a heading (covers "Policy 705", "Section 504 …").
    const whole = this.detector.matchHeadingLine(term);
    if (whole?.normalizedSectionIdentifier) ids.add(whole.normalizedSectionIdentifier);
    // Also scan for identifier-shaped tokens embedded in a natural-language
    // question ("what does Policy 705 say about restraint?"). Feed the FULL matched
    // substring (m[0]) back through the detector so a self-labeled id like SOP-0045
    // is normalized once, not re-split into a spurious "sop 0045".
    for (const m of term.matchAll(
      /\b(?:Policy|Procedure|SOP|Section|Sec\.?|Clause|Article|Chapter|Appendix|Form|Standard)\s*[#:-]?\s*[A-Za-z]{0,4}-?[0-9IVXLC]+(?:\.[0-9]+)*[A-Za-z]?\b/gi,
    )) {
      const candidate = this.detector.matchHeadingLine(m[0]);
      if (candidate?.normalizedSectionIdentifier) ids.add(candidate.normalizedSectionIdentifier);
    }
    // CFR-style regulatory citations.
    for (const m of term.matchAll(/\b(\d{1,3}\s+CFR(?:\s+Part)?\s+[\d.]+)\b/gi)) {
      const norm = this.detector.normalizeIdentifier(m[1]);
      if (norm) ids.add(norm);
    }
    return [...ids];
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
             ${STRUCTURE_COLUMNS},
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
             ${STRUCTURE_COLUMNS},
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
   * EXACT-identifier leg (RAG Phase 3) — an INDEPENDENT retrieval path that finds
   * chunks whose `normalizedSectionIdentifier` equals a folded identifier NAMED in
   * the query (Policy 705, SOP-0045, Section 504, Clause 8.3, Article IV→"4"). Uses
   * the partial btree index on `normalizedSectionIdentifier`. Same current-version /
   * published / not-deleted scoping as the other legs. Ordered by chunkIndex so a
   * requested section's chunks come out in reading order, ready for assembly. When
   * the query names no identifier this leg is never invoked (see retrieve()).
   */
  private async exactIdentifierSearch(normalizedIds: string[], limit: number): Promise<ExactRow[]> {
    return this.prisma.$queryRaw<ExactRow[]>(Prisma.sql`
      SELECT dc."id"           AS "chunkId",
             dc."documentId"   AS "documentId",
             dc."versionId"    AS "versionId",
             dc."chunkIndex"   AS "chunkIndex",
             dc."content"      AS "content",
             ${STRUCTURE_COLUMNS}
      FROM "policytracker"."DocumentChunk" dc
      JOIN "policytracker"."Document" d ON d."id" = dc."documentId"
      WHERE dc."versionId" = d."currentVersionId"
        AND d."status" = 'published'
        AND d."deletedAt" IS NULL
        AND dc."normalizedSectionIdentifier" = ANY(${normalizedIds})
      ORDER BY dc."documentId", dc."chunkIndex"
      LIMIT ${limit}
    `);
  }

  /**
   * Reciprocal Rank Fusion over the (up to) THREE INDEPENDENT rankings, keyed by
   * chunkId. A chunk's fused score is Σ 1/(k + rank) across the legs it appears in,
   * so a chunk ranking in more legs beats one ranking in fewer — but a chunk found
   * by only ONE leg still competes on that leg's rank alone (no leg gates another).
   *
   * EXACT-MATCH PRIORITY: a chunk that came from the exact-identifier leg also gets
   * an additive `exactMatchBoost`, so when the user names "Policy 705" its chunks
   * rank ahead of merely-similar chunks. The boost is additive (not a replacement),
   * so exact requests are prioritized without silencing the vector/FTS legs.
   *
   * DETERMINISTIC ordering: ties on fused score are broken by (documentId,
   * chunkIndex) so identical inputs always yield an identical ranking.
   */
  private fuseChunks(
    vectorRows: VectorRow[],
    ftsRows: FtsRow[],
    exactRows: ExactRow[],
  ): FusedChunk[] {
    const k = this.ragConfig.rrfK;
    const boost = this.ragConfig.exactMatchBoost;
    const scores = new Map<string, number>();
    const chunks = new Map<string, FusedChunk>();
    const add = (chunkId: string, rank: number) => {
      scores.set(chunkId, (scores.get(chunkId) ?? 0) + 1 / (k + rank));
    };
    const upsert = (row: LegRow, distance: number | null, exact: boolean) => {
      const existing = chunks.get(row.chunkId);
      if (existing) {
        if (distance !== null && existing.distance === null) existing.distance = distance;
        if (exact) existing.exactMatch = true;
        return;
      }
      chunks.set(row.chunkId, {
        chunkId: row.chunkId,
        documentId: row.documentId,
        versionId: row.versionId,
        chunkIndex: row.chunkIndex,
        content: row.content,
        distance,
        score: 0,
        exactMatch: exact,
        ...structureOf(row),
      });
    };

    vectorRows.forEach((row, rank) => {
      add(row.chunkId, rank);
      upsert(row, row.distance, false);
    });
    ftsRows.forEach((row, rank) => {
      add(row.chunkId, rank);
      upsert(row, null, false);
    });
    exactRows.forEach((row, rank) => {
      add(row.chunkId, rank);
      upsert(row, null, true);
    });

    return [...chunks.values()]
      .map((c) => ({ ...c, score: (scores.get(c.chunkId) ?? 0) + (c.exactMatch ? boost : 0) }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.documentId.localeCompare(b.documentId) ||
          a.chunkIndex - b.chunkIndex,
      );
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
   * Select the top-K ANCHOR chunks from the fused ranking whose document is visible,
   * applying DOCUMENT DIVERSITY + a PER-DOCUMENT CAP (RAG Phase 4) so one large
   * document cannot monopolize the result on a broad query. Chunks are considered in
   * deterministic fused-score order; each document may contribute at most
   * `maxChunksPerDocument` anchors — EXCEPT chunks from the EXACT-identifier leg,
   * which bypass the cap so a whole explicitly-requested section can be assembled.
   * When capping would otherwise drop everything (e.g. cap smaller than a single
   * exact section), exact chunks are always kept.
   */
  private assembleAnchors(fused: FusedChunk[], visible: Set<string>, topK: number): FusedChunk[] {
    const cap = this.ragConfig.maxChunksPerDocument;
    const visibleFused = fused.filter((c) => visible.has(c.documentId));
    if (cap <= 0) return visibleFused.slice(0, topK);

    const perDoc = new Map<string, number>();
    const out: FusedChunk[] = [];
    for (const c of visibleFused) {
      if (out.length >= topK) break;
      // Exact-identifier matches bypass the per-document cap: an explicit "Policy
      // 705" request must be able to assemble the whole of Policy 705 even if that
      // is more than `cap` chunks from one document.
      if (!c.exactMatch) {
        const count = perDoc.get(c.documentId) ?? 0;
        if (count >= cap) continue;
        perDoc.set(c.documentId, count + 1);
      }
      out.push(c);
    }
    return out;
  }

  /**
   * Detect DUPLICATE IDENTIFIERS across documents (RAG Phase 4). Given the exact
   * identifiers named in a query and the retrieved chunks, report every identifier
   * that resolved to MORE THAN ONE distinct visible document — so the chat layer can
   * disambiguate (present options / ask one question) instead of silently blending
   * unrelated sections that merely share a number. Deterministic ordering.
   */
  private detectCollisions(chunks: RetrievedChunk[], exactIds: string[]): IdentifierCollision[] {
    if (exactIds.length === 0) return [];
    const wanted = new Set(exactIds);
    const byId = new Map<string, Map<string, { documentTitle: string; documentNumber: string | null }>>();
    for (const c of chunks) {
      const norm = c.normalizedSectionIdentifier;
      if (!norm || !wanted.has(norm)) continue;
      if (!byId.has(norm)) byId.set(norm, new Map());
      byId.get(norm)!.set(c.documentId, {
        documentTitle: c.documentTitle,
        documentNumber: c.documentNumber,
      });
    }
    const collisions: IdentifierCollision[] = [];
    for (const [normalizedIdentifier, docs] of byId) {
      if (docs.size < 2) continue;
      collisions.push({
        normalizedIdentifier,
        documents: [...docs.entries()]
          .map(([documentId, meta]) => ({ documentId, ...meta }))
          .sort((a, b) => a.documentId.localeCompare(b.documentId)),
      });
    }
    return collisions.sort((a, b) => a.normalizedIdentifier.localeCompare(b.normalizedIdentifier));
  }

  /**
   * ADJACENT-CHUNK EXPANSION (RAG Phase 3). Around each anchor, pull chunkIndex±N
   * neighbors (config `adjacentExpansion`) from the SAME version and, when the
   * anchor is in a section, the SAME normalizedSectionIdentifier — so expansion
   * never crosses a section boundary. Neighbors inherit the anchor's document (already
   * ACL-visible), carry `adjacent: true`, and keep the anchor's rank position so a
   * requested section reads in order. Deterministic; no new ACL surface.
   */
  private async expandAdjacent(anchors: FusedChunk[]): Promise<FusedChunk[]> {
    const span = this.ragConfig.adjacentExpansion;
    if (span <= 0) return anchors;

    // Collect the neighbor (versionId, chunkIndex) coordinates we need, excluding
    // anchors themselves (dedup by chunk identity later).
    const anchorKey = (versionId: string, idx: number) => `${versionId}#${idx}`;
    const have = new Set(anchors.map((a) => anchorKey(a.versionId, a.chunkIndex)));
    const wants: { versionId: string; index: number; section: string | null }[] = [];
    for (const a of anchors) {
      for (let d = -span; d <= span; d++) {
        if (d === 0) continue;
        const idx = a.chunkIndex + d;
        if (idx < 0) continue;
        if (have.has(anchorKey(a.versionId, idx))) continue;
        wants.push({ versionId: a.versionId, index: idx, section: a.normalizedSectionIdentifier });
      }
    }
    if (wants.length === 0) return anchors;

    // Fetch all wanted neighbors in one query (OR of (versionId, chunkIndex) pairs),
    // then keep only those whose section matches the requesting anchor's section (or
    // whose anchor had no section — then any same-version neighbor is fine).
    const neighborRows = await this.prisma.documentChunk.findMany({
      where: {
        OR: wants.map((w) => ({ versionId: w.versionId, chunkIndex: w.index })),
      },
      select: {
        id: true,
        documentId: true,
        versionId: true,
        chunkIndex: true,
        content: true,
        sectionType: true,
        sectionIdentifier: true,
        normalizedSectionIdentifier: true,
        sectionTitle: true,
        headingPath: true,
        pageStart: true,
        pageEnd: true,
      },
    });
    const neighborByKey = new Map(neighborRows.map((r) => [anchorKey(r.versionId, r.chunkIndex), r]));

    const out: FusedChunk[] = [];
    const seen = new Set<string>();
    for (const a of anchors) {
      out.push(a);
      seen.add(a.chunkId);
      for (let d = -span; d <= span; d++) {
        if (d === 0) continue;
        const idx = a.chunkIndex + d;
        const n = neighborByKey.get(anchorKey(a.versionId, idx));
        if (!n || seen.has(n.id)) continue;
        // Respect section boundaries: only include a neighbor sharing the anchor's
        // section (unless the anchor is section-less, where any neighbor is context).
        if (
          a.normalizedSectionIdentifier &&
          n.normalizedSectionIdentifier !== a.normalizedSectionIdentifier
        ) {
          continue;
        }
        seen.add(n.id);
        out.push({
          chunkId: n.id,
          documentId: n.documentId,
          versionId: n.versionId,
          chunkIndex: n.chunkIndex,
          content: n.content,
          distance: null,
          score: a.score, // sits alongside its anchor in rank
          exactMatch: false,
          sectionType: n.sectionType,
          sectionIdentifier: n.sectionIdentifier,
          normalizedSectionIdentifier: n.normalizedSectionIdentifier,
          sectionTitle: n.sectionTitle,
          headingPath: n.headingPath,
          pageStart: n.pageStart,
          pageEnd: n.pageEnd,
          adjacent: true,
        } as FusedChunk & { adjacent: boolean });
      }
    }
    return out;
  }

  /**
   * Attach document title/number, version number, and effective date, then
   * finalize the ranked chunks. Version-aware (Phase 4): a citation can name which
   * version and effective date answered, so a reader isn't left with an opaque UUID.
   */
  private async hydrateDocuments(rows: FusedChunk[]): Promise<RetrievedChunk[]> {
    const docIds = [...new Set(rows.map((r) => r.documentId))];
    const versionIds = [...new Set(rows.map((r) => r.versionId))];
    const [docs, versions] = await Promise.all([
      this.prisma.document.findMany({
        where: { id: { in: docIds } },
        select: { id: true, title: true, documentNumber: true, effectiveDate: true },
      }),
      this.prisma.documentVersion.findMany({
        where: { id: { in: versionIds } },
        select: { id: true, versionNumber: true },
      }),
    ]);
    const byId = new Map(docs.map((d) => [d.id, d]));
    const versionById = new Map(versions.map((v) => [v.id, v]));
    return rows.map((r) => {
      const doc = byId.get(r.documentId);
      const version = versionById.get(r.versionId);
      const adjacent = (r as FusedChunk & { adjacent?: boolean }).adjacent === true;
      return {
        documentId: r.documentId,
        versionId: r.versionId,
        chunkId: r.chunkId,
        chunkIndex: r.chunkIndex,
        content: r.content,
        // Cosine distance ∈ [0,2] maps to a [~-1,1] relevance where higher = closer,
        // when the chunk was found by the vector leg. An FTS/exact-only chunk has no
        // distance, so its (boosted) RRF fused score is exposed instead — still
        // "higher is more relevant", just not on the same numeric scale.
        score: r.distance !== null ? 1 - r.distance : r.score,
        documentTitle: doc?.title ?? '',
        documentNumber: doc?.documentNumber ?? null,
        versionNumber: version?.versionNumber ?? null,
        effectiveDate: doc?.effectiveDate ?? null,
        exactMatch: r.exactMatch,
        adjacent,
        sectionType: r.sectionType,
        sectionIdentifier: r.sectionIdentifier,
        normalizedSectionIdentifier: r.normalizedSectionIdentifier,
        sectionTitle: r.sectionTitle,
        headingPath: r.headingPath ?? [],
        pageStart: r.pageStart,
        pageEnd: r.pageEnd,
      };
    });
  }
}

/** Extract the structural fields from a leg row (normalizing headingPath to []). */
function structureOf(row: LegRow): RetrievedChunkStructure {
  return {
    sectionType: row.sectionType ?? null,
    sectionIdentifier: row.sectionIdentifier ?? null,
    normalizedSectionIdentifier: row.normalizedSectionIdentifier ?? null,
    sectionTitle: row.sectionTitle ?? null,
    headingPath: row.headingPath ?? [],
    pageStart: row.pageStart ?? null,
    pageEnd: row.pageEnd ?? null,
  };
}
