import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import type { AuthUser } from '@policymanager/shared';
import { ChangePasswordPage } from './ChangePasswordPage';
import type { AuthContextValue } from '../auth/AuthContext';

const mockAuth = vi.fn<() => AuthContextValue>();
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => mockAuth(),
}));

function authValue(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  const user: AuthUser = {
    id: 'u1',
    email: 'a@b.com',
    name: 'Ada Admin',
    roles: ['Admin'],
    permissions: [],
    mustChangePassword: false,
  };
  return {
    user,
    status: 'authenticated',
    login: vi.fn(),
    logout: vi.fn(),
    changePassword: vi.fn().mockResolvedValue(undefined),
    completeSsoLogin: vi.fn(),
    hasPermission: () => false,
    ...overrides,
  };
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ChangePasswordPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ChangePasswordPage', () => {
  afterEach(() => vi.restoreAllMocks());

  it('forces the change with a clear notice when mustChangePassword is set', () => {
    const user: AuthUser = {
      id: 'u1', email: 'a@b.com', name: 'Ada', roles: [], permissions: [], mustChangePassword: true,
    };
    mockAuth.mockReturnValue(authValue({ user }));
    renderPage();
    expect(screen.getByText(/required before you continue/i)).toBeInTheDocument();
    expect(screen.getByText(/must choose a new password/i)).toBeInTheDocument();
  });

  it('submits a valid change and shows a success confirmation', async () => {
    const changePassword = vi.fn().mockResolvedValue(undefined);
    mockAuth.mockReturnValue(authValue({ changePassword }));
    renderPage();

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'OldPass123' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'NewStr0ng' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'NewStr0ng' },
    });
    fireEvent.click(screen.getByRole('button', { name: /update password/i }));

    await waitFor(() => expect(changePassword).toHaveBeenCalledWith('OldPass123', 'NewStr0ng'));
    await waitFor(() =>
      expect(screen.getByText(/your password has been updated/i)).toBeInTheDocument(),
    );
  });

  it('blocks submit while the confirmation does not match', () => {
    const changePassword = vi.fn();
    mockAuth.mockReturnValue(authValue({ changePassword }));
    renderPage();

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'OldPass123' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'NewStr0ng' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'Mismatch1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /update password/i }));

    expect(changePassword).not.toHaveBeenCalled();
  });
});
