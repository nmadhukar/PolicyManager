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
      document: { findFirst: jest.fn() },
      notificationDelivery: { create: jest.fn() },
    };
    const { service, mail, audit } = serviceWith(prisma);

    const result = await service.runDigest(now, true);

    expect(result).toEqual({ usersConsidered: 1, digestsSent: 0, failed: 0 });
    expect(mail.send).not.toHaveBeenCalled();
    expect(prisma.notificationDelivery.create).not.toHaveBeenCalled();
    expect(prisma.document.findFirst).not.toHaveBeenCalled();
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
        findFirst: jest.fn().mockResolvedValue({
          id: 'doc-1',
          ownerId: 'other',
          accessLevel: 'restricted',
          categoryId: null,
        }),
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
});
