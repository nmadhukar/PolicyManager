import { ConfigService } from '@nestjs/config';

// Mock nodemailer BEFORE importing the service so send() picks up the mock.
const sendMail = jest.fn();
const createTransport = jest.fn((_opts?: unknown) => ({ sendMail }));
jest.mock('nodemailer', () => ({
  createTransport: (opts: unknown) => createTransport(opts),
}));

import { MailService } from './mail.service';
import { encryptSecret } from '../common/crypto.util';

/**
 * Business-behavior tests for the reusable mailer. The transport is mocked, so
 * these assert our contract — never crashing on SMTP failure, correct envelope,
 * effective-config selection (DB vs env), and that every send is logged.
 */
describe('MailService', () => {
  const APP_KEY = 'unit-test-encryption-key';
  // Importing @prisma/client auto-loads the repo .env, and ConfigService.get()
  // prefers process.env over the constructor object — so pin the key in process.env
  // to make the DB-config decrypt path deterministic regardless of .env contents.
  const prevKey = process.env.APP_ENCRYPTION_KEY;
  beforeAll(() => {
    process.env.APP_ENCRYPTION_KEY = APP_KEY;
  });
  afterAll(() => {
    if (prevKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
    else process.env.APP_ENCRYPTION_KEY = prevKey;
  });

  const config = new ConfigService({
    SMTP_HOST: 'localhost',
    SMTP_PORT: 1025,
    SMTP_SECURE: false,
    SMTP_FROM_ADDRESS: 'policymanager@example.com',
    SMTP_FROM_NAME: 'PolicyManager',
    APP_ENCRYPTION_KEY: APP_KEY,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const makePrisma = (): any => ({
    smtpConfig: { findFirst: jest.fn().mockResolvedValue(null) },
    notificationLog: { create: jest.fn().mockResolvedValue({ id: 'n1' }) },
  });

  const build = (prisma = makePrisma()) => ({
    prisma,
    svc: new MailService(config, prisma as never),
  });

  beforeEach(() => {
    sendMail.mockReset();
    createTransport.mockClear();
  });

  describe('send', () => {
    it('returns true, forwards the envelope, and logs a "sent" notification', async () => {
      sendMail.mockResolvedValue({ messageId: 'x' });
      const { svc, prisma } = build();
      const ok = await svc.send(
        { to: 'jane@x.com', subject: 'Hi', html: '<b>Hi</b>', text: 'Hi' },
        { type: 'other', toUserId: 'u1' },
      );

      expect(ok).toBe(true);
      expect(sendMail).toHaveBeenCalledTimes(1);
      const arg = sendMail.mock.calls[0][0];
      expect(arg.to).toBe('jane@x.com');
      expect(arg.subject).toBe('Hi');
      expect(arg.from).toContain('policymanager@example.com');
      // Notification recorded as sent.
      expect(prisma.notificationLog.create).toHaveBeenCalledTimes(1);
      expect(prisma.notificationLog.create.mock.calls[0][0].data).toMatchObject({
        toEmail: 'jane@x.com',
        status: 'sent',
        type: 'other',
        toUserId: 'u1',
      });
    });

    it('returns false (does NOT throw) and logs "failed" when the transport fails', async () => {
      sendMail.mockRejectedValue(new Error('ECONNREFUSED'));
      const { svc, prisma } = build();
      await expect(
        svc.send({ to: 'a@b.com', subject: 's', html: 'h' }),
      ).resolves.toBe(false);
      expect(prisma.notificationLog.create.mock.calls[0][0].data).toMatchObject({
        status: 'failed',
        type: 'other',
      });
    });

    it('never throws even if the notification log write fails', async () => {
      sendMail.mockResolvedValue({});
      const prisma = makePrisma();
      prisma.notificationLog.create.mockRejectedValue(new Error('db down'));
      const { svc } = build(prisma);
      await expect(svc.send({ to: 'a@b.com', subject: 's', html: 'h' })).resolves.toBe(true);
    });
  });

  describe('effective-config selection (DB vs env)', () => {
    it('uses the env fallback when no enabled DB row exists', async () => {
      sendMail.mockResolvedValue({});
      const { svc } = build();
      await svc.send({ to: 'a@b.com', subject: 's', html: 'h' });
      expect(createTransport).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'localhost', port: 1025, secure: false, auth: undefined }),
      );
    });

    it('prefers an enabled DB config and decrypts its password for auth', async () => {
      sendMail.mockResolvedValue({});
      const prisma = makePrisma();
      prisma.smtpConfig.findFirst.mockResolvedValue({
        id: 'default',
        host: 'smtp.relay.example',
        port: 587,
        secure: true,
        username: 'relay-user',
        passwordEncrypted: encryptSecret('relay-pass', APP_KEY),
        fromAddress: 'noreply@clinic.example',
        fromName: 'Clinic',
        enabled: true,
      });
      const { svc } = build(prisma);
      await svc.send({ to: 'a@b.com', subject: 's', html: 'h' });

      expect(createTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'smtp.relay.example',
          port: 587,
          secure: true,
          auth: { user: 'relay-user', pass: 'relay-pass' },
        }),
      );
      // Envelope "from" reflects the DB config.
      expect(sendMail.mock.calls[0][0].from).toContain('noreply@clinic.example');
    });

    it('degrades to env when a saved config read throws (never black-holes email)', async () => {
      sendMail.mockResolvedValue({});
      const prisma = makePrisma();
      prisma.smtpConfig.findFirst.mockRejectedValue(new Error('db error'));
      const { svc } = build(prisma);
      const ok = await svc.send({ to: 'a@b.com', subject: 's', html: 'h' });
      expect(ok).toBe(true);
      expect(createTransport).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'localhost', port: 1025 }),
      );
    });
  });

  describe('sendPasswordReset', () => {
    it('embeds the reset URL, targets the recipient, logs password_reset', async () => {
      sendMail.mockResolvedValue({});
      const { svc, prisma } = build();
      const url = 'http://localhost:5173/reset-password?token=RAWTOKEN';
      const ok = await svc.sendPasswordReset('jane@x.com', 'Jane', url);

      expect(ok).toBe(true);
      const arg = sendMail.mock.calls[0][0];
      expect(arg.to).toBe('jane@x.com');
      expect(arg.subject).toMatch(/reset/i);
      expect(arg.html).toContain(url);
      expect(arg.text).toContain(url);
      expect(prisma.notificationLog.create.mock.calls[0][0].data.type).toBe('password_reset');
    });
  });

  describe('sendAccountLocked', () => {
    it('notifies the recipient their account is locked', async () => {
      sendMail.mockResolvedValue({});
      const { svc } = build();
      const ok = await svc.sendAccountLocked('jane@x.com', 'Jane');

      expect(ok).toBe(true);
      const arg = sendMail.mock.calls[0][0];
      expect(arg.to).toBe('jane@x.com');
      expect(arg.subject).toMatch(/lock/i);
    });
  });

  describe('sendReviewReminder', () => {
    it('sends a due reminder with the deep link and logs review_reminder', async () => {
      sendMail.mockResolvedValue({});
      const { svc, prisma } = build();
      const ok = await svc.sendReviewReminder({
        to: 'rev@x.com',
        name: 'Rev',
        documentTitle: 'Intake Policy',
        dueDate: new Date('2026-08-01T00:00:00Z'),
        reviewUrl: 'http://localhost:5173/library/doc-1',
        toUserId: 'u9',
        reviewTaskId: 't1',
      });
      expect(ok).toBe(true);
      const arg = sendMail.mock.calls[0][0];
      expect(arg.subject).toMatch(/review due/i);
      expect(arg.html).toContain('http://localhost:5173/library/doc-1');
      expect(arg.html).toContain('Intake Policy');
      expect(prisma.notificationLog.create.mock.calls[0][0].data).toMatchObject({
        type: 'review_reminder',
        toUserId: 'u9',
        reviewTaskId: 't1',
      });
    });

    it('switches copy + type for an overdue reminder', async () => {
      sendMail.mockResolvedValue({});
      const { svc, prisma } = build();
      await svc.sendReviewReminder({
        to: 'rev@x.com',
        name: 'Rev',
        documentTitle: 'Intake Policy',
        dueDate: new Date('2026-06-01T00:00:00Z'),
        reviewUrl: 'http://localhost:5173/library/doc-1',
        overdue: true,
      });
      expect(sendMail.mock.calls[0][0].subject).toMatch(/overdue/i);
      expect(prisma.notificationLog.create.mock.calls[0][0].data.type).toBe('review_overdue');
    });
  });
});
