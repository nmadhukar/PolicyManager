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

  function serviceWith(prisma = {}) {
    const access = { assertCanAccess: jest.fn() };
    const coverPage = {};
    const audit = { record: jest.fn() };
    const service = new EvidenceBinderService(
      prisma as unknown as PrismaService,
      access as unknown as DocumentAccessService,
      coverPage as unknown as CoverPageService,
      audit as unknown as AuditService,
    );
    return { service, access };
  }

  it('rejects export before document access when evidence.export is missing', async () => {
    const prisma = { document: { findFirst: jest.fn() } };
    const { service, access } = serviceWith(prisma);

    await expect(
      service.export('doc-1', { format: 'zip' }, user),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(access.assertCanAccess).not.toHaveBeenCalled();
    expect(prisma.document.findFirst).not.toHaveBeenCalled();
  });

  it('rejects history when evidence.export is missing', async () => {
    const prisma = { document: { findFirst: jest.fn() } };
    const { service, access } = serviceWith(prisma);

    await expect(service.history('doc-1', user)).rejects.toBeInstanceOf(ForbiddenException);
    expect(access.assertCanAccess).not.toHaveBeenCalled();
    expect(prisma.document.findFirst).not.toHaveBeenCalled();
  });
});
