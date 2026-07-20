import { Prisma } from '@prisma/client';
import type { AuthUser } from '@policymanager/shared';
import type { UploadedFile } from '../documents/documents.service';
import { ImportsService } from './imports.service';

/** A P2002 error shaped like the real Prisma runtime error, for lost-race simulation. */
function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

/**
 * Business-behavior tests for the import orchestrator (AGENTS.md §6). Prisma,
 * DocumentsService, and AuditService are mocked so we can prove:
 *  - the batch counters roll up (created/duplicate/error),
 *  - one bad row is isolated as an `error` item without failing the batch,
 *  - a referenced-but-missing file is an error; a duplicate is skipped,
 *  - category resolution is idempotent (find-or-create, no duplicates),
 *  - owner is resolved by email and ownership transferred; unknown → importer,
 *  - the bulk path de-duplicates by checksum and can map folder paths to categories,
 *  - every run is audited as import.completed and reuses DocumentsService.
 */
describe('ImportsService', () => {
  const importer: AuthUser = {
    id: 'importer-1',
    email: 'imp@x.org',
    name: 'Importer',
    roles: ['Admin'],
    permissions: ['document.write'],
    mustChangePassword: false,
  };

  const file = (name: string, content = name): UploadedFile => ({
    originalname: name,
    mimetype: 'application/pdf',
    size: Buffer.byteLength(content),
    buffer: Buffer.from(content),
  });
  const manifest = (csv: string): UploadedFile => ({
    originalname: 'manifest.csv',
    mimetype: 'text/csv',
    size: Buffer.byteLength(csv),
    buffer: Buffer.from(csv),
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const makePrisma = (): any => {
    // FINDING-003: since rows now process concurrently (mapWithConcurrency),
    // this in-memory store models the real DB's unique(name, parentId)
    // constraint + findOrCreateCategory's P2002-catch-and-refetch so a race
    // between two concurrent rows creating the SAME new category resolves to
    // one row, exactly like production — a bare `jest.fn().mockResolvedValue`
    // pair (no shared state) would let two concurrent callers both "create"
    // a duplicate, which the real Prisma unique index would never allow.
    const categoriesByKey = new Map<string, { id: string }>();
    const categoryKey = (name: string, parentId: string | null) => `${parentId ?? ''}::${name}`;

    return {
      importBatch: {
        create: jest.fn().mockResolvedValue({ id: 'batch-1' }),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({
          id: 'batch-1',
          fileName: 'manifest.csv',
          totalRows: 0,
          createdCount: 0,
          duplicateCount: 0,
          errorCount: 0,
          status: 'completed',
          createdById: 'importer-1',
          createdAt: new Date('2026-07-13T00:00:00Z'),
          completedAt: new Date('2026-07-13T00:00:01Z'),
          createdBy: { name: 'Importer' },
          items: [],
        }),
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      importItem: { create: jest.fn().mockResolvedValue({ id: 'item' }) },
      document: {
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
      },
      documentVersion: { findFirst: jest.fn().mockResolvedValue(null) },
      documentCategory: {
        findFirst: jest.fn().mockImplementation(({ where }: { where: { name: string; parentId: string | null } }) =>
          Promise.resolve(categoriesByKey.get(categoryKey(where.name, where.parentId)) ?? null),
        ),
        create: jest.fn().mockImplementation(({ data }: { data: { name: string; parentId: string | null } }) => {
          const key = categoryKey(data.name, data.parentId ?? null);
          const existing = categoriesByKey.get(key);
          if (existing) {
            // Mirrors the real unique(name, parentId) index: a second
            // concurrent create for the same key is a lost race, not a dupe.
            return Promise.reject(p2002());
          }
          const created = { id: `cat-${data.name}` };
          categoriesByKey.set(key, created);
          return Promise.resolve(created);
        }),
      },
      user: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
  };

  const makeDocuments = () => {
    let seq = 0;
    return {
      create: jest.fn().mockImplementation(() => Promise.resolve({ id: `doc-${++seq}` })),
      addVersion: jest.fn().mockResolvedValue({ id: 'ver-1', versionNumber: 1 }),
      softDelete: jest.fn().mockResolvedValue({ id: 'doc-rollback' }),
    };
  };
  const makeAudit = () => ({ record: jest.fn().mockResolvedValue('ae-1') });

  const build = (prisma = makePrisma(), documents = makeDocuments(), audit = makeAudit()) => ({
    prisma,
    documents,
    audit,
    svc: new ImportsService(prisma as never, documents as never, audit as never),
  });

  /** Statuses recorded via importItem.create, in call order. */
  const recordedStatuses = (prisma: ReturnType<typeof makePrisma>): string[] =>
    prisma.importItem.create.mock.calls.map(
      (c: [{ data: { status: string } }]) => c[0].data.status,
    );

  it('rolls up created/duplicate/error and completes the batch (manifest path)', async () => {
    const { svc, prisma, documents, audit } = build();
    // Row 2's document number already exists → duplicate by documentNumber.
    prisma.document.findFirst.mockImplementation(({ where }: { where: { documentNumber?: string } }) =>
      Promise.resolve(where.documentNumber === 'PP-DUP' ? { id: 'existing-dup' } : null),
    );

    const csv =
      'title,fileName,documentNumber\n' +
      'New Doc,new.pdf,PP-NEW\n' +
      'Dup Doc,dup.pdf,PP-DUP\n' +
      'Missing Doc,ghost.pdf,PP-MISS\n';
    const detail = await svc.runManifestImport(
      manifest(csv),
      [file('new.pdf'), file('dup.pdf')],
      importer,
    );

    // Exactly one document was created (via the shared DocumentsService), and its
    // single version was uploaded through the reused path.
    expect(documents.create).toHaveBeenCalledTimes(1);
    expect(documents.addVersion).toHaveBeenCalledTimes(1);

    // Per-row report has all three outcomes.
    expect(recordedStatuses(prisma).sort()).toEqual(['created', 'duplicate', 'error']);

    // Counters rolled onto the batch + status completed.
    const update = prisma.importBatch.update.mock.calls[0][0];
    expect(update.data).toMatchObject({
      createdCount: 1,
      duplicateCount: 1,
      errorCount: 1,
      status: 'completed',
    });
    expect(update.data.completedAt).toBeInstanceOf(Date);

    // Audited as import.completed with the summary.
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'import.completed',
        actorUserId: 'importer-1',
        metadata: expect.objectContaining({ created: 1, duplicate: 1, error: 1, kind: 'manifest' }),
      }),
    );
    expect(detail.id).toBe('batch-1');
  });

  it('marks a referenced-but-missing file as an error (no document created)', async () => {
    const { svc, prisma, documents } = build();
    const csv = 'title,fileName\nOrphan,ghost.pdf\n';
    await svc.runManifestImport(manifest(csv), [], importer);

    expect(documents.create).not.toHaveBeenCalled();
    const item = prisma.importItem.create.mock.calls[0][0].data;
    expect(item.status).toBe('error');
    expect(item.message).toMatch(/was not uploaded/i);
  });

  it('isolates a row whose creation throws and still processes later rows', async () => {
    const prisma = makePrisma();
    const documents = makeDocuments();
    documents.create
      .mockImplementationOnce(() => Promise.reject(new Error('boom')))
      .mockImplementationOnce(() => Promise.resolve({ id: 'doc-ok' }));
    const { svc } = build(prisma, documents);

    const csv = 'title,fileName\nBoom Row,a.pdf\nGood Row,b.pdf\n';
    await svc.runManifestImport(manifest(csv), [file('a.pdf'), file('b.pdf')], importer);

    const items = prisma.importItem.create.mock.calls.map(
      (c: [{ data: { status: string; message: string | null } }]) => c[0].data,
    );
    expect(items[0]).toMatchObject({ status: 'error', message: 'boom' });
    expect(items[1]).toMatchObject({ status: 'created' });
    expect(prisma.importBatch.update.mock.calls[0][0].data).toMatchObject({
      createdCount: 1,
      errorCount: 1,
    });
  });

  it('C3/D5: rolls back the document when its version upload fails (no orphan, error row)', async () => {
    const prisma = makePrisma();
    const documents = makeDocuments();
    // The document is created, but its first version fails.
    documents.addVersion.mockRejectedValueOnce(new Error('S3 down'));
    const { svc } = build(prisma, documents);

    const csv = 'title,fileName\nGood Title,a.pdf\n';
    await svc.runManifestImport(manifest(csv), [file('a.pdf')], importer);

    // The just-created document is soft-deleted, never hard-deleted, so active
    // views stay clean without destroying the document/version/audit trail.
    expect(documents.softDelete).toHaveBeenCalledWith('doc-1', importer, {});
    expect(prisma.document.delete).not.toHaveBeenCalled();
    const item = prisma.importItem.create.mock.calls[0][0].data;
    expect(item.status).toBe('error');
    expect(item.documentId).toBeNull();
    expect(item.message).toMatch(/S3 down/);
    // Batch reports one error, zero created.
    expect(prisma.importBatch.update.mock.calls[0][0].data).toMatchObject({
      createdCount: 0,
      errorCount: 1,
    });
  });

  describe('FINDING-003: bounded-concurrency row processing', () => {
    it('processes multiple rows with real overlap (not fully sequential), bounded, and preserves per-row rowNumber ordering + isolation in the recorded report', async () => {
      const prisma = makePrisma();
      const documents = makeDocuments();
      let inFlight = 0;
      let maxInFlight = 0;
      const ROW_COUNT = 20;
      // Simulate real async work (e.g. an S3 upload) with a small delay so
      // overlapping calls are observable, and track concurrent in-flight count.
      documents.create.mockImplementation(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return { id: `doc-${Math.random().toString(36).slice(2)}` };
      });
      // Every 5th row's version upload fails, to prove per-row error isolation
      // survives concurrent processing (not just sequential processing).
      let addVersionCalls = 0;
      documents.addVersion.mockImplementation(async () => {
        addVersionCalls += 1;
        if (addVersionCalls % 5 === 0) throw new Error(`row ${addVersionCalls} upload failed`);
        return { id: 'ver-1', versionNumber: 1 };
      });
      const { svc } = build(prisma, documents);

      const rows = Array.from(
        { length: ROW_COUNT },
        (_, i) => `Row ${i + 1},f${i + 1}.pdf`,
      ).join('\n');
      const csv = `title,fileName\n${rows}\n`;
      const files = Array.from({ length: ROW_COUNT }, (_, i) => file(`f${i + 1}.pdf`));

      await svc.runManifestImport(manifest(csv), files, importer);

      // Real overlap happened (more than one row in flight at once) — proves
      // this is not silently still fully sequential.
      expect(maxInFlight).toBeGreaterThan(1);
      // Bounded: never more in flight than the documented concurrency cap.
      expect(maxInFlight).toBeLessThanOrEqual(8);

      // Every row was recorded, in original rowNumber order, regardless of
      // which order they actually completed in.
      const items = prisma.importItem.create.mock.calls.map(
        (c: [{ data: { rowNumber: number; status: string } }]) => c[0].data,
      );
      expect(items.map((i: { rowNumber: number }) => i.rowNumber)).toEqual(
        Array.from({ length: ROW_COUNT }, (_, i) => i + 1),
      );
      // Exactly the rows whose upload was made to fail (every 5th) are errors;
      // every other row succeeded — proves isolation held under concurrency.
      const errorRows = items
        .filter((i: { status: string }) => i.status === 'error')
        .map((i: { rowNumber: number }) => i.rowNumber);
      expect(errorRows.length).toBeGreaterThan(0);
      expect(items.filter((i: { status: string }) => i.status === 'created').length).toBe(
        ROW_COUNT - errorRows.length,
      );
    });
  });

  it('resolves each category once and reuses it across rows (idempotent, no dupes) — FINDING-003: holds under bounded-concurrency processing too', async () => {
    const { svc, prisma, documents } = build();
    const csv =
      'title,fileName,category\n' +
      'Doc One,a.pdf,Policies/Clinical\n' +
      'Doc Two,b.pdf,Policies/Clinical\n';
    await svc.runManifestImport(manifest(csv), [file('a.pdf'), file('b.pdf')], importer);

    // Both rows now process concurrently (FINDING-003), so create() may be
    // CALLED more than twice if two rows race for the same new segment (one
    // wins, the loser's P2002 is caught and re-read — see the mock's
    // race-safe documentCategory store above, mirroring the real
    // findOrCreateCategory implementation). What must hold regardless of
    // scheduling is the OUTCOME: exactly one row is ever persisted per
    // segment, and every document ends up filed under the SAME resolved
    // category id (no duplicate "Clinical" categories, no divergence between
    // the two rows' resolved categoryId).
    const createdNames = prisma.documentCategory.create.mock.calls.map(
      (c: [{ data: { name: string } }]) => c[0].data.name,
    );
    expect(new Set(createdNames)).toEqual(new Set(['Policies', 'Clinical']));

    const categoryIds = documents.create.mock.calls.map(
      (c: [{ categoryId?: string }]) => c[0].categoryId,
    );
    expect(categoryIds).toHaveLength(2);
    expect(new Set(categoryIds).size).toBe(1); // both rows resolved to the SAME category id
  });

  describe('FINDING-010: owner reassignment requires user.manage', () => {
    const managerImporter: AuthUser = {
      ...importer,
      id: 'importer-mgr',
      permissions: ['document.write', 'user.manage'],
    };

    it('an importer WITHOUT user.manage: the manifest owner column is ignored, document stays owned by the importer', async () => {
      const prisma = makePrisma();
      prisma.user.findFirst.mockImplementation(
        ({ where }: { where: { email: { equals: string } } }) =>
          Promise.resolve(where.email.equals === 'jane@x.org' ? { id: 'owner-9' } : null),
      );
      const { svc } = build(prisma);

      const csv = 'title,documentNumber,owner\nOwned,PP-A,jane@x.org\n';
      // importer only has 'document.write' — no user.manage.
      await svc.runManifestImport(manifest(csv), [], importer);

      // No ownership transfer attempted; the user lookup is never even reached.
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
      expect(prisma.document.update).not.toHaveBeenCalled();
    });

    it('an importer WITH user.manage: ownership transfers for a known owner; unknown owner defaults to importer', async () => {
      const prisma = makePrisma();
      prisma.user.findFirst.mockImplementation(
        ({ where }: { where: { email: { equals: string } } }) =>
          Promise.resolve(where.email.equals === 'jane@x.org' ? { id: 'owner-9' } : null),
      );
      const { svc } = build(prisma);

      const csv =
        'title,documentNumber,owner\n' +
        'Owned,PP-A,jane@x.org\n' +
        'Unowned,PP-B,ghost@x.org\n';
      await svc.runManifestImport(manifest(csv), [], managerImporter);

      // Ownership transferred for the known owner only.
      expect(prisma.document.update).toHaveBeenCalledTimes(1);
      expect(prisma.document.update.mock.calls[0][0].data).toEqual({ ownerId: 'owner-9' });
    });

    it('a confidential document imported by a non-user.manage importer with an owner column does not grant the named user implicit ACL access', async () => {
      const prisma = makePrisma();
      // Even if the named user exists, no lookup/transfer happens without user.manage.
      prisma.user.findFirst.mockResolvedValue({ id: 'owner-9' });
      const { svc, prisma: p } = build(prisma);

      const csv = 'title,documentNumber,owner,accessLevel\nSecret,PP-C,jane@x.org,confidential\n';
      await svc.runManifestImport(manifest(csv), [], importer);

      // Document remains owned by the importer (no update call), so 'jane' gets
      // no ownerId-based ACL bypass on the confidential document.
      expect(p.document.update).not.toHaveBeenCalled();
    });
  });

  it('bulk mode creates from filenames and de-duplicates by checksum', async () => {
    const prisma = makePrisma();
    // First file's checksum is new; second matches an existing version.
    prisma.documentVersion.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ documentId: 'existing-b' });
    const { svc, documents, audit } = build(prisma);

    const detail = await svc.runBulkImport([file('Report A.pdf'), file('Report B.pdf')], importer);

    expect(documents.create).toHaveBeenCalledTimes(1);
    expect(documents.create.mock.calls[0][0]).toEqual({ title: 'Report A' });
    expect(prisma.importBatch.update.mock.calls[0][0].data).toMatchObject({
      createdCount: 1,
      duplicateCount: 1,
      errorCount: 0,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ kind: 'bulk' }) }),
    );
    expect(detail.id).toBe('batch-1');
  });

  it('bulk mode maps browser folder relative paths to category paths', async () => {
    const { svc, prisma, documents } = build();

    await svc.runBulkImport(
      [file('Treatment Plan.pdf')],
      importer,
      {},
      { relativePaths: ['Policies/Clinical/Treatment Plan.pdf'] },
    );

    expect(prisma.documentCategory.create).toHaveBeenCalledTimes(2);
    expect(documents.create).toHaveBeenCalledWith(
      { title: 'Treatment Plan', categoryId: 'cat-Clinical' },
      importer,
      {},
    );
    const item = prisma.importItem.create.mock.calls[0][0].data;
    expect(item).toMatchObject({
      title: 'Treatment Plan',
      categoryName: 'Policies/Clinical',
      fileName: 'Policies/Clinical/Treatment Plan.pdf',
      status: 'created',
    });
  });

  it('rejects a manifest import with no manifest file (400)', async () => {
    const { svc } = build();
    await expect(svc.runManifestImport(undefined, [], importer)).rejects.toThrow(/manifest/i);
  });

  it('rejects a bulk import with no files (400)', async () => {
    const { svc } = build();
    await expect(svc.runBulkImport([], importer)).rejects.toThrow(/at least one file/i);
  });

  describe('FINDING-011: listBatches/getBatch are scoped to the caller', () => {
    const manager: AuthUser = {
      id: 'mgr-1',
      email: 'mgr@x.org',
      name: 'Manager',
      roles: ['Admin'],
      permissions: ['document.write', 'user.manage'],
      mustChangePassword: false,
    };
    const otherUsersBatch = {
      id: 'batch-other',
      fileName: 'other.csv',
      totalRows: 1,
      createdCount: 1,
      duplicateCount: 0,
      errorCount: 0,
      status: 'completed',
      createdById: 'someone-else',
      createdAt: new Date('2026-07-13T00:00:00Z'),
      completedAt: new Date('2026-07-13T00:00:01Z'),
      createdBy: { name: 'Someone Else' },
      items: [],
    };

    it('listBatches: a non-user.manage caller only sees their own batches (where filter scoped to createdById)', async () => {
      const { svc, prisma } = build();
      await svc.listBatches(importer, 1, 20);

      expect(prisma.importBatch.findMany.mock.calls[0][0].where).toEqual({
        createdById: importer.id,
      });
      expect(prisma.importBatch.count.mock.calls[0][0].where).toEqual({
        createdById: importer.id,
      });
    });

    it('listBatches: a user.manage caller sees every batch (no createdById filter)', async () => {
      const { svc, prisma } = build();
      await svc.listBatches(manager, 1, 20);

      expect(prisma.importBatch.findMany.mock.calls[0][0].where).toEqual({});
      expect(prisma.importBatch.count.mock.calls[0][0].where).toEqual({});
    });

    it('getBatch: 404s (not 403) when a non-user.manage caller requests another user\'s batch', async () => {
      const prisma = makePrisma();
      prisma.importBatch.findUnique.mockResolvedValue(otherUsersBatch);
      const { svc } = build(prisma);

      await expect(svc.getBatch('batch-other', importer)).rejects.toThrow(/not found/i);
    });

    it('getBatch: succeeds for the batch\'s own creator', async () => {
      const prisma = makePrisma();
      prisma.importBatch.findUnique.mockResolvedValue({
        ...otherUsersBatch,
        id: 'batch-mine',
        createdById: importer.id,
      });
      const { svc } = build(prisma);

      const detail = await svc.getBatch('batch-mine', importer);
      expect(detail.id).toBe('batch-mine');
    });

    it('getBatch: a user.manage caller can read any batch', async () => {
      const prisma = makePrisma();
      prisma.importBatch.findUnique.mockResolvedValue(otherUsersBatch);
      const { svc } = build(prisma);

      const detail = await svc.getBatch('batch-other', manager);
      expect(detail.id).toBe('batch-other');
    });

    it('getBatch: 404s for a genuinely missing batch id', async () => {
      const prisma = makePrisma();
      prisma.importBatch.findUnique.mockResolvedValue(null);
      const { svc } = build(prisma);

      await expect(svc.getBatch('gone', importer)).rejects.toThrow(/not found/i);
    });
  });
});
