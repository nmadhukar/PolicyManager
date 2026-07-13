import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LibraryPage } from './LibraryPage';

// vitest hoists vi.mock; factory-referenced vars must be prefixed with `mock`.
const mockHasPermission = vi.fn();
const mockListDocuments = vi.fn();

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'a@b.com', name: 'Admin User', roles: ['Admin'], permissions: [] },
    status: 'authenticated',
    login: vi.fn(),
    logout: vi.fn(),
    hasPermission: mockHasPermission,
  }),
}));

vi.mock('../api/documents', () => ({
  listDocuments: (...args: unknown[]) => mockListDocuments(...args),
  createDocument: vi.fn(),
}));

vi.mock('../api/categories', () => ({
  listCategoryTree: vi.fn().mockResolvedValue([]),
  flattenCategories: () => [],
}));

function renderLibrary() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/library']}>
        <LibraryPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('LibraryPage', () => {
  beforeEach(() => {
    mockHasPermission.mockReset();
    mockListDocuments.mockReset();
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
});
