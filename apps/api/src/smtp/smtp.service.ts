import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  AUDIT_ACTIONS,
  type AuthUser,
  type NotificationLogItem,
  type NotificationStatus,
  type Paginated,
  type SmtpConfigView,
  type UpdateSmtpConfigInput,
} from '@policymanager/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { RequestContext } from '../audit/request-context';
import { MailService } from '../mail/mail.service';
import { encryptSecret } from '../common/crypto.util';

const SINGLETON_ID = 'default';
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;

/** Filters for the notification-log listing. */
export interface ListNotificationsQuery {
  type?: string;
  status?: NotificationStatus;
  page?: number;
  pageSize?: number;
}

/**
 * SMTP admin service (PM-0507, gated by `smtp.manage`). Owns the singleton
 * {@link SmtpConfig} row and the notification-delivery log.
 *
 * SECURITY (AGENTS.md §8): the SMTP password is stored ONLY as AES-256-GCM
 * ciphertext (see {@link encryptSecret}) and is NEVER returned by any read path or
 * written to the audit trail — `getConfig` exposes only a `hasPassword` flag.
 */
@Injectable()
export class SmtpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  private encryptionKey(): string {
    return this.config.get<string>('APP_ENCRYPTION_KEY', 'change-me-app-encryption-key');
  }

  /**
   * Returns the effective SMTP settings for the admin UI. A saved DB row (source
   * `db`) wins; otherwise the SMTP_* env fallback (source `env`). The password is
   * never included — only `hasPassword` indicates whether one is set.
   */
  async getConfig(): Promise<SmtpConfigView> {
    const row = await this.prisma.smtpConfig.findFirst({ where: { id: SINGLETON_ID } });
    if (row) {
      return {
        host: row.host,
        port: row.port,
        secure: row.secure,
        username: row.username ?? null,
        fromAddress: row.fromAddress,
        fromName: row.fromName,
        enabled: row.enabled,
        hasPassword: !!row.passwordEncrypted,
        updatedAt: row.updatedAt.toISOString(),
        source: 'db',
      };
    }
    return {
      host: this.config.get<string>('SMTP_HOST', 'localhost'),
      port: Number(this.config.get<string>('SMTP_PORT', '1025')),
      secure: String(this.config.get('SMTP_SECURE', 'false')) === 'true',
      username: this.config.get<string>('SMTP_USER', '') || null,
      fromAddress: this.config.get<string>('SMTP_FROM_ADDRESS', 'policymanager@example.com'),
      fromName: this.config.get<string>('SMTP_FROM_NAME', 'PolicyManager'),
      enabled: false,
      hasPassword: !!this.config.get<string>('SMTP_PASS', ''),
      updatedAt: null,
      source: 'env',
    };
  }

  /**
   * Upserts the singleton config. Password handling: omitted keeps the stored
   * password, empty string clears it, a value is encrypted at rest. Writes a
   * `smtp.config_changed` audit event WITHOUT the password. Returns the redacted view.
   */
  async updateConfig(
    dto: UpdateSmtpConfigInput,
    user: AuthUser,
    ctx: RequestContext = {},
  ): Promise<SmtpConfigView> {
    // Undefined => leave the stored password untouched; '' => clear; value => encrypt.
    let passwordEncrypted: string | null | undefined;
    if (dto.password === undefined) passwordEncrypted = undefined;
    else if (dto.password === '') passwordEncrypted = null;
    else passwordEncrypted = encryptSecret(dto.password, this.encryptionKey());

    const base = {
      host: dto.host,
      port: dto.port,
      secure: dto.secure,
      username: dto.username ?? null,
      fromAddress: dto.fromAddress,
      fromName: dto.fromName,
      enabled: dto.enabled,
      updatedById: user.id,
    };

    await this.prisma.smtpConfig.upsert({
      where: { id: SINGLETON_ID },
      create: {
        id: SINGLETON_ID,
        ...base,
        // On first create, undefined (keep) collapses to "no password set".
        passwordEncrypted: passwordEncrypted ?? null,
      },
      // Only touch passwordEncrypted when the caller sent a password field.
      update: {
        ...base,
        ...(passwordEncrypted !== undefined ? { passwordEncrypted } : {}),
      },
    });

    await this.audit.record({
      action: AUDIT_ACTIONS.SMTP_CONFIG_CHANGED,
      actorUserId: user.id,
      targetType: 'smtp',
      ...ctx,
      // NEVER include the password here — only whether it changed.
      metadata: {
        host: dto.host,
        port: dto.port,
        secure: dto.secure,
        enabled: dto.enabled,
        passwordChanged: dto.password !== undefined,
      },
    });

    return this.getConfig();
  }

  /**
   * Sends a test email through the effective config (MailService resolves DB-vs-env
   * and logs a NotificationLog row). Audited as `smtp.test_sent`. Returns the send
   * outcome so the admin UI can surface success/failure without exposing internals.
   */
  async sendTest(
    to: string,
    user: AuthUser,
    ctx: RequestContext = {},
  ): Promise<{ ok: boolean }> {
    const ok = await this.mail.send(
      {
        to,
        subject: 'PolicyManager SMTP test',
        html: `<!doctype html><html><body style="font-family:Segoe UI,Arial,sans-serif;color:#0f172a;">
          <p><strong>PolicyManager</strong></p>
          <p>This is a test email confirming your SMTP settings are working.</p>
          <p style="color:#6b7280;font-size:13px;">If you received this, outbound email is configured correctly.</p>
        </body></html>`,
        text: 'PolicyManager SMTP test — if you received this, outbound email is configured correctly.',
      },
      { type: 'smtp_test', toUserId: user.id },
    );

    await this.audit.record({
      action: AUDIT_ACTIONS.SMTP_TEST_SENT,
      actorUserId: user.id,
      targetType: 'smtp',
      ...ctx,
      metadata: { to, ok },
    });

    return { ok };
  }

  /** Paginated, newest-first notification delivery log for the admin UI. */
  async listNotifications(
    query: ListNotificationsQuery,
  ): Promise<Paginated<NotificationLogItem>> {
    const page = Math.max(Math.trunc(query.page ?? 1), 1);
    const pageSize = Math.min(
      Math.max(Math.trunc(query.pageSize ?? DEFAULT_PAGE_SIZE), 1),
      MAX_PAGE_SIZE,
    );

    const where: Prisma.NotificationLogWhereInput = {};
    if (query.type) where.type = query.type;
    if (query.status) where.status = query.status;

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.notificationLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.notificationLog.count({ where }),
    ]);

    return {
      items: rows.map((r) => this.toItem(r)),
      total,
      page,
      pageSize,
    };
  }

  private toItem(row: {
    id: string;
    toEmail: string;
    toUserId: string | null;
    subject: string;
    type: string;
    reviewTaskId: string | null;
    status: string;
    error: string | null;
    createdAt: Date;
  }): NotificationLogItem {
    return {
      id: row.id,
      toEmail: row.toEmail,
      toUserId: row.toUserId,
      subject: row.subject,
      type: row.type,
      reviewTaskId: row.reviewTaskId,
      status: row.status as NotificationStatus,
      error: row.error,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
