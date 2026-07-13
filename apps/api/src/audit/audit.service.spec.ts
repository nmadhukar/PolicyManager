import { AuditService } from './audit.service';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makePrisma = (): any => {
  const prisma: any = {
    auditEvent: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    $transaction: jest.fn((arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => unknown)(prisma)
        : Promise.all(arg as unknown[]),
    ),
  };
  return prisma;
};

const build = (p = makePrisma()) => ({
  prisma: p,
  svc: new AuditService(p as never),
});

describe('AuditService.record (resilient writer)', () => {
  it('writes an event with defaults (source=web) and returns the new id', async () => {
    const { svc, prisma } = build();
    prisma.auditEvent.create.mockResolvedValue({ id: 'ae-1' });

    const id = await svc.record({
      action: 'document.viewed',
      actorUserId: 'u-1',
      documentId: 'doc-1',
      versionId: 'v-1',
      ipAddress: '10.0.0.1',
      userAgent: 'jest',
    });

    expect(id).toBe('ae-1');
    const data = prisma.auditEvent.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      action: 'document.viewed',
      actorUserId: 'u-1',
      documentId: 'doc-1',
      versionId: 'v-1',
      source: 'web',
      ipAddress: '10.0.0.1',
      userAgent: 'jest',
    });
  });

  it('honors an explicit source and serializes metadata', async () => {
    const { svc, prisma } = build();
    prisma.auditEvent.create.mockResolvedValue({ id: 'ae-2' });

    await svc.record({
      action: 'document.edited',
      source: 'system',
      metadata: { from: 'v1', to: 'v2' },
    });

    const data = prisma.auditEvent.create.mock.calls[0][0].data;
    expect(data.source).toBe('system');
    expect(data.metadata).toEqual({ from: 'v1', to: 'v2' });
  });

  it('NEVER throws into the caller when the DB write fails (returns null, logs)', async () => {
    const { svc, prisma } = build();
    prisma.auditEvent.create.mockRejectedValue(new Error('db down'));

    // The whole point: an audit outage must not break the request path.
    await expect(svc.record({ action: 'document.downloaded' })).resolves.toBeNull();
  });

  it('omits metadata entirely when not provided (no JSON null quirk)', async () => {
    const { svc, prisma } = build();
    prisma.auditEvent.create.mockResolvedValue({ id: 'ae-3' });
    await svc.record({ action: 'user.login', actorUserId: 'u-9' });
    const data = prisma.auditEvent.create.mock.calls[0][0].data;
    expect(data.metadata).toBeUndefined();
  });
});

describe('AuditService.query (filters + pagination + mapping)', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'ae-1',
    action: 'document.downloaded',
    source: 'web',
    targetType: 'version',
    documentId: 'doc-1',
    versionId: 'v-1',
    actorUserId: 'u-1',
    ipAddress: '10.0.0.1',
    userAgent: 'jest',
    metadata: { k: 'v' },
    createdAt: new Date('2026-02-01T00:00:00Z'),
    actor: { name: 'Ada', email: 'ada@x.com' },
    document: { title: 'Policy', documentNumber: 'PP-1' },
    ...over,
  });

  it('applies actor/document/action/source + date-range filters and maps rows', async () => {
    const { svc, prisma } = build();
    prisma.auditEvent.findMany.mockResolvedValue([row()]);
    prisma.auditEvent.count.mockResolvedValue(1);

    const result = await svc.query({
      actorUserId: 'u-1',
      documentId: 'doc-1',
      action: 'document.downloaded',
      source: 'web',
      from: '2026-01-01',
      to: '2026-03-01',
      page: 2,
      pageSize: 10,
    });

    const args = prisma.auditEvent.findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({
      actorUserId: 'u-1',
      documentId: 'doc-1',
      action: 'document.downloaded',
      source: 'web',
    });
    expect(args.where.createdAt.gte).toBeInstanceOf(Date);
    expect(args.where.createdAt.lte).toBeInstanceOf(Date);
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
    expect(args.skip).toBe(10); // (page 2 - 1) * 10
    expect(args.take).toBe(10);

    expect(result).toMatchObject({ total: 1, page: 2, pageSize: 10 });
    const item = result.items[0];
    expect(item).toMatchObject({
      actorName: 'Ada',
      actorEmail: 'ada@x.com',
      documentTitle: 'Policy',
      documentNumber: 'PP-1',
      metadata: { k: 'v' },
    });
    expect(item.createdAt).toBe('2026-02-01T00:00:00.000Z');
  });

  it('defaults page/pageSize and omits an empty date range', async () => {
    const { svc, prisma } = build();
    prisma.auditEvent.findMany.mockResolvedValue([]);
    prisma.auditEvent.count.mockResolvedValue(0);

    const result = await svc.query({});

    const args = prisma.auditEvent.findMany.mock.calls[0][0];
    expect(args.where.createdAt).toBeUndefined();
    expect(args.skip).toBe(0);
    expect(args.take).toBe(25); // default page size
    expect(result.page).toBe(1);
  });

  it('coerces null metadata / arrays to null in the mapped item', async () => {
    const { svc, prisma } = build();
    prisma.auditEvent.findMany.mockResolvedValue([
      row({ metadata: null, actor: null, document: null }),
    ]);
    prisma.auditEvent.count.mockResolvedValue(1);

    const result = await svc.query({});
    expect(result.items[0].metadata).toBeNull();
    expect(result.items[0].actorName).toBeNull();
    expect(result.items[0].documentTitle).toBeNull();
  });
});
