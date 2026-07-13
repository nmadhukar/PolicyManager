import { ConfigService } from '@nestjs/config';
import type { AuthUser } from '@policymanager/shared';
import { SmtpService } from './smtp.service';
import { decryptSecret, isEncryptedPayload } from '../common/crypto.util';

/**
 * Business-behavior tests for the SMTP admin service. Assert the security-critical
 * contracts: the stored password is AES-encrypted (never plaintext) and NEVER
 * returned/leaked to audit, config selection reflects a saved row vs env, and
 * config changes + test sends are audited.
 */
describe('SmtpService', () => {
  const APP_KEY = 'unit-test-encryption-key';
  const config = new ConfigService({
    SMTP_HOST: 'localhost',
    SMTP_PORT: 1025,
    SMTP_SECURE: false,
    SMTP_USER: '',
    SMTP_PASS: '',
    SMTP_FROM_ADDRESS: 'policymanager@example.com',
    SMTP_FROM_NAME: 'PolicyManager',
    APP_ENCRYPTION_KEY: APP_KEY,
  });

  const prevKey = process.env.APP_ENCRYPTION_KEY;
  beforeAll(() => {
    process.env.APP_ENCRYPTION_KEY = APP_KEY;
  });
  afterAll(() => {
    if (prevKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
    else process.env.APP_ENCRYPTION_KEY = prevKey;
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const makePrisma = (): any => ({
    smtpConfig: {
      findFirst: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    },
    notificationLog: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    // Mirror Prisma's array form: resolve all the passed operation promises.
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  });
  const makeMail = () => ({ send: jest.fn().mockResolvedValue(true) });
  const makeAudit = () => ({ record: jest.fn().mockResolvedValue('ae-1') });

  const build = (prisma = makePrisma(), mail = makeMail(), audit = makeAudit()) => ({
    prisma,
    mail,
    audit,
    svc: new SmtpService(prisma as never, config, mail as never, audit as never),
  });

  const user: AuthUser = {
    id: 'admin-1',
    email: 'a@x.com',
    name: 'Admin',
    roles: ['Admin'],
    permissions: ['smtp.manage'],
    mustChangePassword: false,
  };

  const dbRow = (over: Record<string, unknown> = {}) => ({
    id: 'default',
    host: 'smtp.relay.example',
    port: 587,
    secure: true,
    username: 'relay-user',
    passwordEncrypted: null,
    fromAddress: 'noreply@clinic.example',
    fromName: 'Clinic',
    enabled: true,
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    updatedById: 'admin-1',
    ...over,
  });

  describe('getConfig', () => {
    it('returns the env fallback view (no password) when no row exists', async () => {
      const { svc } = build();
      const view = await svc.getConfig();
      expect(view).toMatchObject({
        host: 'localhost',
        port: 1025,
        secure: false,
        enabled: false,
        hasPassword: false,
        source: 'env',
        updatedAt: null,
      });
      // The view type has no password field at all.
      const asRec = view as unknown as Record<string, unknown>;
      expect(asRec.password).toBeUndefined();
      expect(asRec.passwordEncrypted).toBeUndefined();
    });

    it('returns the saved row view with hasPassword but NEVER the password', async () => {
      const prisma = makePrisma();
      prisma.smtpConfig.findFirst.mockResolvedValue(
        dbRow({ passwordEncrypted: 'iv:tag:data' }),
      );
      const { svc } = build(prisma);
      const view = await svc.getConfig();
      expect(view).toMatchObject({
        host: 'smtp.relay.example',
        port: 587,
        secure: true,
        username: 'relay-user',
        enabled: true,
        hasPassword: true,
        source: 'db',
      });
      expect((view as unknown as Record<string, unknown>).passwordEncrypted).toBeUndefined();
      expect(JSON.stringify(view)).not.toContain('iv:tag:data');
    });
  });

  describe('updateConfig', () => {
    it('encrypts a provided password (ciphertext, decryptable) and audits without leaking it', async () => {
      const { svc, prisma, audit } = build();
      await svc.updateConfig(
        {
          host: 'smtp.relay.example',
          port: 587,
          secure: true,
          username: 'relay-user',
          password: 'super-secret',
          fromAddress: 'noreply@clinic.example',
          fromName: 'Clinic',
          enabled: true,
        },
        user,
        { ipAddress: '10.0.0.1' },
      );

      const upsertArg = prisma.smtpConfig.upsert.mock.calls[0][0];
      const stored = upsertArg.update.passwordEncrypted as string;
      // Stored value is ciphertext, not the plaintext.
      expect(stored).not.toContain('super-secret');
      expect(isEncryptedPayload(stored)).toBe(true);
      expect(decryptSecret(stored, APP_KEY)).toBe('super-secret');

      // Audit written, and the plaintext password is NOT in the metadata.
      const auditArg = audit.record.mock.calls[0][0];
      expect(auditArg.action).toBe('smtp.config_changed');
      expect(auditArg.actorUserId).toBe('admin-1');
      expect(JSON.stringify(auditArg)).not.toContain('super-secret');
      expect(auditArg.metadata).toMatchObject({ passwordChanged: true, enabled: true });
    });

    it('keeps the existing password when password is omitted', async () => {
      const { svc, prisma } = build();
      await svc.updateConfig(
        {
          host: 'h',
          port: 25,
          secure: false,
          fromAddress: 'a@b.c',
          fromName: 'N',
          enabled: false,
        },
        user,
      );
      const upsertArg = prisma.smtpConfig.upsert.mock.calls[0][0];
      // No passwordEncrypted key in the update payload => left untouched.
      expect('passwordEncrypted' in upsertArg.update).toBe(false);
    });

    it('clears the password when an empty string is sent', async () => {
      const { svc, prisma } = build();
      await svc.updateConfig(
        {
          host: 'h',
          port: 25,
          secure: false,
          password: '',
          fromAddress: 'a@b.c',
          fromName: 'N',
          enabled: false,
        },
        user,
      );
      const upsertArg = prisma.smtpConfig.upsert.mock.calls[0][0];
      expect(upsertArg.update.passwordEncrypted).toBeNull();
    });
  });

  describe('sendTest', () => {
    it('sends via MailService (smtp_test) and audits smtp.test_sent', async () => {
      const { svc, mail, audit } = build();
      const res = await svc.sendTest('me@clinic.example', user, { ipAddress: '10.0.0.2' });
      expect(res.ok).toBe(true);
      const sendArgs = mail.send.mock.calls[0];
      expect(sendArgs[0].to).toBe('me@clinic.example');
      expect(sendArgs[1]).toMatchObject({ type: 'smtp_test' });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'smtp.test_sent', actorUserId: 'admin-1' }),
      );
    });

    it('reports ok:false when the send fails (still audited)', async () => {
      const mail = makeMail();
      mail.send.mockResolvedValue(false);
      const { svc, audit } = build(makePrisma(), mail);
      const res = await svc.sendTest('me@clinic.example', user);
      expect(res.ok).toBe(false);
      expect(audit.record).toHaveBeenCalled();
    });
  });

  describe('listNotifications', () => {
    it('maps rows to items and clamps pagination', async () => {
      const prisma = makePrisma();
      prisma.notificationLog.findMany.mockResolvedValue([
        {
          id: 'n1',
          toEmail: 'x@y.z',
          toUserId: 'u1',
          subject: 'Review due',
          type: 'review_reminder',
          reviewTaskId: 't1',
          status: 'sent',
          error: null,
          createdAt: new Date('2026-07-02T00:00:00Z'),
        },
      ]);
      prisma.notificationLog.count.mockResolvedValue(1);
      const { svc } = build(prisma);
      const page = await svc.listNotifications({ page: 0, pageSize: 999, type: 'review_reminder' });
      expect(page.total).toBe(1);
      expect(page.page).toBe(1); // clamped up
      expect(page.pageSize).toBeLessThanOrEqual(200); // clamped down
      expect(page.items[0]).toMatchObject({
        id: 'n1',
        type: 'review_reminder',
        status: 'sent',
        createdAt: '2026-07-02T00:00:00.000Z',
      });
      // Filter forwarded to the where-clause.
      const whereArg = prisma.notificationLog.findMany.mock.calls[0][0].where;
      expect(whereArg).toMatchObject({ type: 'review_reminder' });
    });
  });
});
