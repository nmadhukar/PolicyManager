import { ForbiddenException } from '@nestjs/common';
import type { AuthUser } from '@policymanager/shared';
import { DocumentAnnotationsService } from './document-annotations.service';

const doc = { id: 'doc-1', ownerId: 'owner-1', accessLevel: 'restricted', categoryId: null };

const user = (over: Partial<AuthUser> = {}): AuthUser => ({
  id: 'u-1',
  email: 'u@example.com',
  name: 'User',
  roles: ['Manager'],
  permissions: ['document.read', 'document.comment'],
  mustChangePassword: false,
  ...over,
});

const annotationRow = (over: Record<string, unknown> = {}) => ({
  id: 'ann-1',
  documentId: 'doc-1',
  versionId: 'v-1',
  authorId: 'u-1',
  type: 'comment',
  status: 'open',
  pageNumber: 1,
  x: 0.1,
  y: 0.1,
  width: 0.2,
  height: 0.1,
  body: 'Please clarify.',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  resolvedAt: null,
  resolvedById: null,
  deletedAt: null,
  author: { name: 'User' },
  resolvedBy: null,
  ...over,
});

describe('DocumentAnnotationsService', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const makePrisma = (): any => ({
    documentVersion: {
      findFirst: jest.fn().mockResolvedValue({ id: 'v-1', document: doc }),
    },
    documentAnnotation: {
      findMany: jest.fn().mockResolvedValue([annotationRow()]),
      findFirst: jest.fn().mockResolvedValue({ ...annotationRow(), document: doc }),
      create: jest.fn().mockResolvedValue(annotationRow()),
      update: jest.fn().mockResolvedValue(annotationRow({ status: 'resolved', resolvedBy: { name: 'User' } })),
      count: jest.fn().mockResolvedValue(1),
    },
    reviewAssignment: { count: jest.fn().mockResolvedValue(0) },
    reviewTask: { count: jest.fn().mockResolvedValue(0) },
  });
  const makeAccess = () => ({ canAccess: jest.fn().mockResolvedValue(true) });
  const makeAudit = () => ({ record: jest.fn().mockResolvedValue('ae-1') });

  it('lists annotations with server-calculated capabilities for direct commenters', async () => {
    const svc = new DocumentAnnotationsService(makePrisma(), makeAccess() as never, makeAudit() as never);

    await expect(svc.list('doc-1', 'v-1', user())).resolves.toMatchObject({
      canAnnotate: true,
      canComplianceDelete: false,
      items: [{ id: 'ann-1', status: 'open' }],
    });
  });

  it('reports annotation capability for an assigned reviewer without document.comment', async () => {
    const prisma = makePrisma();
    prisma.reviewAssignment.count.mockResolvedValue(1);
    const svc = new DocumentAnnotationsService(prisma, makeAccess() as never, makeAudit() as never);

    await expect(
      svc.list('doc-1', 'v-1', user({ roles: ['Staff'], permissions: ['document.read'] })),
    ).resolves.toMatchObject({ canAnnotate: true });
  });

  it('creates an annotation for a user with document.comment and audits it', async () => {
    const prisma = makePrisma();
    const audit = makeAudit();
    const svc = new DocumentAnnotationsService(prisma, makeAccess() as never, audit as never);

    const result = await svc.create(
      'doc-1',
      'v-1',
      { pageNumber: 1, x: 0.1, y: 0.1, width: 0.2, height: 0.1, body: 'Please clarify.' },
      user(),
      { ipAddress: '127.0.0.1' },
    );

    expect(prisma.documentAnnotation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ authorId: 'u-1', body: 'Please clarify.' }),
      }),
    );
    expect(result).toMatchObject({ id: 'ann-1', status: 'open', authorName: 'User' });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'annotation.created', documentId: 'doc-1', versionId: 'v-1' }),
    );
  });

  it('FINDING-014: strips HTML from the annotation body before persisting it', async () => {
    const prisma = makePrisma();
    const svc = new DocumentAnnotationsService(prisma, makeAccess() as never, makeAudit() as never);

    await svc.create(
      'doc-1',
      'v-1',
      {
        pageNumber: 1,
        x: 0.1,
        y: 0.1,
        width: 0.2,
        height: 0.1,
        body: 'Looks fine<script>alert(document.cookie)</script> to me.',
      },
      user(),
    );

    const createArg = prisma.documentAnnotation.create.mock.calls[0][0] as {
      data: { body: string };
    };
    expect(createArg.data.body).not.toContain('<script');
    expect(createArg.data.body).not.toContain('alert(document.cookie)');
    expect(createArg.data.body).toBe('Looks fine to me.');
  });

  it('allows an assigned reviewer without document.comment to create an annotation', async () => {
    const prisma = makePrisma();
    prisma.reviewAssignment.count.mockResolvedValue(1);
    const svc = new DocumentAnnotationsService(prisma, makeAccess() as never, makeAudit() as never);

    await expect(
      svc.create(
        'doc-1',
        'v-1',
        { pageNumber: 1, x: 0.1, y: 0.1, width: 0.2, height: 0.1, body: 'Reviewer note' },
        user({ permissions: ['document.read'] }),
      ),
    ).resolves.toMatchObject({ id: 'ann-1' });
  });

  it('does not let an open review task for another version authorize annotation', async () => {
    const prisma = makePrisma();
    prisma.reviewAssignment.count.mockResolvedValue(0);
    prisma.reviewTask.count.mockImplementation(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve('OR' in where ? 0 : 1),
    );
    const svc = new DocumentAnnotationsService(prisma, makeAccess() as never, makeAudit() as never);

    await expect(
      svc.create(
        'doc-1',
        'v-1',
        { pageNumber: 1, x: 0.1, y: 0.1, width: 0.2, height: 0.1, body: 'Wrong version' },
        user({ roles: ['Staff'], permissions: ['document.read'] }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('blocks a read-only auditor from creating annotations', async () => {
    const svc = new DocumentAnnotationsService(makePrisma(), makeAccess() as never, makeAudit() as never);

    await expect(
      svc.create(
        'doc-1',
        'v-1',
        { pageNumber: 1, x: 0.1, y: 0.1, width: 0.2, height: 0.1, body: 'Auditor note' },
        user({ roles: ['Auditor'], permissions: ['document.read'] }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
