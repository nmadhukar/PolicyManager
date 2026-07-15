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
const mockUpdateDocument = vi.fn();
const mockUpdateReviewSchedule = vi.fn();
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
  updateDocument: (...args: unknown[]) => mockUpdateDocument(...args),
  updateReviewSchedule: (...args: unknown[]) => mockUpdateReviewSchedule(...args),
  uploadVersion: vi.fn(),
  UPLOAD_ACCEPT: '.pdf,.docx',
}));

vi.mock('../api/categories', () => ({
  listCategoryTree: vi.fn().mockResolvedValue([]),
  createCategory: vi.fn(),
  flattenCategories: () => [],
}));

// Version-compare modal reads; each test that opens the modal sets its own
// resolved value on mockCompareVersions.
const mockCompareVersions = vi.fn();
vi.mock('../api/documentCompare', () => ({
  compareVersions: (...args: unknown[]) => mockCompareVersions(...args),
  fetchComparePdf: vi.fn(),
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
    mockUpdateDocument.mockReset().mockResolvedValue({});
    mockUpdateReviewSchedule.mockReset().mockResolvedValue({});
    mockCompareVersions.mockReset();
    mockNavigate.mockReset();
  });

  it('offers a version Restore (in the overflow menu) that confirms then calls restoreVersion', async () => {
    mockHasPermission.mockReturnValue(true);
    mockGetDocument.mockResolvedValue(detail());
    renderDetail();
    await waitFor(() => expect(screen.getByText('Version history')).toBeInTheDocument());

    // Restore lives in the per-row "More actions" (⋯) overflow menu now.
    // The current version (v2) has no overflow menu (only View + Download inline);
    // the older v1 does — so there is exactly one "More actions" trigger.
    const moreButtons = screen.getAllByRole('button', { name: 'More actions' });
    expect(moreButtons).toHaveLength(1);
    fireEvent.click(moreButtons[0]);

    fireEvent.click(screen.getByRole('menuitem', { name: 'Restore' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Restore v1?')).toBeInTheDocument();
    expect(mockRestoreVersion).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore version' }));
    await waitFor(() => expect(mockRestoreVersion).toHaveBeenCalledWith('doc-1', 'v-1'));
  });

  it('keeps View + Download inline and collapses Restore/Compare into a per-row overflow menu', async () => {
    mockHasPermission.mockReturnValue(true);
    mockGetDocument.mockResolvedValue(detail());
    renderDetail();
    await waitFor(() => expect(screen.getByText('Version history')).toBeInTheDocument());

    // Primary actions are inline for every row (2 versions -> 2 View + 2 Download).
    expect(screen.getAllByRole('button', { name: 'View' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Download' })).toHaveLength(2);

    // Secondary actions are NOT in the DOM until the overflow menu is opened.
    expect(screen.queryByRole('menuitem', { name: 'Restore' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Compare' })).toBeNull();

    // Only the non-current v1 row has overflow actions -> exactly one trigger.
    const moreButtons = screen.getAllByRole('button', { name: 'More actions' });
    expect(moreButtons).toHaveLength(1);
    fireEvent.click(moreButtons[0]);

    const menu = screen.getByRole('menu', { name: 'More version actions' });
    expect(within(menu).getByRole('menuitem', { name: 'Restore' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Compare' })).toBeInTheDocument();

    // Escape closes it.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'More version actions' })).not.toBeInTheDocument();
  });

  it('opens Version compare on the wide Modal card (no oversized inner wrapper) with wrapped checksum + a Close action', async () => {
    mockHasPermission.mockReturnValue(true);
    mockGetDocument.mockResolvedValue(detail());
    // A metadata change with two 64-char checksum hashes — the exact overflow case.
    mockCompareVersions.mockResolvedValue({
      documentId: 'doc-1',
      documentTitle: 'Seclusion & Restraint Policy',
      fromVersionId: 'v-1',
      toVersionId: 'v-2',
      fromVersionNumber: 1,
      toVersionNumber: 2,
      textAvailable: true,
      warnings: [],
      summary: { added: 0, removed: 0, changed: 1, unchanged: 3 },
      metadataChanges: [
        { field: 'checksum', label: 'Checksum', oldValue: 'a'.repeat(64), newValue: 'b'.repeat(64) },
      ],
      hunks: [
        { type: 'changed', oldLine: 1, newLine: 1, oldText: '<p>qwertyuio</p>', newText: '<p>qwertyuioqwertyj</p>' },
      ],
    });
    renderDetail();
    await waitFor(() => expect(screen.getByText('Version history')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Compare latest' }));
    const dialog = await screen.findByRole('dialog');

    // Width fix: it's on the shared Modal card (max-w-4xl), NOT a nested
    // w-[min(56rem,...)] wrapper that would overflow the card.
    expect(dialog).toHaveClass('max-w-4xl');
    expect(dialog.querySelector('[class*="min(56rem"]')).toBeNull();

    // The checksum value wraps instead of forcing horizontal overflow.
    const oldChecksum = await within(dialog).findByText('a'.repeat(64));
    expect(oldChecksum).toHaveClass('break-all', 'min-w-0');

    // A11y: a visible Close action exists (not just Escape/backdrop).
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument();
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

  it('updates the review schedule for a review manager without document.write', async () => {
    mockHasPermission.mockImplementation(
      (key: string) => key === 'document.read' || key === 'review.manage',
    );
    mockGetDocument.mockResolvedValue(detail({ reviewCadence: 'none', nextReviewDate: null }));
    renderDetail();
    await waitFor(() => expect(screen.getByText('Review schedule')).toBeInTheDocument());

    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit schedule' }));
    fireEvent.change(screen.getByLabelText('Cadence'), { target: { value: 'quarterly' } });
    fireEvent.change(screen.getByLabelText('Next review date'), {
      target: { value: '2026-10-01' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));

    await waitFor(() =>
      expect(mockUpdateReviewSchedule).toHaveBeenCalledWith('doc-1', {
        reviewCadence: 'quarterly',
        nextReviewDate: '2026-10-01',
      }),
    );
  });
});
