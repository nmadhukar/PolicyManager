import type { AuthUser } from '@policymanager/shared';
import type { UploadedFile } from '../documents/documents.service';
import { ImportsService } from './imports.service';

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
  const makePrisma = (): any => ({
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
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(({ data }: { data: { name: string } }) =>
        Promise.resolve({ id: `cat-${data.name}` }),
      ),
    },
    user: { findFirst: jest.fn().mockResolvedValue(null) },
  });

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

  it('resolves each category once and reuses it across rows (idempotent, no dupes)', async () => {
    const { svc, prisma } = build();
    const csv =
      'title,fileName,category\n' +
      'Doc One,a.pdf,Policies/Clinical\n' +
      'Doc Two,b.pdf,Policies/Clinical\n';
    await svc.runManifestImport(manifest(csv), [file('a.pdf'), file('b.pdf')], importer);

    // Two segments (Policies, Clinical) created exactly once despite two rows.
    expect(prisma.documentCategory.create).toHaveBeenCalledTimes(2);
    const createdNames = prisma.documentCategory.create.mock.calls.map(
      (c: [{ data: { name: string } }]) => c[0].data.name,
    );
    expect(createdNames).toEqual(['Policies', 'Clinical']);
  });

  it('resolves owner by email (transfers ownership); unknown owner defaults to importer', async () => {
    const prisma = makePrisma();
    prisma.user.findFirst.mockImplementation(({ where }: { where: { email: { equals: string } } }) =>
      Promise.resolve(where.email.equals === 'jane@x.org' ? { id: 'owner-9' } : null),
    );
    const { svc } = build(prisma);

    const csv =
      'title,documentNumber,owner\n' +
      'Owned,PP-A,jane@x.org\n' +
      'Unowned,PP-B,ghost@x.org\n';
    await svc.runManifestImport(manifest(csv), [], importer);

    // Ownership transferred for the known owner only.
    expect(prisma.document.update).toHaveBeenCalledTimes(1);
    expect(prisma.document.update.mock.calls[0][0].data).toEqual({ ownerId: 'owner-9' });
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
});
