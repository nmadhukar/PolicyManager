import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import { PERMISSIONS } from '@policymanager/shared';
import type { AuditEventItem, AuthUser, Paginated } from '@policymanager/shared';
import { AuditLogPage } from './AuditLogPage';
import * as auditApi from '../api/audit';
import type { AuthContextValue } from '../auth/AuthContext';

const mockAuth = vi.fn<() => AuthContextValue>();
vi.mock('../auth/AuthContext', () => ({ useAuth: () => mockAuth() }));

function baseAuth(permissions: string[]): AuthContextValue {
  const user: AuthUser = {
    id: 'u1',
    email: 'a@b.com',
    name: 'Ada Auditor',
    roles: ['Auditor'],
    permissions,
    mustChangePassword: false,
  };
  return {
    user,
    status: 'authenticated',
    login: vi.fn(),
    logout: vi.fn(),
    changePassword: vi.fn(),
    completeSsoLogin: vi.fn(),
    hasPermission: (key) => permissions.includes(key),
  };
}

function page(items: AuditEventItem[]): Paginated<AuditEventItem> {
  return { items, total: items.length, page: 1, pageSize: 25 };
}

function event(over: Partial<AuditEventItem> = {}): AuditEventItem {
  return {
    id: 'ae-1',
    action: 'document.downloaded',
    source: 'web',
    targetType: 'version',
    documentId: 'doc-1',
    documentTitle: 'Seclusion Policy',
    documentNumber: 'PP-42',
    versionId: 'v-1',
    actorUserId: 'u2',
    actorName: 'Jane Staff',
    actorEmail: 'jane@x.com',
    ipAddress: '10.0.0.5',
    userAgent: 'jest',
    metadata: null,
    createdAt: '2026-02-01T12:00:00.000Z',
    ...over,
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AuditLogPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AuditLogPage', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows the forbidden state without audit.read', () => {
    mockAuth.mockReturnValue(baseAuth([PERMISSIONS.DOCUMENT_READ]));
    renderPage();
    expect(screen.getByText('Access denied')).toBeInTheDocument();
  });

  it('renders the empty state when authorized with no events', async () => {
    mockAuth.mockReturnValue(baseAuth([PERMISSIONS.AUDIT_READ]));
    vi.spyOn(auditApi, 'listAudit').mockResolvedValue(page([]));
    renderPage();
    await waitFor(() => expect(screen.getByText('No audit events')).toBeInTheDocument());
  });

  it('lists events with actor, action label, and a document link', async () => {
    mockAuth.mockReturnValue(baseAuth([PERMISSIONS.AUDIT_READ]));
    vi.spyOn(auditApi, 'listAudit').mockResolvedValue(page([event()]));
    renderPage();

    await waitFor(() => expect(screen.getByText('Jane Staff')).toBeInTheDocument());
    // Scope to the table — the action label also appears as a filter <option>.
    const table = within(screen.getByRole('table'));
    // Friendly action label from the shared map.
    expect(table.getByText('Document downloaded')).toBeInTheDocument();
    // Document link points at the library detail route.
    const link = table.getByRole('link', { name: 'Seclusion Policy' });
    expect(link).toHaveAttribute('href', '/library/doc-1');
    expect(table.getByText('10.0.0.5')).toBeInTheDocument();
  });

  it('Export CSV fetches ALL pages for the active filter, not just the page on screen', async () => {
    mockAuth.mockReturnValue(baseAuth([PERMISSIONS.AUDIT_READ]));

    const many = (n: number, offset = 0): AuditEventItem[] =>
      Array.from({ length: n }, (_, i) => event({ id: `ae-${offset + i}` }));

    // Display query uses pageSize 25; the export sweep uses a larger pageSize and
    // must walk every page (250 rows here → two export pages).
    vi.spyOn(auditApi, 'listAudit').mockImplementation(async (p) => {
      if ((p.pageSize ?? 0) >= 200) {
        return p.page === 1
          ? { items: many(200, 0), total: 250, page: 1, pageSize: 200 }
          : { items: many(50, 200), total: 250, page: 2, pageSize: 200 };
      }
      return { items: many(25), total: 250, page: 1, pageSize: 25 };
    });

    const created: unknown[] = [];
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    const origClick = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = vi.fn((b: Blob) => {
      created.push(b);
      return 'blob:mock';
    }) as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
    // Stop the hidden-anchor click from attempting a jsdom navigation.
    HTMLAnchorElement.prototype.click = vi.fn();

    try {
      renderPage();
      await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));

      // Proves it paged past the on-screen page to gather the full set.
      await waitFor(() =>
        expect(auditApi.listAudit).toHaveBeenCalledWith(
          expect.objectContaining({ page: 2, pageSize: 200 }),
        ),
      );
      // Exactly one combined CSV file is produced from all fetched pages.
      await waitFor(() => expect(created).toHaveLength(1));
      expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1);
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
      HTMLAnchorElement.prototype.click = origClick;
    }
  });

  it('shows "System" for actor-less events (e.g. failed login)', async () => {
    mockAuth.mockReturnValue(baseAuth([PERMISSIONS.AUDIT_READ]));
    vi.spyOn(auditApi, 'listAudit').mockResolvedValue(
      page([
        event({
          id: 'ae-2',
          action: 'user.login_failed',
          actorName: null,
          actorEmail: null,
          documentId: null,
          documentTitle: null,
          documentNumber: null,
        }),
      ]),
    );
    renderPage();
    // Actor-less events (system/failed-login) render "System" in the actor cell.
    await waitFor(() => expect(screen.getByText('System')).toBeInTheDocument());
  });
});
