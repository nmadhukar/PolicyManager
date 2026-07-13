import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiClientsPage } from './ApiClientsPage';

const mockHasPermission = vi.fn();
const mockList = vi.fn();
const mockCreate = vi.fn();
const mockRevoke = vi.fn();
const mockRotate = vi.fn();

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'a@b.com', name: 'Admin', roles: ['Admin'], permissions: [], mustChangePassword: false },
    status: 'authenticated',
    hasPermission: mockHasPermission,
  }),
}));

vi.mock('../api/apiClients', () => ({
  listApiClients: (...a: unknown[]) => mockList(...a),
  createApiClient: (...a: unknown[]) => mockCreate(...a),
  revokeApiClient: (...a: unknown[]) => mockRevoke(...a),
  rotateApiClientSecret: (...a: unknown[]) => mockRotate(...a),
}));

vi.mock('../api/categories', () => ({
  listCategoryTree: () => Promise.resolve([]),
  flattenCategories: () => [],
}));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ApiClientsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const client = {
  id: 'ac1',
  name: 'EMR Integration',
  clientId: 'pmk_abc123',
  scopes: ['documents:read', 'content:read'],
  allowedCategoryIds: [],
  enabled: true,
  createdAt: '2026-07-01T00:00:00.000Z',
  createdByName: 'Admin',
  lastUsedAt: null,
  revokedAt: null,
};

const secretResult = {
  client,
  secret: 'S3cr3t-value',
  credential: 'pmk_abc123.S3cr3t-value',
};

describe('ApiClientsPage', () => {
  beforeEach(() => {
    mockHasPermission.mockReset().mockReturnValue(true);
    mockList.mockReset().mockResolvedValue([client]);
    mockCreate.mockReset().mockResolvedValue(secretResult);
    mockRevoke.mockReset().mockResolvedValue({ ...client, enabled: false, revokedAt: '2026-07-02T00:00:00.000Z' });
    mockRotate.mockReset().mockResolvedValue(secretResult);
  });

  it('shows the forbidden state without api.manage (never calls the API)', async () => {
    mockHasPermission.mockReturnValue(false);
    renderPage();
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(mockList).not.toHaveBeenCalled();
  });

  it('lists clients with their client id, scopes, and status', async () => {
    renderPage();
    expect(await screen.findByText('EMR Integration')).toBeInTheDocument();
    expect(screen.getByText('pmk_abc123')).toBeInTheDocument();
    expect(screen.getByText('documents:read')).toBeInTheDocument();
    expect(screen.getByText('content:read')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('shows the empty state when there are no clients', async () => {
    mockList.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('No API clients yet')).toBeInTheDocument();
  });

  it('creates a client and reveals the secret exactly once', async () => {
    renderPage();
    await screen.findByText('EMR Integration');

    fireEvent.click(screen.getByRole('button', { name: 'New API client' }));
    const form = await screen.findByRole('form', { name: 'Create API client' });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'AI Bot' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create client' }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    const payload = mockCreate.mock.calls[0][0];
    expect(payload).toMatchObject({ name: 'AI Bot', scopes: ['documents:read'], allowedCategoryIds: [] });

    // The one-time secret reveal shows the ready-to-use credential + a warning.
    expect(await screen.findByText('Save this secret now')).toBeInTheDocument();
    expect(screen.getByTestId('api-credential')).toHaveTextContent('pmk_abc123.S3cr3t-value');
  });

  it('requires at least one scope', async () => {
    renderPage();
    await screen.findByText('EMR Integration');
    fireEvent.click(screen.getByRole('button', { name: 'New API client' }));
    const form = await screen.findByRole('form', { name: 'Create API client' });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'X' } });
    // Uncheck the default documents:read scope.
    fireEvent.click(within(form).getByRole('checkbox', { name: /documents:read/ }));
    fireEvent.click(within(form).getByRole('button', { name: 'Create client' }));

    expect(await screen.findByText('Select at least one scope.')).toBeInTheDocument();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('revokes a client after confirmation', async () => {
    renderPage();
    await screen.findByText('EMR Integration');

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Revoke API client?')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));

    await waitFor(() => expect(mockRevoke).toHaveBeenCalledWith('ac1'));
  });

  it('rotates a secret and reveals the new one', async () => {
    renderPage();
    await screen.findByText('EMR Integration');

    fireEvent.click(screen.getByRole('button', { name: 'Rotate secret' }));
    await waitFor(() => expect(mockRotate).toHaveBeenCalledWith('ac1'));
    expect(await screen.findByText('Save this secret now')).toBeInTheDocument();
  });
});
