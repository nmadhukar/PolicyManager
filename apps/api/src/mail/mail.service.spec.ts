import { ConfigService } from '@nestjs/config';

// Mock nodemailer BEFORE importing the service so the constructor picks up the mock.
const sendMail = jest.fn();
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail })),
}));

import { MailService } from './mail.service';

/**
 * Business-behavior tests for the reusable mailer. The transport is mocked, so
 * these assert our contract — never crashing on SMTP failure, correct envelope,
 * and that reset/lockout helpers embed the right content.
 */
describe('MailService', () => {
  const config = new ConfigService({
    SMTP_HOST: 'localhost',
    SMTP_PORT: 1025,
    SMTP_SECURE: false,
    SMTP_FROM_ADDRESS: 'policymanager@example.com',
    SMTP_FROM_NAME: 'PolicyManager',
  });

  const build = () => new MailService(config);

  beforeEach(() => {
    sendMail.mockReset();
  });

  describe('send', () => {
    it('returns true and forwards the envelope on success', async () => {
      sendMail.mockResolvedValue({ messageId: 'x' });
      const ok = await build().send({
        to: 'jane@x.com',
        subject: 'Hi',
        html: '<b>Hi</b>',
        text: 'Hi',
      });

      expect(ok).toBe(true);
      expect(sendMail).toHaveBeenCalledTimes(1);
      const arg = sendMail.mock.calls[0][0];
      expect(arg.to).toBe('jane@x.com');
      expect(arg.subject).toBe('Hi');
      expect(arg.from).toContain('policymanager@example.com');
    });

    it('returns false (does NOT throw) when the transport fails', async () => {
      sendMail.mockRejectedValue(new Error('ECONNREFUSED'));
      // Must not crash the caller — SMTP being down is not fatal.
      await expect(
        build().send({ to: 'a@b.com', subject: 's', html: 'h' }),
      ).resolves.toBe(false);
    });
  });

  describe('sendPasswordReset', () => {
    it('embeds the reset URL and targets the recipient', async () => {
      sendMail.mockResolvedValue({});
      const url = 'http://localhost:5173/reset-password?token=RAWTOKEN';
      const ok = await build().sendPasswordReset('jane@x.com', 'Jane', url);

      expect(ok).toBe(true);
      const arg = sendMail.mock.calls[0][0];
      expect(arg.to).toBe('jane@x.com');
      expect(arg.subject).toMatch(/reset/i);
      expect(arg.html).toContain(url);
      expect(arg.text).toContain(url);
    });
  });

  describe('sendAccountLocked', () => {
    it('notifies the recipient their account is locked', async () => {
      sendMail.mockResolvedValue({});
      const ok = await build().sendAccountLocked('jane@x.com', 'Jane');

      expect(ok).toBe(true);
      const arg = sendMail.mock.calls[0][0];
      expect(arg.to).toBe('jane@x.com');
      expect(arg.subject).toMatch(/lock/i);
    });
  });
});
