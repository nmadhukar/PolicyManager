import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PERMISSIONS } from '@policymanager/shared';
import { DashboardPage } from './DashboardPage';

const mockHasPermission = vi.fn();

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 'u1',
      email: 'admin@example.com',
      name: 'Admin User',
      roles: ['Admin'],
      permissions: [
        'document.read',
        'document.write',
        'user.manage',
        'audit.read',
        'storage.manage',
        'smtp.manage',
        'api.manage',
      ],
      mustChangePassword: false,
    },
    status: 'authenticated',
    login: vi.fn(),
    logout: vi.fn(),
    hasPermission: mockHasPermission,
  }),
}));

function renderDashboard() {
  return render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );
}

describe('DashboardPage', () => {
  beforeEach(() => {
    mockHasPermission.mockImplementation((permission: string) =>
      [
        PERMISSIONS.DOCUMENT_READ,
        PERMISSIONS.DOCUMENT_WRITE,
        PERMISSIONS.USER_MANAGE,
        PERMISSIONS.AUDIT_READ,
        PERMISSIONS.STORAGE_MANAGE,
        PERMISSIONS.SMTP_MANAGE,
        PERMISSIONS.API_MANAGE,
      ].includes(permission as never),
    );
  });

  it('surfaces all implemented modules that the user can access', () => {
    renderDashboard();

    expect(screen.getByRole('link', { name: 'Open library' })).toHaveAttribute('href', '/library');
    expect(screen.getByRole('link', { name: 'Run import' })).toHaveAttribute('href', '/library/import');
    expect(screen.getByRole('link', { name: 'View reviews' })).toHaveAttribute('href', '/reviews');
    expect(screen.getByRole('link', { name: 'View acknowledgments' })).toHaveAttribute('href', '/acknowledgments');
    expect(screen.getByRole('link', { name: 'Manage users' })).toHaveAttribute('href', '/admin/users');
    expect(screen.getByRole('link', { name: 'Open audit log' })).toHaveAttribute('href', '/admin/audit');
    expect(screen.getByRole('link', { name: 'Manage storage' })).toHaveAttribute('href', '/admin/storage');
    expect(screen.getByRole('link', { name: 'Manage email' })).toHaveAttribute('href', '/admin/email');
    expect(screen.getByRole('link', { name: 'Manage API clients' })).toHaveAttribute('href', '/admin/api-clients');
  });

  it('does not expose permission-gated module links when permission is missing', () => {
    mockHasPermission.mockImplementation((permission: string) => permission === PERMISSIONS.DOCUMENT_READ);
    renderDashboard();

    expect(screen.getByRole('link', { name: 'Open library' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Run import' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Manage users' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Manage API clients' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View reviews' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View acknowledgments' })).toBeInTheDocument();
  });
});
