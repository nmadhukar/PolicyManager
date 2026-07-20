import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DocumentDetailPage } from './DocumentDetailPage';

const mockHasPermission = vi.fn();
const mockGetDocument = vi.fn();
const mockGetEditorConfig = vi.fn();

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
  getEditorConfig: (...a: unknown[]) => mockGetEditorConfig(...a),
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

vi.mock('../ui/DocumentViewer', () => ({
  default: () => <div data-testid="viewer-stub" />,
}));
vi.mock('../ui/TipTapEditor', () => ({
  default: () => <div data-testid="tiptap-stub" />,
}));
// OnlyOfficeEditor is deliberately NOT mocked here — FINDING-016 lives inside
// its own mount effect (dependent on the `onClose` prop identity), so the
// regression can only be observed against the real component.

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
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/library/doc-1']}>
        <DocumentDetailPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return qc;
}

describe('FINDING-016: OnlyOffice editor survives unrelated document re-fetches', () => {
  let destroyEditor: ReturnType<typeof vi.fn>;
  let createCount: number;

  beforeEach(() => {
    mockHasPermission.mockReset();
    mockGetDocument.mockReset();
    mockGetEditorConfig.mockReset();
    mockGetEditorConfig.mockResolvedValue({ document: { key: 'k1' } });
    destroyEditor = vi.fn();
    createCount = 0;
    window.DocsAPI = {
      DocEditor: vi.fn().mockImplementation(() => {
        createCount += 1;
        return { destroyEditor };
      }),
    };
  });

  afterEach(() => {
    delete (window as { DocsAPI?: unknown }).DocsAPI;
  });

  it('does not destroy/recreate the live editor session when `doc` is replaced by an unrelated refetch', async () => {
    mockHasPermission.mockReturnValue(true);
    mockGetDocument.mockResolvedValueOnce(detail());
    const qc = renderPage();
    await waitFor(() => expect(screen.getByText('Version history')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Edit in OnlyOffice' }));
    await waitFor(() => expect(createCount).toBe(1));

    // Simulate an unrelated invalidation of ['document', doc.id] — e.g. the
    // savingBaseline poll, or an edit made from a sibling panel. The refetch
    // changes a field VersionsCard doesn't read (title) so React Query's
    // structural sharing can't reuse the previous object reference — this is
    // what actually forces `doc` (and therefore any inline closure over it) to
    // change identity on the next render.
    mockGetDocument.mockResolvedValueOnce(detail({ title: 'Seclusion Policy (edited elsewhere)' }));
    await qc.invalidateQueries({ queryKey: ['document', 'doc-1'] });
    await waitFor(() => expect(mockGetDocument).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Seclusion Policy (edited elsewhere)' })).toBeInTheDocument(),
    );

    // Give any (incorrect) re-mount effect a tick to fire before asserting it didn't.
    await new Promise((r) => setTimeout(r, 0));
    expect(destroyEditor).not.toHaveBeenCalled();
    expect(createCount).toBe(1);
  });
});
