import { ForbiddenException } from '@nestjs/common';
import { PERMISSIONS, type AuthUser } from '@policymanager/shared';
import type { AuditService } from '../audit/audit.service';
import type { CoverPageService } from '../attestation/cover-page.service';
import type { DocumentAccessService } from '../documents/document-access.service';
import type { PrismaService } from '../prisma/prisma.service';
import { EvidenceBinderService } from './evidence-binder.service';

describe('EvidenceBinderService', () => {
  const user: AuthUser = {
    id: 'u1',
    email: 'u1@example.com',
    name: 'User One',
    roles: ['Staff'],
    permissions: [PERMISSIONS.DOCUMENT_READ],
    mustChangePassword: false,
  };

  function serviceWith(prisma = {}, access: Record<string, unknown> = { assertCanAccess: jest.fn() }) {
    const coverPage = {};
    const audit = { record: jest.fn() };
    const service = new EvidenceBinderService(
      prisma as unknown as PrismaService,
      access as unknown as DocumentAccessService,
      coverPage as unknown as CoverPageService,
      audit as unknown as AuditService,
    );
    return { service, access, audit };
  }

  it('rejects export before document access when evidence.export is missing', async () => {
    const prisma = { document: { findFirst: jest.fn() } };
    const { service, access, audit } = serviceWith(prisma);

    await expect(
      service.export('doc-1', { format: 'zip' }, user),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(access.assertCanAccess).not.toHaveBeenCalled();
    // Coarse permission gate short-circuits before any DB read...
    expect(prisma.document.findFirst).not.toHaveBeenCalled();
    // ...and the denial is audited (not silent).
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: expect.stringContaining('denied') }),
    );
  });

  it('denies (and audits) a confidential document the exporter cannot download', async () => {
    const exporter: AuthUser = { ...user, permissions: [PERMISSIONS.EVIDENCE_EXPORT] };
    const prisma = {
      document: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'doc-1',
          title: 'Confidential Policy',
          documentNumber: 'PP-1',
          ownerId: 'other',
          accessLevel: 'confidential',
          categoryId: null,
          currentVersionId: 'v1',
          currentVersion: { id: 'v1', versionNumber: 1 },
        }),
      },
    };
    const access = { canAccess: jest.fn().mockResolvedValue(false) };
    const { service, audit } = serviceWith(prisma, access);

    await expect(
      service.export('doc-1', { format: 'zip', includeAuditLog: false }, exporter),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(access.canAccess).toHaveBeenCalledWith(exporter, expect.anything(), 'download');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: expect.stringContaining('denied'),
        documentId: 'doc-1',
      }),
    );
  });

  it('rejects history when evidence.export is missing', async () => {
    const prisma = { document: { findFirst: jest.fn() } };
    const { service, access } = serviceWith(prisma);

    await expect(service.history('doc-1', user)).rejects.toBeInstanceOf(ForbiddenException);
    expect(access.assertCanAccess).not.toHaveBeenCalled();
    expect(prisma.document.findFirst).not.toHaveBeenCalled();
  });
});
