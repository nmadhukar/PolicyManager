import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

/** A single outbound message. `text` is optional but recommended for deliverability. */
export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

/**
 * Reusable SMTP mailer (Phase 2 password flows now; review reminders in Phase 5).
 * Transport is env-driven (SMTP_*), so the same image talks to MailHog locally
 * and a real relay in production.
 *
 * DESIGN: `send` NEVER throws. Email is a best-effort side-channel — an SMTP
 * outage must not fail a password reset or a login. Callers get a boolean and
 * decide how to surface it; failures are logged for operability.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(private readonly config: ConfigService) {
    const host = this.config.get<string>('SMTP_HOST', 'localhost');
    const port = Number(this.config.get<string>('SMTP_PORT', '1025'));
    // Accept boolean or the string "true" from env.
    const secure = String(this.config.get('SMTP_SECURE', 'false')) === 'true';
    const user = this.config.get<string>('SMTP_USER', '');
    const pass = this.config.get<string>('SMTP_PASS', '');

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      // Only attach auth when credentials are configured (MailHog needs none).
      auth: user ? { user, pass } : undefined,
    });

    const fromAddress = this.config.get<string>('SMTP_FROM_ADDRESS', 'policymanager@example.com');
    const fromName = this.config.get<string>('SMTP_FROM_NAME', 'PolicyManager');
    this.from = `"${fromName}" <${fromAddress}>`;
  }

  /** Sends a message. Returns true on success, false if the transport failed. */
  async send(message: MailMessage): Promise<boolean> {
    try {
      await this.transporter.sendMail({
        from: this.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text ?? stripHtml(message.html),
      });
      return true;
    } catch (err) {
      // Do not rethrow: email is best-effort. Surface via the boolean + a log.
      this.logger.warn(`Failed to send "${message.subject}" to ${message.to}: ${String(err)}`);
      return false;
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
    return this.send({ to, subject, html, text });
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
    return this.send({ to, subject, html, text });
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
