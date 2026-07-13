import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { DocumentViewer } from './DocumentViewer';

const mockHasPermission = vi.fn();
const mockListAnnotations = vi.fn();
const mockGetViewUrl = vi.fn();

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 'reviewer-1',
      email: 'reviewer@example.com',
      name: 'Reviewer',
      roles: ['Staff'],
      permissions: ['document.read'],
      mustChangePassword: false,
    },
    status: 'authenticated',
    login: vi.fn(),
    logout: vi.fn(),
    hasPermission: mockHasPermission,
  }),
}));

vi.mock('../api/annotations', () => ({
  listAnnotations: (...args: unknown[]) => mockListAnnotations(...args),
  createAnnotation: vi.fn(),
  resolveAnnotation: vi.fn(),
  reopenAnnotation: vi.fn(),
  deleteAnnotation: vi.fn(),
}));

vi.mock('../api/documents', () => ({
  getViewUrl: (...args: unknown[]) => mockGetViewUrl(...args),
}));

vi.mock('react-pdf', () => ({
  Document: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Page: () => <div>PDF page</div>,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } },
}));

function renderViewer() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DocumentViewer
        documentId="doc-1"
        version={{ id: 'version-1', fileName: 'policy.png' }}
        onClose={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

describe('DocumentViewer annotations', () => {
  beforeEach(() => {
    mockHasPermission.mockReset();
    mockListAnnotations.mockReset();
    mockGetViewUrl.mockReset();
    mockHasPermission.mockReturnValue(false);
    mockGetViewUrl.mockResolvedValue({
      url: 'https://example.test/policy.png',
      mimeType: 'image/png',
      fileName: 'policy.png',
      expiresAt: '2026-01-01T00:05:00.000Z',
    });
  });

  it('shows annotation authoring when the API reports reviewer capability', async () => {
    mockListAnnotations.mockResolvedValue({
      items: [],
      canAnnotate: true,
      canComplianceDelete: false,
    });

    renderViewer();

    expect(await screen.findByRole('button', { name: 'Add annotation' })).toBeInTheDocument();
  });

  it('keeps read-only viewers from seeing annotation authoring controls', async () => {
    mockListAnnotations.mockResolvedValue({
      items: [],
      canAnnotate: false,
      canComplianceDelete: false,
    });

    renderViewer();

    await waitFor(() => expect(screen.getByText('No annotations.')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Add annotation' })).not.toBeInTheDocument();
  });
});
