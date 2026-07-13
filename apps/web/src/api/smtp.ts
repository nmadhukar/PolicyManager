import type {
  NotificationLogItem,
  NotificationType,
  Paginated,
  SmtpConfigView,
  UpdateSmtpConfigInput,
} from '@policymanager/shared';
import { http } from './http';

export type { NotificationLogItem, SmtpConfigView } from '@policymanager/shared';

/** The effective SMTP config (never includes the password — only `hasPassword`). */
export async function getSmtpConfig(): Promise<SmtpConfigView> {
  const { data } = await http.get<SmtpConfigView>('/smtp/config');
  return data;
}

/** Upsert the SMTP config. Omit `password` to keep it; empty string clears it. */
export async function updateSmtpConfig(input: UpdateSmtpConfigInput): Promise<SmtpConfigView> {
  const { data } = await http.put<SmtpConfigView>('/smtp/config', input);
  return data;
}

/** Send a test email through the effective config. */
export async function sendTestEmail(to: string): Promise<{ ok: boolean }> {
  const { data } = await http.post<{ ok: boolean }>('/smtp/test', { to });
  return data;
}

/** Query parameters for the notification-delivery log. */
export interface NotificationListParams {
  type?: NotificationType;
  status?: 'sent' | 'failed';
  page?: number;
  pageSize?: number;
}

export async function listNotifications(
  params: NotificationListParams = {},
): Promise<Paginated<NotificationLogItem>> {
  const cleaned: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') cleaned[k] = v as string | number;
  }
  const { data } = await http.get<Paginated<NotificationLogItem>>('/smtp/notifications', {
    params: cleaned,
  });
  return data;
}
