import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NotificationType } from '@policymanager/shared';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { PrismaService } from '../prisma/prisma.service';
import { decryptSecret } from '../common/crypto.util';

/** A single outbound message. `text` is optional but recommended for deliverability. */
export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

/**
 * Bookkeeping attached to a send so it can be recorded in NotificationLog. All
 * fields are optional except the category `type` (defaulted to `other`).
 */
export interface NotificationMeta {
  type?: NotificationType;
  toUserId?: string | null;
  reviewTaskId?: string | null;
}

/** The effective SMTP settings a send actually uses, plus where they came from. */
interface ResolvedSmtp {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  fromAddress: string;
  fromName: string;
  source: 'db' | 'env';
}

/**
 * Reusable SMTP mailer (Phase 2 password flows; Phase 5 review reminders + admin
 * config). Transport is resolved per send: a DB-backed {@link SmtpConfig} row wins
 * when `enabled`, otherwise the SMTP_* env fallback — so the same image talks to
 * MailHog locally and an operator-configured relay in production without a redeploy.
 *
 * DESIGN: `send` NEVER throws. Email is a best-effort side-channel — an SMTP
 * outage must not fail a password reset, a login, or a review sweep. Callers get a
 * boolean and decide how to surface it. Every attempt (success or failure) writes a
 * NotificationLog row, itself best-effort so logging can never break a send.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /** Reads the SMTP_* env fallback into a resolved config. */
  private envConfig(): ResolvedSmtp {
    return {
      host: this.config.get<string>('SMTP_HOST', 'localhost'),
      port: Number(this.config.get<string>('SMTP_PORT', '1025')),
      // Accept boolean or the string "true" from env.
      secure: String(this.config.get('SMTP_SECURE', 'false')) === 'true',
      user: this.config.get<string>('SMTP_USER', ''),
      pass: this.config.get<string>('SMTP_PASS', ''),
      fromAddress: this.config.get<string>('SMTP_FROM_ADDRESS', 'policymanager@example.com'),
      fromName: this.config.get<string>('SMTP_FROM_NAME', 'PolicyManager'),
      source: 'env',
    };
  }

  /**
   * Resolves the effective SMTP config: the enabled DB row (password decrypted)
   * when present, else the env fallback. Any failure reading/decrypting the DB row
   * degrades to env — a broken saved config must not black-hole all email.
   */
  private async resolveConfig(): Promise<ResolvedSmtp> {
    try {
      const row = await this.prisma.smtpConfig.findFirst({ where: { id: 'default', enabled: true } });
      if (row) {
        let pass = '';
        if (row.passwordEncrypted) {
          try {
            pass = decryptSecret(row.passwordEncrypted, this.encryptionKey());
          } catch (err) {
            this.logger.warn(`Failed to decrypt stored SMTP password; sending without auth: ${String(err)}`);
          }
        }
        return {
          host: row.host,
          port: row.port,
          secure: row.secure,
          user: row.username ?? '',
          pass,
          fromAddress: row.fromAddress,
          fromName: row.fromName,
          source: 'db',
        };
      }
    } catch (err) {
      this.logger.warn(`Failed to read SMTP config; falling back to env: ${String(err)}`);
    }
    return this.envConfig();
  }

  /** SM2: require an encryption key — never fall back to a shipped default. */
  private encryptionKey(): string {
    return this.config.getOrThrow<string>('APP_ENCRYPTION_KEY');
  }

  private buildTransport(cfg: ResolvedSmtp): Transporter {
    return nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      // Only attach auth when a username is configured (MailHog needs none).
      auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    });
  }

  /**
   * Sends a message using the effective config and records a NotificationLog row.
   * Returns true on success, false if the transport failed. Never throws.
   */
  async send(message: MailMessage, meta: NotificationMeta = {}): Promise<boolean> {
    const cfg = await this.resolveConfig();
    const from = `"${cfg.fromName}" <${cfg.fromAddress}>`;
    let ok = false;
    let error: string | undefined;
    try {
      const transporter = this.buildTransport(cfg);
      await transporter.sendMail({
        from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text ?? stripHtml(message.html),
      });
      ok = true;
    } catch (err) {
      // Do not rethrow: email is best-effort. Surface via the boolean + a log.
      error = String(err);
      this.logger.warn(`Failed to send "${message.subject}" to ${message.to}: ${error}`);
    }
    await this.recordNotification(message, meta, ok, error);
    return ok;
  }

  /** Best-effort NotificationLog write — must never break a send. */
  private async recordNotification(
    message: MailMessage,
    meta: NotificationMeta,
    ok: boolean,
    error?: string,
  ): Promise<void> {
    try {
      await this.prisma.notificationLog.create({
        data: {
          toEmail: message.to,
          toUserId: meta.toUserId ?? undefined,
          subject: message.subject,
          type: meta.type ?? 'other',
          reviewTaskId: meta.reviewTaskId ?? undefined,
          status: ok ? 'sent' : 'failed',
          // Keep the log row lean and avoid persisting anything sensitive.
          error: error ? error.slice(0, 500) : undefined,
        },
      });
    } catch (err) {
      this.logger.warn(`Failed to record notification log: ${String(err)}`);
    }
  }

  /** Branded self-service password-reset email carrying a single-use link. */
  async sendPasswordReset(to: string, name: string, resetUrl: string): Promise<boolean> {
    const subject = 'Reset your PolicyManager password';
    const safeName = escapeHtml(name || 'there');
    const html = layout(
      subject,
      `<p>Hi ${safeName},</p>
       <p>We received a request to reset your PolicyManager password. Click the button below to choose a new one. This link expires in 30 minutes and can be used once.</p>
       <p style="margin:24px 0;">
         <a href="${resetUrl}" style="background:#4f46e5;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block;">Reset password</a>
       </p>
       <p style="color:#6b7280;font-size:13px;">If the button does not work, paste this link into your browser:<br>${resetUrl}</p>
       <p style="color:#6b7280;font-size:13px;">If you did not request this, you can safely ignore this email — your password will not change.</p>`,
    );
    const text = `Hi ${name || 'there'},

Reset your PolicyManager password using this link (expires in 30 minutes, single use):
${resetUrl}

If you did not request this, ignore this email.`;
    return this.send({ to, subject, html, text }, { type: 'password_reset' });
  }

  /** Security notice sent when an account is locked by repeated failed logins. */
  async sendAccountLocked(to: string, name: string): Promise<boolean> {
    const subject = 'Your PolicyManager account has been locked';
    const safeName = escapeHtml(name || 'there');
    const html = layout(
      subject,
      `<p>Hi ${safeName},</p>
       <p>Your PolicyManager account was temporarily locked after several failed sign-in attempts. For your security, sign-in is disabled for a short period.</p>
       <p>You can wait for the lock to expire, reset your password, or contact your administrator if you need immediate access.</p>
       <p style="color:#6b7280;font-size:13px;">If this was not you, please reset your password and notify your administrator.</p>`,
    );
    const text = `Hi ${name || 'there'},

Your PolicyManager account was temporarily locked after several failed sign-in attempts.
Wait for the lock to expire, reset your password, or contact your administrator.

If this was not you, reset your password and notify your administrator.`;
    return this.send({ to, subject, html, text }, { type: 'account_locked' });
  }

  /**
   * Review-reminder email raised by the QC sweep when a document is coming due.
   * `overdue` switches copy + the logged notification type. `reviewUrl` deep-links
   * the reviewer to the document. Logs against the raising `reviewTaskId`/user.
   */
  async sendReviewReminder(args: {
    to: string;
    name: string;
    documentTitle: string;
    dueDate: Date;
    reviewUrl: string;
    overdue?: boolean;
    toUserId?: string | null;
    reviewTaskId?: string | null;
  }): Promise<boolean> {
    const due = args.dueDate.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
    const subject = args.overdue
      ? `Overdue review: ${args.documentTitle}`
      : `Review due ${due}: ${args.documentTitle}`;
    const safeName = escapeHtml(args.name || 'there');
    const safeTitle = escapeHtml(args.documentTitle);
    const lead = args.overdue
      ? `The review for the document below is <strong>overdue</strong> (was due ${escapeHtml(due)}). Please review it as soon as possible.`
      : `A document assigned to you is due for review on <strong>${escapeHtml(due)}</strong>. Please complete your review before then.`;
    const html = layout(
      subject,
      `<p>Hi ${safeName},</p>
       <p>${lead}</p>
       <p style="margin:16px 0;font-size:15px;"><strong>${safeTitle}</strong></p>
       <p style="margin:24px 0;">
         <a href="${args.reviewUrl}" style="background:#4f46e5;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block;">Open document</a>
       </p>
       <p style="color:#6b7280;font-size:13px;">If the button does not work, paste this link into your browser:<br>${args.reviewUrl}</p>`,
    );
    const text = `Hi ${args.name || 'there'},

${args.overdue ? `OVERDUE review (was due ${due})` : `Review due ${due}`}: ${args.documentTitle}

Open the document to complete your review:
${args.reviewUrl}`;
    return this.send(
      { to: args.to, subject, html, text },
      {
        type: args.overdue ? 'review_overdue' : 'review_reminder',
        toUserId: args.toUserId,
        reviewTaskId: args.reviewTaskId,
      },
    );
  }
}

/** Minimal responsive email shell so both messages look consistent. */
function layout(title: string, body: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f8fafc;font-family:Segoe UI,Arial,sans-serif;">
    <div style="max-width:520px;margin:0 auto;padding:24px;">
      <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:28px;color:#0f172a;">
        <div style="font-weight:700;font-size:18px;margin-bottom:8px;">PolicyManager</div>
        <div style="font-size:14px;line-height:1.6;">${body}</div>
      </div>
      <div style="text-align:center;color:#94a3b8;font-size:12px;margin-top:16px;">${escapeHtml(title)}</div>
    </div>
  </body></html>`;
}

/** Escapes user-supplied values before interpolating into HTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Crude HTML->text fallback for the plain-text part when a caller omits it. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
