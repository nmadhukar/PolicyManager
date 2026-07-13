import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import { PERMISSIONS } from '@policymanager/shared';
import type { AuthUser } from '@policymanager/shared';
import { UsersPage } from './UsersPage';
import * as usersApi from '../api/users';
import type { AuthContextValue } from '../auth/AuthContext';

// Drive the RBAC UI purely through a mocked auth context.
const mockAuth = vi.fn<() => AuthContextValue>();
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => mockAuth(),
}));

function baseAuth(permissions: string[]): AuthContextValue {
  const user: AuthUser = {
    id: 'u1',
    email: 'a@b.com',
    name: 'Ada Admin',
    roles: ['Admin'],
    permissions,
  };
  return {
    user,
    status: 'authenticated',
    login: vi.fn(),
    logout: vi.fn(),
    hasPermission: (key) => permissions.includes(key),
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <UsersPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('UsersPage RBAC + states', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows the forbidden state when the user lacks user.manage', () => {
    mockAuth.mockReturnValue(baseAuth([PERMISSIONS.DOCUMENT_READ]));
    renderPage();
    expect(screen.getByText('Access denied')).toBeInTheDocument();
  });

  it('renders the empty state when authorized but there are no users', async () => {
    mockAuth.mockReturnValue(baseAuth([PERMISSIONS.USER_MANAGE]));
    vi.spyOn(usersApi, 'listUsers').mockResolvedValue([]);
    vi.spyOn(usersApi, 'listRoles').mockResolvedValue([]);

    renderPage();
    await waitFor(() => expect(screen.getByText('No users yet')).toBeInTheDocument());
  });

  it('lists users when authorized', async () => {
    mockAuth.mockReturnValue(baseAuth([PERMISSIONS.USER_MANAGE]));
    vi.spyOn(usersApi, 'listUsers').mockResolvedValue([
      {
        id: 'u1',
        email: 'jane@x.com',
        name: 'Jane Doe',
        title: null,
        status: 'active',
        roles: ['Manager'],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    vi.spyOn(usersApi, 'listRoles').mockResolvedValue([
      { id: 'r1', name: 'Manager', description: null, isSystem: true },
    ]);

    renderPage();
    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());
    expect(screen.getByText('jane@x.com')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });
});
