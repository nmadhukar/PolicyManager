import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EmailAdminPage } from './EmailAdminPage';

const mockHasPermission = vi.fn();
const mockGetConfig = vi.fn();
const mockUpdateConfig = vi.fn();
const mockSendTest = vi.fn();
const mockListNotifications = vi.fn();

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'a@b.com', name: 'Admin', roles: ['Admin'], permissions: [], mustChangePassword: false },
    status: 'authenticated',
    hasPermission: mockHasPermission,
  }),
}));

vi.mock('../api/smtp', () => ({
  getSmtpConfig: (...a: unknown[]) => mockGetConfig(...a),
  updateSmtpConfig: (...a: unknown[]) => mockUpdateConfig(...a),
  sendTestEmail: (...a: unknown[]) => mockSendTest(...a),
  listNotifications: (...a: unknown[]) => mockListNotifications(...a),
}));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <EmailAdminPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const config = {
  host: 'smtp.relay.example',
  port: 587,
  secure: true,
  username: 'relay-user',
  fromAddress: 'noreply@clinic.example',
  fromName: 'Clinic',
  enabled: true,
  hasPassword: true,
  updatedAt: '2026-07-01T00:00:00.000Z',
  source: 'db' as const,
};

describe('EmailAdminPage', () => {
  beforeEach(() => {
    mockHasPermission.mockReset().mockReturnValue(true);
    mockGetConfig.mockReset().mockResolvedValue(config);
    mockUpdateConfig.mockReset().mockResolvedValue(config);
    mockSendTest.mockReset().mockResolvedValue({ ok: true });
    mockListNotifications.mockReset().mockResolvedValue({
      items: [
        {
          id: 'n1',
          toEmail: 'x@y.z',
          toUserId: null,
          subject: 'Review due',
          type: 'review_reminder',
          reviewTaskId: 't1',
          status: 'sent',
          error: null,
          createdAt: '2026-07-02T00:00:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 25,
    });
  });

  it('shows the forbidden state without smtp.manage', async () => {
    mockHasPermission.mockReturnValue(false);
    renderPage();
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(mockGetConfig).not.toHaveBeenCalled();
  });

  it('loads config, shows the password as set, and NEVER renders a password value', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByDisplayValue('smtp.relay.example')).toBeInTheDocument());
    // Password status is shown as "set", not the value.
    expect(screen.getByText(/\(set\)/)).toBeInTheDocument();
    // There is no password input by default (write-only, behind "Change").
    expect(screen.queryByPlaceholderText(/New password/)).not.toBeInTheDocument();
    // The notification log rendered.
    expect(await screen.findByText('Review due')).toBeInTheDocument();
    expect(screen.getByText('sent')).toBeInTheDocument();
  });

  it('omits the password when saving without changing it', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByDisplayValue('smtp.relay.example')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'smtp.new.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(mockUpdateConfig).toHaveBeenCalled());
    const payload = mockUpdateConfig.mock.calls[0][0];
    expect(payload.host).toBe('smtp.new.example');
    // No password field is sent when it was not changed.
    expect('password' in payload).toBe(false);
  });

  it('sends the password only when the admin chooses to change it', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByDisplayValue('smtp.relay.example')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.change(screen.getByPlaceholderText(/New password/), { target: { value: 'brand-new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(mockUpdateConfig).toHaveBeenCalled());
    expect(mockUpdateConfig.mock.calls[0][0].password).toBe('brand-new');
  });

  it('sends a test email', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByDisplayValue('smtp.relay.example')).toBeInTheDocument());

    const testCard = screen.getByRole('form', { name: 'Send test email' });
    fireEvent.change(within(testCard).getByLabelText('Recipient'), {
      target: { value: 'me@clinic.example' },
    });
    fireEvent.click(within(testCard).getByRole('button', { name: 'Send test email' }));

    await waitFor(() => expect(mockSendTest).toHaveBeenCalledWith('me@clinic.example'));
    expect(await screen.findByText(/Test email sent/)).toBeInTheDocument();
  });
});
