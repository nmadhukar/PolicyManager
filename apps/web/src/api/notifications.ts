import type {
  NotificationDigestRunResult,
  NotificationItem,
  NotificationPreferenceView,
  NotificationUnreadCount,
  Paginated,
  UpdateNotificationPreferencesInput,
} from '@policymanager/shared';
import { http } from './http';

export interface NotificationListParams {
  unreadOnly?: boolean;
  page?: number;
  pageSize?: number;
}

export async function listNotifications(
  params: NotificationListParams = {},
): Promise<Paginated<NotificationItem>> {
  const { data } = await http.get<Paginated<NotificationItem>>('/notifications', { params });
  return data;
}

export async function getUnreadNotificationCount(): Promise<NotificationUnreadCount> {
  const { data } = await http.get<NotificationUnreadCount>('/notifications/unread-count');
  return data;
}

export async function markNotificationRead(id: string): Promise<NotificationItem> {
  const { data } = await http.patch<NotificationItem>(`/notifications/${id}/read`);
  return data;
}

export async function markAllNotificationsRead(): Promise<{ updated: number }> {
  const { data } = await http.patch<{ updated: number }>('/notifications/read-all');
  return data;
}

export async function dismissNotification(id: string): Promise<void> {
  await http.delete(`/notifications/${id}`);
}

export async function getNotificationPreferences(): Promise<NotificationPreferenceView> {
  const { data } = await http.get<NotificationPreferenceView>('/notifications/preferences');
  return data;
}

export async function updateNotificationPreferences(
  input: UpdateNotificationPreferencesInput,
): Promise<NotificationPreferenceView> {
  const { data } = await http.patch<NotificationPreferenceView>(
    '/notifications/preferences',
    input,
  );
  return data;
}

export async function runNotificationDigest(): Promise<NotificationDigestRunResult> {
  const { data } = await http.post<NotificationDigestRunResult>('/notifications/digest/run');
  return data;
}
