import '@testing-library/jest-dom';
import { vi } from 'vitest';

vi.mock('../api/notifications', () => {
  const defaultPreferences = {
    inAppEnabled: true,
    emailDigestEnabled: false,
    digestFrequency: 'daily',
    digestTimeLocal: '08:00',
    timezone: 'America/New_York',
    typeOverrides: {},
    lastDigestSentAt: null,
  };

  return {
    listNotifications: async () => ({ items: [], total: 0 }),
    getUnreadNotificationCount: async () => ({ unread: 0 }),
    markNotificationRead: async (id: string) => ({
      id,
      type: 'review_assigned',
      title: 'Notification',
      body: 'Notification',
      priority: 'normal',
      entityType: null,
      entityId: null,
      documentId: null,
      documentVersionId: null,
      href: null,
      metadata: null,
      readAt: new Date().toISOString(),
      dismissedAt: null,
      createdAt: new Date().toISOString(),
      actorName: null,
    }),
    markAllNotificationsRead: async () => ({ updated: 0 }),
    dismissNotification: async () => undefined,
    getNotificationPreferences: async () => defaultPreferences,
    updateNotificationPreferences: async (input: object) => ({
      ...defaultPreferences,
      ...input,
    }),
    runNotificationDigest: async () => ({
      usersConsidered: 0,
      digestsSent: 0,
      failed: 0,
    }),
  };
});

vi.mock('../api/evidence', () => ({
  listEvidenceBinders: async () => [],
  exportEvidenceBinder: async () => new Blob(['evidence binder'], { type: 'application/zip' }),
}));

vi.mock('../api/documentCompare', () => ({
  compareVersions: async () => ({
    documentId: 'doc-1',
    documentTitle: 'Policy',
    fromVersionId: 'v1',
    toVersionId: 'v2',
    fromVersionNumber: 1,
    toVersionNumber: 2,
    textAvailable: true,
    warnings: [],
    summary: { added: 0, removed: 0, changed: 0, unchanged: 1 },
    metadataChanges: [],
    hunks: [{ type: 'unchanged', oldLine: 1, newLine: 1, oldText: 'Policy', newText: 'Policy' }],
  }),
  fetchComparePdf: async () => new Blob(['compare'], { type: 'application/pdf' }),
}));
