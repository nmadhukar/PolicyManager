import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LibraryPage } from './LibraryPage';
import { ToastProvider } from '../ui/Toast';

// vitest hoists vi.mock; factory-referenced vars must be prefixed with `mock`.
const mockHasPermission = vi.fn();
const mockListDocuments = vi.fn();
const mockSoftDelete = vi.fn();
const mockRestore = vi.fn();
const mockArchive = vi.fn();
const mockUnarchive = vi.fn();
const mockCreateCategory = vi.fn();
const mockListSavedSearches = vi.fn();

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

vi.mock('../api/documents', () => ({
  listDocuments: (...args: unknown[]) => mockListDocuments(...args),
  createDocument: vi.fn(),
  softDeleteDocument: (...args: unknown[]) => mockSoftDelete(...args),
  restoreDocument: (...args: unknown[]) => mockRestore(...args),
  archiveDocument: (...args: unknown[]) => mockArchive(...args),
  unarchiveDocument: (...args: unknown[]) => mockUnarchive(...args),
}));

vi.mock('../api/savedSearches', () => ({
  listSavedSearches: (...args: unknown[]) => mockListSavedSearches(...args),
  createSavedSearch: vi.fn(),
  runSavedSearch: vi.fn(),
  deleteSavedSearch: vi.fn(),
}));

/** Builds a one-row list payload with sensible soft-delete defaults. */
function oneDoc(over: Record<string, unknown> = {}) {
  return {
    items: [
      {
        id: 'doc-1',
        title: 'Seclusion & Restraint Policy',
        documentNumber: 'PP-042',
        categoryId: null,
        categoryName: 'Policies',
        ownerId: 'u1',
        ownerName: 'Admin User',
        status: 'published',
        accessLevel: 'restricted',
        tags: ['CARF'],
        reviewCadence: 'annual',
        nextReviewDate: '2026-09-01T00:00:00.000Z',
        effectiveDate: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        deletedAt: null,
        deletedByName: null,
        currentVersion: null,
        ...over,
      },
    ],
    total: 1,
    page: 1,
    pageSize: 20,
  };
}

vi.mock('../api/categories', () => ({
  listCategoryTree: vi.fn().mockResolvedValue([]),
  createCategory: (...args: unknown[]) => mockCreateCategory(...args),
  flattenCategories: () => [],
}));

// The owner filter reads the user directory when permitted; stub it to no-ops.
vi.mock('../api/users', () => ({
  listUsers: vi.fn().mockResolvedValue([]),
}));

function renderLibrary() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/library']}>
          <LibraryPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('LibraryPage', () => {
  beforeEach(() => {
    mockHasPermission.mockReset();
    mockListDocuments.mockReset();
    mockSoftDelete.mockReset().mockResolvedValue({});
    mockRestore.mockReset().mockResolvedValue({});
    mockArchive.mockReset().mockResolvedValue({});
    mockUnarchive.mockReset().mockResolvedValue({});
    mockCreateCategory.mockReset().mockResolvedValue({
      id: 'cat-1',
      name: 'Policies',
      parentId: null,
      description: null,
      children: [],
    });
    mockListSavedSearches.mockReset().mockResolvedValue([]);
  });

  it('shows the forbidden state when the user lacks document.read', () => {
    mockHasPermission.mockReturnValue(false);
    renderLibrary();
    expect(screen.getByText('Access denied')).toBeInTheDocument();
    expect(mockListDocuments).not.toHaveBeenCalled();
  });

  it('renders the empty state when the library has no documents', async () => {
    mockHasPermission.mockImplementation((key: string) => key === 'document.read');
    mockListDocuments.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    renderLibrary();
    await waitFor(() => expect(screen.getByText('No documents found')).toBeInTheDocument());
    expect(mockListDocuments).toHaveBeenCalled();
  });

  it('renders documents in a table with their status', async () => {
    mockHasPermission.mockImplementation((key: string) => key === 'document.read');
    mockListDocuments.mockResolvedValue({
      items: [
        {
          id: 'doc-1',
          title: 'Seclusion & Restraint Policy',
          documentNumber: 'PP-042',
          categoryId: null,
          categoryName: 'Policies',
          ownerId: 'u1',
          ownerName: 'Admin User',
          status: 'published',
          accessLevel: 'restricted',
          tags: ['CARF'],
          reviewCadence: 'annual',
          nextReviewDate: '2026-09-01T00:00:00.000Z',
          effectiveDate: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          currentVersion: null,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    renderLibrary();
    await waitFor(() =>
      expect(screen.getByText('Seclusion & Restraint Policy')).toBeInTheDocument(),
    );
    // The status filter <option> also reads "Published"; scope to the row badge.
    expect(screen.getByText('Published', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('PP-042')).toBeInTheDocument();
  });

  it('hides the Trash tab from users without document.write', async () => {
    mockHasPermission.mockImplementation((key: string) => key === 'document.read');
    mockListDocuments.mockResolvedValue(oneDoc());
    renderLibrary();
    await waitFor(() => expect(mockListDocuments).toHaveBeenCalled());
    expect(screen.queryByRole('tab', { name: 'Trash' })).not.toBeInTheDocument();
    // Row actions (write-only) must not render for read-only users.
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('switches to the Trash view and lists only soft-deleted documents', async () => {
    mockHasPermission.mockReturnValue(true); // read + write
    mockListDocuments.mockImplementation((params: { deleted?: boolean }) =>
      Promise.resolve(
        params.deleted
          ? oneDoc({ deletedAt: '2026-02-01T00:00:00.000Z', deletedByName: 'Admin User' })
          : oneDoc(),
      ),
    );
    renderLibrary();
    await waitFor(() => expect(screen.getByText('Seclusion & Restraint Policy')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('tab', { name: 'Trash' }));

    await waitFor(() =>
      expect(mockListDocuments).toHaveBeenCalledWith(expect.objectContaining({ deleted: true })),
    );
    // The trash row surfaces Restore and the Deleted badge, not Archive/Delete.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument());
    expect(screen.getByText('Deleted')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(mockRestore).toHaveBeenCalledWith('doc-1'));
  });

  it('soft-deletes a document from a row after confirmation', async () => {
    mockHasPermission.mockReturnValue(true);
    mockListDocuments.mockResolvedValue(oneDoc());
    renderLibrary();
    await waitFor(() => expect(screen.getByText('Seclusion & Restraint Policy')).toBeInTheDocument());

    // Active-view rows expose Archive + Delete for write users.
    expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    // A confirm dialog gates the destructive action (no immediate delete).
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Move to trash?')).toBeInTheDocument();
    expect(mockSoftDelete).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mockSoftDelete).toHaveBeenCalledWith('doc-1'));
  });

  it('archives a document from a row', async () => {
    mockHasPermission.mockReturnValue(true);
    mockListDocuments.mockResolvedValue(oneDoc());
    renderLibrary();
    await waitFor(() => expect(screen.getByText('Seclusion & Restraint Policy')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(mockArchive).toHaveBeenCalledWith('doc-1'));
  });

  it('surfaces an error toast when a row action fails (no silent failure)', async () => {
    mockHasPermission.mockReturnValue(true);
    mockListDocuments.mockResolvedValue(oneDoc());
    mockArchive.mockReset().mockRejectedValue({ response: { status: 500 } });
    renderLibrary();
    await waitFor(() => expect(screen.getByText('Seclusion & Restraint Policy')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Could not archive the document.'),
    );
  });
});
