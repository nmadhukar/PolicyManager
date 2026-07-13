import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StorageAdminPage } from './StorageAdminPage';

const mockHasPermission = vi.fn();
const mockGetConfig = vi.fn();
const mockListBuckets = vi.fn();
const mockCreateBucket = vi.fn();
const mockListPrefixes = vi.fn();
const mockCreatePrefix = vi.fn();

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'a@b.com', name: 'Admin', roles: ['Admin'], permissions: [], mustChangePassword: false },
    status: 'authenticated',
    login: vi.fn(),
    logout: vi.fn(),
    hasPermission: mockHasPermission,
  }),
}));

vi.mock('../api/storage', () => ({
  getStorageConfig: (...a: unknown[]) => mockGetConfig(...a),
  listBuckets: (...a: unknown[]) => mockListBuckets(...a),
  createBucket: (...a: unknown[]) => mockCreateBucket(...a),
  listPrefixes: (...a: unknown[]) => mockListPrefixes(...a),
  createPrefix: (...a: unknown[]) => mockCreatePrefix(...a),
}));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <StorageAdminPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const config = {
  bucket: 'policymanager-docs',
  prefixes: { documents: 'documents/', renditions: 'renditions/' },
  endpoint: 'http://localhost:9000',
  region: 'us-east-2',
};

describe('StorageAdminPage', () => {
  beforeEach(() => {
    mockHasPermission.mockReset();
    mockGetConfig.mockReset().mockResolvedValue(config);
    mockListBuckets
      .mockReset()
      .mockResolvedValue([{ name: 'policymanager-docs', createdAt: null, isDefault: true }]);
    mockCreateBucket.mockReset().mockResolvedValue({ name: 'archive', createdAt: null, isDefault: false });
    mockListPrefixes.mockReset().mockResolvedValue([{ prefix: 'policies/' }]);
    mockCreatePrefix.mockReset().mockResolvedValue({ prefix: 'intake/' });
  });

  it('shows the forbidden state without storage.manage', async () => {
    mockHasPermission.mockReturnValue(false);
    renderPage();
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(mockListBuckets).not.toHaveBeenCalled();
  });

  it('lists buckets, config, and the selected bucket folders', async () => {
    mockHasPermission.mockReturnValue(true);
    renderPage();

    // Config surfaced.
    await waitFor(() => expect(screen.getByText('Configuration')).toBeInTheDocument());
    expect(screen.getByText('documents/')).toBeInTheDocument();

    // Bucket list + default badge.
    expect(screen.getByRole('button', { name: /policymanager-docs/i })).toBeInTheDocument();
    expect(screen.getByText('Default')).toBeInTheDocument();

    // Folders of the default (active) bucket.
    await waitFor(() => expect(screen.getByText('policies/')).toBeInTheDocument());
    expect(mockListPrefixes).toHaveBeenCalledWith('policymanager-docs');
  });

  it('creates a bucket after confirmation', async () => {
    mockHasPermission.mockReturnValue(true);
    renderPage();
    await waitFor(() => expect(screen.getByText('Configuration')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'New bucket' }));
    const nameInput = screen.getByLabelText('Bucket name');
    fireEvent.change(nameInput, { target: { value: 'archive-2026' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    // Confirms before creating.
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Create bucket?')).toBeInTheDocument();
    expect(mockCreateBucket).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Create bucket' }));
    await waitFor(() => expect(mockCreateBucket).toHaveBeenCalledWith('archive-2026'));
  });

  it('rejects a too-short bucket name client-side (no confirm, no API call)', async () => {
    mockHasPermission.mockReturnValue(true);
    renderPage();
    await waitFor(() => expect(screen.getByText('Configuration')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'New bucket' }));
    fireEvent.change(screen.getByLabelText('Bucket name'), { target: { value: 'ab' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByText(/at least 3 characters/i)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockCreateBucket).not.toHaveBeenCalled();
  });

  it('creates a folder in the active bucket', async () => {
    mockHasPermission.mockReturnValue(true);
    renderPage();
    await waitFor(() => expect(screen.getByText('policies/')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('New folder'), { target: { value: 'intake' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add folder' }));
    await waitFor(() => expect(mockCreatePrefix).toHaveBeenCalledWith('policymanager-docs', 'intake'));
  });
});
