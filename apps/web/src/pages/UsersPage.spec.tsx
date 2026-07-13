import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import { PERMISSIONS } from '@policymanager/shared';
import type { AuthUser } from '@policymanager/shared';
import { UsersPage } from './UsersPage';
import * as usersApi from '../api/users';
import type { AuthContextValue } from '../auth/AuthContext';

/** UserView factory for list fixtures. */
function makeUser(overrides: Partial<usersApi.UserView> = {}): usersApi.UserView {
  return {
    id: 'u2',
    email: 'jane@x.com',
    name: 'Jane Doe',
    title: null,
    status: 'active',
    roles: ['Manager'],
    mustChangePassword: false,
    lockedUntil: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

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
    mustChangePassword: false,
  };
  return {
    user,
    status: 'authenticated',
    login: vi.fn(),
    logout: vi.fn(),
    changePassword: vi.fn(),
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
        mustChangePassword: false,
        lockedUntil: null,
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

  it('offers reset / lock / disable actions for another user', async () => {
    mockAuth.mockReturnValue(baseAuth([PERMISSIONS.USER_MANAGE])); // current admin is u1
    vi.spyOn(usersApi, 'listUsers').mockResolvedValue([makeUser({ id: 'u2' })]);
    vi.spyOn(usersApi, 'listRoles').mockResolvedValue([]);

    renderPage();
    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Reset password' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Lock' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Disable' })).toBeEnabled();
  });

  it('disables self-destructive actions on the admin\'s OWN row', async () => {
    mockAuth.mockReturnValue(baseAuth([PERMISSIONS.USER_MANAGE])); // current admin is u1
    // Own row: id matches the authed user (u1); email is unique to the row so the
    // wait does not race the same name shown in the app-shell header.
    vi.spyOn(usersApi, 'listUsers').mockResolvedValue([
      makeUser({ id: 'u1', name: 'Ada Admin', email: 'self@x.com' }),
    ]);
    vi.spyOn(usersApi, 'listRoles').mockResolvedValue([]);

    renderPage();
    await waitFor(() => expect(screen.getByText('self@x.com')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Disable' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Lock' })).toBeDisabled();
    // Reset is still allowed on your own account.
    expect(screen.getByRole('button', { name: 'Reset password' })).toBeEnabled();
  });

  it('shows an Unlock action for a locked user', async () => {
    mockAuth.mockReturnValue(baseAuth([PERMISSIONS.USER_MANAGE]));
    const future = new Date(Date.now() + 3_600_000).toISOString();
    vi.spyOn(usersApi, 'listUsers').mockResolvedValue([
      makeUser({ id: 'u2', lockedUntil: future }),
    ]);
    vi.spyOn(usersApi, 'listRoles').mockResolvedValue([]);

    renderPage();
    await waitFor(() => expect(screen.getByText('Locked')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeInTheDocument();
  });

  it('opens the reset dialog with temp / email choices', async () => {
    mockAuth.mockReturnValue(baseAuth([PERMISSIONS.USER_MANAGE]));
    vi.spyOn(usersApi, 'listUsers').mockResolvedValue([makeUser({ id: 'u2' })]);
    vi.spyOn(usersApi, 'listRoles').mockResolvedValue([]);

    renderPage();
    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /set a temporary password/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /email a reset link/i })).toBeInTheDocument();
  });
});
