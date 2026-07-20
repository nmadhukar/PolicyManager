import type { AuditService } from '../audit/audit.service';
import type { MailService } from '../mail/mail.service';
import type { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from './notifications.service';

describe('NotificationsService', () => {
  function serviceWith(prisma: Record<string, unknown>) {
    const mail = { send: jest.fn() };
    const audit = { record: jest.fn() };
    const service = new NotificationsService(
      prisma as unknown as PrismaService,
      mail as unknown as MailService,
      audit as unknown as AuditService,
    );
    return { service, mail, audit };
  }

  it('does not include linked document notifications in digests after access is removed', async () => {
    const now = new Date('2026-07-13T14:00:00.000Z');
    const prisma = {
      notificationPreference: {
        findMany: jest.fn().mockResolvedValue([
          {
            userId: 'u1',
            emailDigestEnabled: true,
            digestFrequency: 'daily',
            digestTimeLocal: '10:00',
            timezone: 'America/New_York',
            lastDigestSentAt: null,
            typeOverrides: null,
            user: {
              id: 'u1',
              email: 'u1@example.com',
              name: 'User One',
              status: 'active',
              roles: [],
            },
          },
        ]),
      },
      notification: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'n1',
            type: 'policy_published',
            title: 'Policy published',
            body: 'Confidential policy',
            documentId: 'doc-secret',
            createdAt: now,
          },
        ]),
      },
      document: { findMany: jest.fn() },
      notificationDelivery: { create: jest.fn() },
    };
    const { service, mail, audit } = serviceWith(prisma);

    const result = await service.runDigest(now, true);

    expect(result).toEqual({ usersConsidered: 1, digestsSent: 0, failed: 0 });
    expect(mail.send).not.toHaveBeenCalled();
    expect(prisma.notificationDelivery.create).not.toHaveBeenCalled();
    // The user has no document.read permission, so resolveDocumentVisibility
    // short-circuits before ever querying documents.
    expect(prisma.document.findMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('sends visible linked document notifications in digests', async () => {
    const now = new Date('2026-07-13T14:00:00.000Z');
    const prisma = {
      notificationPreference: {
        findMany: jest.fn().mockResolvedValue([
          {
            userId: 'u1',
            emailDigestEnabled: true,
            digestFrequency: 'daily',
            digestTimeLocal: '10:00',
            timezone: 'America/New_York',
            lastDigestSentAt: null,
            typeOverrides: null,
            user: {
              id: 'u1',
              email: 'u1@example.com',
              name: 'User One',
              status: 'active',
              roles: [
                {
                  role: {
                    name: 'Staff',
                    permissions: [{ permission: { key: 'document.read' } }],
                  },
                },
              ],
            },
          },
        ]),
        update: jest.fn().mockResolvedValue({}),
      },
      notification: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'n1',
            type: 'policy_published',
            title: 'Policy published',
            body: 'Visible policy',
            documentId: 'doc-1',
            createdAt: now,
          },
        ]),
      },
      document: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'doc-1', ownerId: 'other', accessLevel: 'restricted', categoryId: null },
        ]),
      },
      notificationDelivery: { create: jest.fn().mockResolvedValue({}) },
    };
    const { service, mail, audit } = serviceWith(prisma);
    mail.send.mockResolvedValue(true);

    const result = await service.runDigest(now, true);

    expect(result).toEqual({ usersConsidered: 1, digestsSent: 1, failed: 0 });
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(prisma.notificationDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'sent' }),
      }),
    );
    expect(prisma.notificationPreference.update).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'notification_digest.sent' }),
    );
  });

  describe('FINDING-009: bounded (not per-row) document-visibility check in runDigest', () => {
    it('resolves visibility for N confidential-linked digest rows with a constant, not per-row, query count', async () => {
      const now = new Date('2026-07-13T14:00:00.000Z');
      const ROW_COUNT = 25;
      const digestRows = Array.from({ length: ROW_COUNT }, (_, i) => ({
        id: `n-${i}`,
        type: 'policy_published',
        title: `T${i}`,
        body: `B${i}`,
        // All rows share the SAME confidential document, so a correct batched
        // implementation issues one documents/role/ACL lookup for the whole
        // set, not one chain per row.
        documentId: 'doc-shared',
        createdAt: now,
      }));
      const documentFindMany = jest
        .fn()
        .mockResolvedValue([{ id: 'doc-shared', ownerId: 'other', accessLevel: 'confidential', categoryId: null }]);
      const roleFindMany = jest.fn().mockResolvedValue([{ id: 'role-staff' }]);
      const documentAclFindMany = jest
        .fn()
        .mockResolvedValue([{ documentId: 'doc-shared', categoryId: null }]); // user has a grant
      const prisma = {
        notificationPreference: {
          findMany: jest.fn().mockResolvedValue([
            {
              userId: 'u1',
              emailDigestEnabled: true,
              digestFrequency: 'daily',
              digestTimeLocal: '10:00',
              timezone: 'America/New_York',
              lastDigestSentAt: null,
              typeOverrides: null,
              user: {
                id: 'u1',
                email: 'u1@example.com',
                name: 'User One',
                status: 'active',
                roles: [
                  { role: { name: 'Staff', permissions: [{ permission: { key: 'document.read' } }] } },
                ],
              },
            },
          ]),
          update: jest.fn().mockResolvedValue({}),
        },
        notification: { findMany: jest.fn().mockResolvedValue(digestRows) },
        document: { findMany: documentFindMany },
        role: { findMany: roleFindMany },
        documentAcl: { findMany: documentAclFindMany },
        notificationDelivery: { create: jest.fn().mockResolvedValue({}) },
      };
      const { service, mail, audit } = serviceWith(prisma);
      mail.send.mockResolvedValue(true);

      const result = await service.runDigest(now, true);

      // Exactly ONE documents/role/ACL lookup for the whole digest batch of 25
      // rows sharing one document — NOT one chain per row (which would be 25).
      expect(documentFindMany).toHaveBeenCalledTimes(1);
      expect(roleFindMany).toHaveBeenCalledTimes(1);
      expect(documentAclFindMany).toHaveBeenCalledTimes(1);

      expect(result).toEqual({ usersConsidered: 1, digestsSent: 1, failed: 0 });
      expect(mail.send).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'notification_digest.sent' }),
      );
    });

    it('excludes confidential-linked rows the user has no grant for, matching pre-batching behavior', async () => {
      const now = new Date('2026-07-13T14:00:00.000Z');
      const prisma = {
        notificationPreference: {
          findMany: jest.fn().mockResolvedValue([
            {
              userId: 'u1',
              emailDigestEnabled: true,
              digestFrequency: 'daily',
              digestTimeLocal: '10:00',
              timezone: 'America/New_York',
              lastDigestSentAt: null,
              typeOverrides: null,
              user: {
                id: 'u1',
                email: 'u1@example.com',
                name: 'User One',
                status: 'active',
                roles: [
                  { role: { name: 'Staff', permissions: [{ permission: { key: 'document.read' } }] } },
                ],
              },
            },
          ]),
        },
        notification: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'n1',
              type: 'policy_published',
              title: 'Secret',
              body: 'Secret body',
              documentId: 'doc-secret',
              createdAt: now,
            },
          ]),
        },
        document: {
          findMany: jest
            .fn()
            .mockResolvedValue([{ id: 'doc-secret', ownerId: 'other', accessLevel: 'confidential', categoryId: null }]),
        },
        role: { findMany: jest.fn().mockResolvedValue([]) },
        documentAcl: { findMany: jest.fn().mockResolvedValue([]) }, // no grant
        notificationDelivery: { create: jest.fn().mockResolvedValue({}) },
      };
      const { service, mail } = serviceWith(prisma);

      const result = await service.runDigest(now, true);

      // No visible rows => digest is skipped entirely for this user.
      expect(result).toEqual({ usersConsidered: 1, digestsSent: 0, failed: 0 });
      expect(mail.send).not.toHaveBeenCalled();
    });
  });

  describe('FINDING-005: bounded-concurrency digest sends', () => {
    function prefFor(userId: string) {
      return {
        userId,
        emailDigestEnabled: true,
        digestFrequency: 'daily',
        digestTimeLocal: '10:00',
        timezone: 'America/New_York',
        lastDigestSentAt: null,
        typeOverrides: null,
        user: { id: userId, email: `${userId}@example.com`, name: userId, status: 'active', roles: [] },
      };
    }

    it('sends every user digest exactly once, bounds concurrency, and isolates per-user failures', async () => {
      const now = new Date('2026-07-13T14:00:00.000Z');
      const USERS = 20;
      const prefs = Array.from({ length: USERS }, (_, i) => prefFor(`u${i}`));
      let inFlight = 0;
      let maxInFlight = 0;
      const prisma = {
        notificationPreference: {
          findMany: jest.fn().mockResolvedValue(prefs),
          update: jest.fn().mockResolvedValue({}),
        },
        notification: {
          findMany: jest.fn((args: { where: { recipientId: string } }) =>
            Promise.resolve([
              {
                id: `n-${args.where.recipientId}`,
                type: 'policy_published',
                title: 'Policy published',
                body: 'Visible policy',
                documentId: null,
                createdAt: now,
              },
            ]),
          ),
        },
        document: { findMany: jest.fn() },
        notificationDelivery: { create: jest.fn().mockResolvedValue({}) },
      };
      const { service, mail, audit } = serviceWith(prisma);
      mail.send.mockImplementation(async ({ to }: { to: string }) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        // Every 5th user's send fails; the sweep must not abort or skip others.
        if (to.endsWith('4@example.com') || to.endsWith('9@example.com')) return false;
        return true;
      });

      const result = await service.runDigest(now, true);

      expect(result.usersConsidered).toBe(USERS);
      expect(result.digestsSent + result.failed).toBe(USERS);
      expect(mail.send).toHaveBeenCalledTimes(USERS);
      expect(maxInFlight).toBeGreaterThan(1); // proves real overlap, not serial sends
      expect(maxInFlight).toBeLessThanOrEqual(8); // proves the concurrency bound holds
      expect(prisma.notificationDelivery.create).toHaveBeenCalledTimes(USERS);
      expect(audit.record).toHaveBeenCalledTimes(USERS);
    });
  });

  describe('list', () => {
    const staffUser = {
      id: 'staff-1',
      email: 's@x.com',
      name: 'Staff',
      roles: ['Staff'],
      permissions: ['document.read'],
      mustChangePassword: false,
    };

    it('FINDING-004: resolves visibility for N rows sharing M confidential documents with a bounded (not per-row) query count', async () => {
      const now = new Date('2026-07-13T14:00:00.000Z');
      const rows = [
        { id: 'n1', type: 'policy_published', title: 'T1', body: 'B1', documentId: 'doc-a', documentVersionId: null, priority: 'normal', entityType: null, entityId: null, metadata: null, readAt: null, dismissedAt: null, createdAt: now, actor: null },
        { id: 'n2', type: 'policy_published', title: 'T2', body: 'B2', documentId: 'doc-a', documentVersionId: null, priority: 'normal', entityType: null, entityId: null, metadata: null, readAt: null, dismissedAt: null, createdAt: now, actor: null },
        { id: 'n3', type: 'policy_published', title: 'T3', body: 'B3', documentId: 'doc-b', documentVersionId: null, priority: 'normal', entityType: null, entityId: null, metadata: null, readAt: null, dismissedAt: null, createdAt: now, actor: null },
      ];
      const documentFindMany = jest.fn().mockResolvedValue([
        { id: 'doc-a', ownerId: 'other', accessLevel: 'confidential', categoryId: null },
        { id: 'doc-b', ownerId: 'other', accessLevel: 'restricted', categoryId: null },
      ]);
      const roleFindMany = jest.fn().mockResolvedValue([{ id: 'role-staff' }]);
      const documentAclFindMany = jest.fn().mockResolvedValue([
        { documentId: 'doc-a', categoryId: null }, // staff has a grant on doc-a
      ]);
      const prisma = {
        notificationPreference: {
          upsert: jest.fn().mockResolvedValue({ inAppEnabled: true, typeOverrides: null }),
        },
        notification: { findMany: jest.fn().mockResolvedValue(rows), count: jest.fn().mockResolvedValue(3) },
        document: { findMany: documentFindMany },
        role: { findMany: roleFindMany },
        documentAcl: { findMany: documentAclFindMany },
        $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
      };
      const { service } = serviceWith(prisma);

      const result = await service.list(staffUser as never, {});

      // Exactly one documents lookup, one role lookup, one ACL lookup for the
      // WHOLE page — not one chain per row (3 rows, 2 distinct documents).
      expect(documentFindMany).toHaveBeenCalledTimes(1);
      expect(roleFindMany).toHaveBeenCalledTimes(1);
      expect(documentAclFindMany).toHaveBeenCalledTimes(1);

      expect(result.items).toHaveLength(3);
      // doc-a is confidential but staff HAS a grant => visible.
      expect(result.items[0]).toMatchObject({ title: 'T1', documentId: 'doc-a' });
      expect(result.items[1]).toMatchObject({ title: 'T2', documentId: 'doc-a' });
      // doc-b is restricted (not confidential) => visible regardless of grants.
      expect(result.items[2]).toMatchObject({ title: 'T3', documentId: 'doc-b' });
    });

    it('FINDING-004: a confidential document with no grant is hidden, matching the pre-batching behavior', async () => {
      const now = new Date('2026-07-13T14:00:00.000Z');
      const rows = [
        { id: 'n1', type: 'policy_published', title: 'Secret', body: 'Secret body', documentId: 'doc-secret', documentVersionId: null, priority: 'normal', entityType: null, entityId: null, metadata: null, readAt: null, dismissedAt: null, createdAt: now, actor: null },
      ];
      const prisma = {
        notificationPreference: {
          upsert: jest.fn().mockResolvedValue({ inAppEnabled: true, typeOverrides: null }),
        },
        notification: { findMany: jest.fn().mockResolvedValue(rows), count: jest.fn().mockResolvedValue(1) },
        document: {
          findMany: jest
            .fn()
            .mockResolvedValue([{ id: 'doc-secret', ownerId: 'other', accessLevel: 'confidential', categoryId: null }]),
        },
        role: { findMany: jest.fn().mockResolvedValue([]) },
        documentAcl: { findMany: jest.fn().mockResolvedValue([]) }, // no grant
        $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
      };
      const { service } = serviceWith(prisma);

      const result = await service.list(staffUser as never, {});

      expect(result.items[0]).toMatchObject({
        title: 'Document unavailable',
        body: 'You no longer have access to the linked document.',
        href: null,
      });
    });
  });
});
