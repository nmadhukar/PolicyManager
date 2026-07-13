import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DocumentDetailPage } from './DocumentDetailPage';

// vitest hoists vi.mock; factory-referenced vars must be prefixed with `mock`.
const mockHasPermission = vi.fn();
const mockGetDocument = vi.fn();
const mockArchive = vi.fn();
const mockUnarchive = vi.fn();
const mockSoftDelete = vi.fn();
const mockRestoreVersion = vi.fn();
const mockNavigate = vi.fn();

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 'u1',
      email: 'a@b.com',
      name: 'Admin User',
      roles: ['Admin'],
      permissions: [],
      mustChangePassword: false,
    },
    status: 'authenticated',
    login: vi.fn(),
    logout: vi.fn(),
    hasPermission: mockHasPermission,
  }),
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate, useParams: () => ({ id: 'doc-1' }) };
});

vi.mock('../api/documents', () => ({
  getDocument: (...args: unknown[]) => mockGetDocument(...args),
  archiveDocument: (...args: unknown[]) => mockArchive(...args),
  unarchiveDocument: (...args: unknown[]) => mockUnarchive(...args),
  softDeleteDocument: (...args: unknown[]) => mockSoftDelete(...args),
  restoreVersion: (...args: unknown[]) => mockRestoreVersion(...args),
  regenerateRendition: vi.fn(),
  getDownloadUrl: vi.fn(),
  updateDocument: vi.fn(),
  uploadVersion: vi.fn(),
}));

vi.mock('../api/categories', () => ({
  listCategoryTree: vi.fn().mockResolvedValue([]),
  flattenCategories: () => [],
}));

// The ACL panel (rendered for write users) pulls these; stub them to no-ops so
// these detail-page tests stay focused on lifecycle actions.
vi.mock('../api/acl', () => ({
  listAcl: vi.fn().mockResolvedValue([]),
  addAcl: vi.fn(),
  removeAcl: vi.fn(),
}));
vi.mock('../api/users', () => ({
  listRoles: vi.fn().mockResolvedValue([]),
  listUsers: vi.fn().mockResolvedValue([]),
}));
vi.mock('../api/reviews', () => ({
  listReviewers: vi.fn().mockResolvedValue([]),
  assignReviewer: vi.fn(),
  removeReviewer: vi.fn(),
}));
// Phase 6 sign-off / acknowledgment panels — stub their reads so these detail-page
// tests stay focused on lifecycle actions and never hit the network.
vi.mock('../api/signoff', () => ({
  listAttestations: vi.fn().mockResolvedValue([]),
  approveDocument: vi.fn(),
  distributeAcknowledgment: vi.fn(),
  getAcknowledgmentStatus: vi.fn().mockResolvedValue({
    documentId: 'doc-1',
    versionId: null,
    versionNumber: null,
    total: 0,
    completed: 0,
    pending: 0,
    overdue: 0,
    percentComplete: 100,
    rows: [],
  }),
  fetchCoverPage: vi.fn(),
  fetchExport: vi.fn(),
}));

function version(over: Record<string, unknown> = {}) {
  return {
    id: 'v-1',
    versionNumber: 1,
    fileName: 'v1.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 100,
    checksum: 'abc',
    changeSummary: null,
    status: 'draft',
    createdAt: '2026-01-01T00:00:00.000Z',
    uploadedByName: 'Admin User',
    hasExtractedText: true,
    hasRendition: true,
    ...over,
  };
}

function detail(over: Record<string, unknown> = {}) {
  const v2 = version({ id: 'v-2', versionNumber: 2 });
  return {
    id: 'doc-1',
    title: 'Seclusion & Restraint Policy',
    documentNumber: 'PP-042',
    categoryId: null,
    categoryName: null,
    ownerId: 'u1',
    ownerName: 'Admin User',
    status: 'published',
    accessLevel: 'restricted',
    tags: [],
    reviewCadence: 'annual',
    nextReviewDate: null,
    effectiveDate: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    deletedByName: null,
    description: null,
    currentVersion: v2,
    versions: [v2, version({ id: 'v-1', versionNumber: 1 })],
    ...over,
  };
}

function renderDetail() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/library/doc-1']}>
        <DocumentDetailPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DocumentDetailPage', () => {
  beforeEach(() => {
    mockHasPermission.mockReset();
    mockGetDocument.mockReset();
    mockArchive.mockReset().mockResolvedValue({});
    mockUnarchive.mockReset().mockResolvedValue({});
    mockSoftDelete.mockReset().mockResolvedValue({});
    mockRestoreVersion.mockReset().mockResolvedValue({});
    mockNavigate.mockReset();
  });

  it('offers a version Restore that confirms then calls restoreVersion for the chosen version', async () => {
    mockHasPermission.mockReturnValue(true);
    mockGetDocument.mockResolvedValue(detail());
    renderDetail();
    await waitFor(() => expect(screen.getByText('Version history')).toBeInTheDocument());

    // The current version (v2) has no Restore; the older v1 does.
    const restoreButtons = screen.getAllByRole('button', { name: 'Restore' });
    expect(restoreButtons).toHaveLength(1);

    fireEvent.click(restoreButtons[0]);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Restore v1?')).toBeInTheDocument();
    expect(mockRestoreVersion).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore version' }));
    await waitFor(() => expect(mockRestoreVersion).toHaveBeenCalledWith('doc-1', 'v-1'));
  });

  it('archives a published document from the header', async () => {
    mockHasPermission.mockReturnValue(true);
    mockGetDocument.mockResolvedValue(detail({ status: 'published' }));
    renderDetail();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(mockArchive).toHaveBeenCalledWith('doc-1'));
  });

  it('shows the archived notice + Unarchive for an archived document', async () => {
    mockHasPermission.mockReturnValue(true);
    mockGetDocument.mockResolvedValue(detail({ status: 'archived' }));
    renderDetail();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Unarchive' })).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/stays\s+accessible but is hidden from active lists/i),
    ).toBeInTheDocument();
  });

  it('soft-deletes after confirmation then navigates back to the library', async () => {
    mockHasPermission.mockReturnValue(true);
    mockGetDocument.mockResolvedValue(detail());
    renderDetail();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Move to trash?')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mockSoftDelete).toHaveBeenCalledWith('doc-1'));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/library'));
  });

  it('hides write-only actions from read-only users', async () => {
    mockHasPermission.mockImplementation((key: string) => key === 'document.read');
    mockGetDocument.mockResolvedValue(detail());
    renderDetail();
    await waitFor(() => expect(screen.getByText('Version history')).toBeInTheDocument());

    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument();
  });
});
