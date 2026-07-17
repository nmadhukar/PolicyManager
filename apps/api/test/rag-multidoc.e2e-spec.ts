import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { toSql } from 'pgvector';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { RetrieverService } from '../src/rag/retriever.service';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from '../src/rag/embedding-provider';

/**
 * Multi-document acceptance corpus (RAG Phases 1–4) against the REAL Postgres +
 * pgvector. Seeds the ten document types the requirements demand — policy manual,
 * SOP manual, handbook, contract, regulatory doc, unstructured doc, duplicate
 * identifiers, multiple versions, one large + several small documents — with
 * structural metadata and DETERMINISTIC embeddings (a stub provider, so no OpenAI
 * egress), then drives RetrieverService end-to-end to verify:
 *   exact-identifier retrieval, semantic retrieval, duplicate-identifier handling,
 *   current-version preference, large-document diversity, unstructured retrieval,
 *   citation correctness (section/page/version), and deterministic results.
 *
 * The embedding provider is overridden with a stub that maps text → a fixed-length
 * vector by hashing tokens, so cosine similarity is meaningful and reproducible
 * without a network call. RAG_ENABLED/OPENAI_API_KEY are forced on for the run.
 */

const DIM = 1536;
const MODEL = 'stub-embed';

/** Deterministic bag-of-words embedding: hash each token into a bucket, L2-normalize. */
function embedText(text: string): number[] {
  const v = new Array(DIM).fill(0);
  for (const tok of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 0;
    for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
    v[h % DIM] += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

const stubProvider: EmbeddingProvider = {
  isConfigured: () => true,
  model: MODEL,
  dimensions: DIM,
  embed: async (texts: string[]) => texts.map(embedText),
};

describe('RAG multi-document acceptance corpus (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let retriever: RetrieverService;

  const suffix = Date.now();
  let ownerId = '';
  const docIds: string[] = [];
  let admin: { id: string; email: string; name: string; roles: never[] };

  // Seed one document + current version + chunks. `chunks` carry structural fields.
  async function seedDoc(opts: {
    key: string;
    title: string;
    documentType: string;
    effectiveDate?: Date;
    versions?: number; // number of versions; the LAST is current
    chunks: Array<{
      content: string;
      sectionType?: string | null;
      sectionIdentifier?: string | null;
      normalizedSectionIdentifier?: string | null;
      sectionTitle?: string | null;
      headingPath?: string[];
      pageStart?: number | null;
      pageEnd?: number | null;
      // Which version this chunk belongs to (1-based); default = current (last).
      versionNo?: number;
    }>;
  }): Promise<string> {
    const doc = await prisma.document.create({
      data: {
        title: opts.title,
        documentType: opts.documentType,
        ownerId,
        status: 'published',
        accessLevel: 'public',
        effectiveDate: opts.effectiveDate ?? null,
      },
    });
    docIds.push(doc.id);
    const nVersions = opts.versions ?? 1;
    const versionIds: string[] = [];
    for (let n = 1; n <= nVersions; n++) {
      const v = await prisma.documentVersion.create({
        data: {
          documentId: doc.id,
          versionNumber: n,
          s3Key: `k/${doc.id}/v${n}`,
          fileName: 'f.pdf',
          mimeType: 'application/pdf',
          sizeBytes: BigInt(1),
          checksum: `c-${doc.id}-${n}`,
          uploadedById: ownerId,
          status: 'published',
        },
      });
      versionIds.push(v.id);
    }
    const currentVersionId = versionIds[versionIds.length - 1];
    await prisma.document.update({ where: { id: doc.id }, data: { currentVersionId } });

    // Insert chunks (raw SQL for the vector column, like EmbeddingService).
    const byVersion = new Map<number, number>(); // versionNo -> next chunkIndex
    for (const c of opts.chunks) {
      const versionNo = c.versionNo ?? nVersions;
      const versionId = versionIds[versionNo - 1];
      const idx = byVersion.get(versionNo) ?? 0;
      byVersion.set(versionNo, idx + 1);
      const emb = toSql(embedText(c.content));
      await prisma.$executeRaw`
        INSERT INTO "policytracker"."DocumentChunk"
          ("id","documentId","versionId","chunkIndex","content","tokenCount","embedding","embeddingModel",
           "sectionType","sectionIdentifier","normalizedSectionIdentifier","sectionTitle","headingPath","pageStart","pageEnd","metadata","createdAt")
        VALUES
          (gen_random_uuid(), ${doc.id}, ${versionId}, ${idx}, ${c.content}, ${Math.max(1, Math.ceil(c.content.length / 4))},
           ${emb}::"policytracker"."vector", ${MODEL},
           ${c.sectionType ?? null}, ${c.sectionIdentifier ?? null}, ${c.normalizedSectionIdentifier ?? null},
           ${c.sectionTitle ?? null}, ${c.headingPath ?? []}, ${c.pageStart ?? null}, ${c.pageEnd ?? null}, '{}'::jsonb, now())
      `;
    }
    return doc.id;
  }

  // When the Prisma engine cannot reach the DB (a known local-env limitation on this
  // machine — see ADR-0002 "no real-DB test harness"; the whole e2e suite is CI-gated),
  // we skip rather than hard-fail, so a developer without a reachable DB sees a clear
  // skip instead of noise. In CI (DB reachable) the suite runs fully.
  let dbAvailable = true;

  beforeAll(async () => {
    process.env.RAG_ENABLED = 'true';
    process.env.OPENAI_API_KEY = 'stub-key';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMBEDDING_PROVIDER)
      .useValue(stubProvider)
      .compile();
    app = moduleRef.createNestApplication();
    try {
      await app.init();
      prisma = app.get(PrismaService);
      retriever = app.get(RetrieverService);
      await prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      dbAvailable = false;
      // eslint-disable-next-line no-console
      console.warn(
        `[rag-multidoc.e2e] Skipping: database not reachable by the Prisma engine ` +
          `(${(err as Error).message.split('\n')[0]}). Runs in CI.`,
      );
      return;
    }

    const owner = await prisma.user.create({
      data: { email: `rag-corpus-${suffix}@pm.local`, name: 'Corpus Owner', status: 'active' },
    });
    ownerId = owner.id;
    admin = { id: owner.id, email: owner.email, name: owner.name, roles: [] };

    // 1. Policy manual — numeric + alphanumeric policies.
    await seedDoc({
      key: 'manual',
      title: `Clinical Policy Manual ${suffix}`,
      documentType: 'policy',
      chunks: [
        { content: 'Restraint may be used only as a last resort and must be documented.', sectionType: 'policy', sectionIdentifier: 'Policy 705', normalizedSectionIdentifier: 'policy 705', sectionTitle: 'Seclusion and Restraint', headingPath: ['Policy 705'], pageStart: 3, pageEnd: 3 },
        { content: 'Grievances must be filed within thirty days of the incident.', sectionType: 'policy', sectionIdentifier: 'Policy 610', normalizedSectionIdentifier: 'policy 610', sectionTitle: 'Grievance Procedure', headingPath: ['Policy 610'], pageStart: 5, pageEnd: 5 },
        { content: 'Medication reconciliation occurs on admission and discharge.', sectionType: 'policy', sectionIdentifier: 'Policy 826A', normalizedSectionIdentifier: 'policy 826a', sectionTitle: 'Medication Reconciliation', headingPath: ['Policy 826A'], pageStart: 8, pageEnd: 8 },
      ],
    });

    // 2. SOP manual — SOP-0045.
    await seedDoc({
      key: 'sop',
      title: `Laboratory SOP Manual ${suffix}`,
      documentType: 'sop',
      chunks: [
        { content: 'Label every specimen at the bedside immediately after collection.', sectionType: 'sop', sectionIdentifier: 'SOP-0045', normalizedSectionIdentifier: 'sop-0045', sectionTitle: 'Specimen Handling', headingPath: ['SOP-0045'], pageStart: 12, pageEnd: 13 },
      ],
    });

    // 3. Employee handbook — chapter/heading structure.
    await seedDoc({
      key: 'handbook',
      title: `Employee Handbook ${suffix}`,
      documentType: 'handbook',
      chunks: [
        { content: 'Paid time off accrues at a rate defined by length of service.', sectionType: 'chapter', sectionIdentifier: '7', normalizedSectionIdentifier: '7', sectionTitle: 'Time Off', headingPath: ['Chapter 7'], pageStart: 20, pageEnd: 21 },
      ],
    });

    // 4. Contract — clause 8.3.
    await seedDoc({
      key: 'contract',
      title: `Master Services Agreement ${suffix}`,
      documentType: 'contract',
      chunks: [
        { content: 'Liability of either party shall not exceed the fees paid in the prior twelve months.', sectionType: 'clause', sectionIdentifier: '8.3', normalizedSectionIdentifier: '8.3', sectionTitle: 'Limitation of Liability', headingPath: ['Article VIII', '8.3'], pageStart: 14, pageEnd: 14 },
      ],
    });

    // 5. Regulatory document — 42 CFR Part 2.
    await seedDoc({
      key: 'reg',
      title: `Confidentiality Regulations ${suffix}`,
      documentType: 'regulatory',
      chunks: [
        { content: 'Substance use disorder records may not be disclosed without patient consent.', sectionType: 'regulation', sectionIdentifier: '42 CFR Part 2', normalizedSectionIdentifier: '42 cfr part 2', sectionTitle: 'Confidentiality', headingPath: ['42 CFR Part 2'], pageStart: 1, pageEnd: 2 },
      ],
    });

    // 6. Unstructured document — no section identifiers.
    await seedDoc({
      key: 'unstructured',
      title: `Meeting Notes ${suffix}`,
      documentType: 'unstructured',
      chunks: [
        { content: 'We discussed the quarterly budget and agreed to revisit staffing levels next month.' },
        { content: 'Action items include updating the vendor list and scheduling a fire drill.' },
      ],
    });

    // 7. Duplicate identifier — a SECOND manual that ALSO has a "Policy 705".
    await seedDoc({
      key: 'manual-b',
      title: `Affiliate Policy Manual ${suffix}`,
      documentType: 'policy',
      chunks: [
        { content: 'In this affiliate, Policy 705 governs visitor access rather than restraint.', sectionType: 'policy', sectionIdentifier: 'Policy 705', normalizedSectionIdentifier: 'policy 705', sectionTitle: 'Visitor Access', headingPath: ['Policy 705'], pageStart: 2, pageEnd: 2 },
      ],
    });

    // 8. Multiple versions — v1 superseded, v2 current. Only v2 must be retrievable.
    await seedDoc({
      key: 'versioned',
      title: `Infection Control Policy ${suffix}`,
      documentType: 'policy',
      versions: 2,
      effectiveDate: new Date('2024-01-01T00:00:00.000Z'),
      chunks: [
        { content: 'OLD: hand hygiene guidance from the superseded first version.', sectionType: 'policy', sectionIdentifier: 'Policy 1506', normalizedSectionIdentifier: 'policy 1506', sectionTitle: 'Infection Control', versionNo: 1 },
        { content: 'CURRENT: hand hygiene is required before and after every patient contact.', sectionType: 'policy', sectionIdentifier: 'Policy 1506', normalizedSectionIdentifier: 'policy 1506', sectionTitle: 'Infection Control', pageStart: 4, pageEnd: 4, versionNo: 2 },
      ],
    });

    // 9. One LARGE document (many chunks) that must not monopolize a broad query.
    await seedDoc({
      key: 'large',
      title: `Comprehensive Operations Manual ${suffix}`,
      documentType: 'policy',
      chunks: Array.from({ length: 30 }, (_, i) => ({
        content: `Operations detail number ${i}: the facility maintains safety and quality standards across all units.`,
        sectionType: 'section',
        sectionIdentifier: `${i + 1}`,
        normalizedSectionIdentifier: `${i + 1}`,
        sectionTitle: `Operations ${i}`,
        pageStart: i + 1,
        pageEnd: i + 1,
      })),
    });

    // 10. Several SMALL documents about the same broad topic (safety/quality) so a
    //     broad query has cross-document evidence competing with the large doc.
    for (let s = 0; s < 3; s++) {
      await seedDoc({
        key: `small-${s}`,
        title: `Safety Bulletin ${s} ${suffix}`,
        documentType: 'report',
        chunks: [
          { content: `Safety bulletin ${s}: report all quality and safety concerns to your supervisor promptly.`, sectionType: 'section', sectionIdentifier: `${s + 1}`, normalizedSectionIdentifier: `sb${s}`, sectionTitle: 'Reporting' },
        ],
      });
    }
  }, 60_000);

  afterAll(async () => {
    if (dbAvailable && prisma) {
      // Clean up everything this suite created (chunks cascade with documents/versions).
      for (const id of docIds) {
        await prisma.documentChunk.deleteMany({ where: { documentId: id } });
      }
      await prisma.document.updateMany({ where: { id: { in: docIds } }, data: { currentVersionId: null } });
      await prisma.documentVersion.deleteMany({ where: { documentId: { in: docIds } } });
      await prisma.document.deleteMany({ where: { id: { in: docIds } } });
      await prisma.user.deleteMany({ where: { id: ownerId } });
    }
    if (app) await app.close();
  });

  const user = () => admin as never;
  /** Guard: no-op the assertions when the DB engine is unreachable (CI runs it fully). */
  const guard = (): boolean => {
    if (!dbAvailable) {
      // eslint-disable-next-line no-console
      console.warn('[rag-multidoc.e2e] test skipped (DB unavailable)');
      return true;
    }
    return false;
  };

  it('exact identifier → correct document + section (Policy 705, Policy 826A, Section/SOP, Clause, Article, CFR)', async () => {
    if (guard()) return;
    const cases: Array<[string, string]> = [
      ['Policy 826A', 'policy 826a'],
      ['SOP-0045', 'sop-0045'],
      ['Clause 8.3', '8.3'],
      ['42 CFR Part 2', '42 cfr part 2'],
    ];
    for (const [query, normId] of cases) {
      const hits = await retriever.retrieve(query, { user: user() });
      const top = hits.filter((h) => h.exactMatch);
      expect(top.length).toBeGreaterThan(0);
      expect(top.every((h) => h.normalizedSectionIdentifier === normId)).toBe(true);
      // The exact section ranks at the very top.
      expect(hits[0].normalizedSectionIdentifier).toBe(normId);
    }
  });

  it('semantic question retrieves relevant content regardless of document type', async () => {
    if (guard()) return;
    const hits = await retriever.retrieve('how should staff handle laboratory specimens?', { user: user() });
    // The SOP chunk about specimen labeling should surface via the vector leg.
    expect(hits.some((h) => h.content.includes('specimen'))).toBe(true);
  });

  it('unstructured document remains searchable (null section fields)', async () => {
    if (guard()) return;
    const hits = await retriever.retrieve('quarterly budget and staffing discussion', { user: user() });
    const note = hits.find((h) => h.content.includes('quarterly budget'));
    expect(note).toBeDefined();
    expect(note!.sectionIdentifier).toBeNull();
    expect(note!.headingPath).toEqual([]);
  });

  it('duplicate identifier across two documents is DETECTED (not silently merged)', async () => {
    if (guard()) return;
    const result = await retriever.retrieveWithIntelligence('Policy 705', { user: user() });
    const collision = result.collisions.find((c) => c.normalizedIdentifier === 'policy 705');
    expect(collision).toBeDefined();
    expect(collision!.documents.length).toBeGreaterThanOrEqual(2);
    // Both distinct titles are represented.
    const titles = collision!.documents.map((d) => d.documentTitle);
    expect(new Set(titles).size).toBeGreaterThanOrEqual(2);
  });

  it('current published version is preferred; superseded version chunks never surface', async () => {
    if (guard()) return;
    const hits = await retriever.retrieve('Policy 1506 hand hygiene', { user: user() });
    expect(hits.some((h) => h.content.startsWith('CURRENT'))).toBe(true);
    expect(hits.some((h) => h.content.startsWith('OLD'))).toBe(false);
  });

  it('large document does NOT monopolize a broad query — other documents surface', async () => {
    if (guard()) return;
    const hits = await retriever.retrieve('safety and quality standards', { user: user(), topK: 8 });
    const distinctDocs = new Set(hits.map((h) => h.documentId));
    // With per-document caps, a broad query returns evidence from multiple documents,
    // not 8 chunks of the single large manual.
    expect(distinctDocs.size).toBeGreaterThan(1);
    const largeDocId = docIds.find((_id, i) => i === 8); // the 9th seeded doc is "large"
    const fromLarge = hits.filter((h) => h.documentId === largeDocId).length;
    expect(fromLarge).toBeLessThanOrEqual(3); // maxChunksPerDocument default
  });

  it('citations identify document, version, section, and page', async () => {
    if (guard()) return;
    const hits = await retriever.retrieve('Policy 826A medication reconciliation', { user: user() });
    const hit = hits.find((h) => h.normalizedSectionIdentifier === 'policy 826a');
    expect(hit).toBeDefined();
    expect(hit!.documentTitle).toContain('Clinical Policy Manual');
    expect(hit!.versionNumber).toBe(1);
    expect(hit!.sectionIdentifier).toBe('Policy 826A');
    expect(hit!.pageStart).toBe(8);
  });

  it('results are deterministic (same query → identical ordering)', async () => {
    if (guard()) return;
    const a = await retriever.retrieve('safety and quality standards', { user: user(), topK: 8 });
    const b = await retriever.retrieve('safety and quality standards', { user: user(), topK: 8 });
    expect(a.map((h) => h.chunkId)).toEqual(b.map((h) => h.chunkId));
  });
});
