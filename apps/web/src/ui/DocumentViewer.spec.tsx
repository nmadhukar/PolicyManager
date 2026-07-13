import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { DocumentViewer } from './DocumentViewer';

const mockHasPermission = vi.fn();
const mockListAnnotations = vi.fn();
const mockGetViewUrl = vi.fn();
const mockResolveAnnotation = vi.fn();
const mockPdfjs = vi.hoisted(() => ({ GlobalWorkerOptions: { workerSrc: '' } }));

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
  resolveAnnotation: (...args: unknown[]) => mockResolveAnnotation(...args),
  reopenAnnotation: vi.fn(),
  deleteAnnotation: vi.fn(),
}));

vi.mock('../api/documents', () => ({
  getViewUrl: (...args: unknown[]) => mockGetViewUrl(...args),
}));

vi.mock('react-pdf', () => ({
  Document: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Page: () => <div>PDF page</div>,
  pdfjs: mockPdfjs,
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
    mockResolveAnnotation.mockReset();
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

  it('uses the pdf.js worker bundled with react-pdf', () => {
    expect(mockPdfjs.GlobalWorkerOptions.workerSrc).toContain(
      'react-pdf/node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
    );
    expect(mockPdfjs.GlobalWorkerOptions.workerSrc).not.toContain(
      'apps/web/node_modules/pdfjs-dist',
    );
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

  it('shows a visible error when an annotation action fails', async () => {
    mockListAnnotations.mockResolvedValue({
      items: [
        {
          id: 'ann-1',
          documentId: 'doc-1',
          versionId: 'version-1',
          authorId: 'reviewer-1',
          authorName: 'Reviewer',
          type: 'comment',
          status: 'open',
          pageNumber: 1,
          x: 0.1,
          y: 0.1,
          width: 0.2,
          height: 0.1,
          body: 'Needs update',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          resolvedAt: null,
          resolvedByName: null,
        },
      ],
      canAnnotate: true,
      canComplianceDelete: false,
    });
    mockResolveAnnotation.mockRejectedValue({ response: { status: 403 } });

    renderViewer();

    fireEvent.click(await screen.findByRole('button', { name: 'Resolve' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You do not have permission to do that.',
    );
  });
});
