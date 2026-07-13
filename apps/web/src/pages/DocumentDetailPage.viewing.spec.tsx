import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DocumentDetailPage } from './DocumentDetailPage';

const mockHasPermission = vi.fn();
const mockGetDocument = vi.fn();

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'a@b.com', name: 'Admin', roles: ['Admin'], permissions: [], mustChangePassword: false },
    status: 'authenticated',
    login: vi.fn(),
    logout: vi.fn(),
    hasPermission: mockHasPermission,
  }),
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => vi.fn(), useParams: () => ({ id: 'doc-1' }) };
});

vi.mock('../api/documents', () => ({
  getDocument: (...a: unknown[]) => mockGetDocument(...a),
  archiveDocument: vi.fn(),
  unarchiveDocument: vi.fn(),
  softDeleteDocument: vi.fn(),
  restoreVersion: vi.fn(),
  regenerateRendition: vi.fn(),
  getDownloadUrl: vi.fn(),
  updateDocument: vi.fn(),
  uploadVersion: vi.fn(),
  UPLOAD_ACCEPT: '.pdf,.docx',
}));

vi.mock('../api/categories', () => ({
  listCategoryTree: vi.fn().mockResolvedValue([]),
  createCategory: vi.fn(),
  flattenCategories: () => [],
}));
// The acknowledgment panel may mount for broad permission mocks; keep its
// optional user-directory lookup isolated from real HTTP in viewing tests.
vi.mock('../api/users', () => ({
  listRoles: vi.fn().mockResolvedValue([]),
  listUsers: vi.fn().mockResolvedValue([]),
}));
vi.mock('../api/acl', () => ({
  addAcl: vi.fn(),
  listAcl: vi.fn().mockResolvedValue([]),
  removeAcl: vi.fn(),
}));
vi.mock('../api/reviews', () => ({
  assignReviewer: vi.fn(),
  listReviewers: vi.fn().mockResolvedValue([]),
  removeReviewer: vi.fn(),
}));
// Phase 6 sign-off / acknowledgment panels — stub their reads (no network in tests).
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

// Stub the heavy lazy surfaces so we test the page's gating/wiring, not pdf.js/OnlyOffice/TipTap.
vi.mock('../ui/DocumentViewer', () => ({
  default: ({ version }: { version: { fileName: string } }) => (
    <div data-testid="viewer-stub">Viewing {version.fileName}</div>
  ),
}));
vi.mock('../ui/OnlyOfficeEditor', () => ({
  default: () => <div data-testid="onlyoffice-stub">OnlyOffice editor</div>,
}));
vi.mock('../ui/TipTapEditor', () => ({
  default: ({ version }: { version?: { id: string } }) => (
    <div data-testid="tiptap-stub">{version ? 'Edit text' : 'New text'}</div>
  ),
}));

function version(over: Record<string, unknown> = {}) {
  return {
    id: 'v-1',
    versionNumber: 1,
    fileName: 'policy.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    sizeBytes: 100,
    checksum: 'abc',
    changeSummary: null,
    status: 'draft',
    createdAt: '2026-01-01T00:00:00.000Z',
    uploadedByName: 'Admin',
    hasExtractedText: true,
    hasRendition: true,
    ...over,
  };
}

function detail(over: Record<string, unknown> = {}) {
  const current = version(over.currentVersion as Record<string, unknown>);
  return {
    id: 'doc-1',
    title: 'Seclusion Policy',
    documentNumber: 'PP-1',
    categoryId: null,
    categoryName: null,
    ownerId: 'u1',
    ownerName: 'Admin',
    status: 'draft',
    accessLevel: 'restricted',
    tags: [],
    reviewCadence: 'none',
    nextReviewDate: null,
    effectiveDate: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    deletedByName: null,
    description: null,
    currentVersion: current,
    versions: [current],
    ...over,
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/library/doc-1']}>
        <DocumentDetailPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DocumentDetailPage viewing & editing affordances', () => {
  beforeEach(() => {
    mockHasPermission.mockReset();
    mockGetDocument.mockReset();
  });

  it('offers View and opens the read-only viewer (docx w/ rendition)', async () => {
    mockHasPermission.mockReturnValue(true);
    mockGetDocument.mockResolvedValue(detail());
    renderPage();
    await waitFor(() => expect(screen.getByText('Version history')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    expect(await screen.findByTestId('viewer-stub')).toHaveTextContent('policy.docx');
  });

  it('offers OnlyOffice editing for an editable Office current version (write users)', async () => {
    mockHasPermission.mockReturnValue(true);
    mockGetDocument.mockResolvedValue(detail());
    renderPage();
    await waitFor(() => expect(screen.getByText('Version history')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Edit in OnlyOffice' }));
    expect(await screen.findByTestId('onlyoffice-stub')).toBeInTheDocument();
  });

  it('offers the TipTap editor for a native HTML current version', async () => {
    mockHasPermission.mockReturnValue(true);
    mockGetDocument.mockResolvedValue(
      detail({ currentVersion: { fileName: 'note.html', mimeType: 'text/html' } }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText('Version history')).toBeInTheDocument());

    // Office editor is not offered for HTML; the text editor is.
    expect(screen.queryByRole('button', { name: 'Edit in OnlyOffice' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit text' }));
    expect(await screen.findByTestId('tiptap-stub')).toHaveTextContent('Edit text');
  });

  it('lets write users start a New text document', async () => {
    mockHasPermission.mockReturnValue(true);
    mockGetDocument.mockResolvedValue(detail());
    renderPage();
    await waitFor(() => expect(screen.getByText('Version history')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'New text document' }));
    expect(await screen.findByTestId('tiptap-stub')).toHaveTextContent('New text');
  });

  it('view-only users can View but get NO editor affordances', async () => {
    mockHasPermission.mockImplementation((k: string) => k === 'document.read');
    mockGetDocument.mockResolvedValue(detail());
    renderPage();
    await waitFor(() => expect(screen.getByText('Version history')).toBeInTheDocument());

    // View is available to read-only users…
    expect(screen.getByRole('button', { name: 'View' })).toBeInTheDocument();
    // …but no editing surfaces are offered.
    expect(screen.queryByRole('button', { name: 'Edit in OnlyOffice' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit text' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New text document' })).not.toBeInTheDocument();
  });
});
