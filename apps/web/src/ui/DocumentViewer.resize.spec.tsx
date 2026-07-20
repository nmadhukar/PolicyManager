import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { DocumentViewer } from './DocumentViewer';

const mockHasPermission = vi.fn();
const mockListAnnotations = vi.fn();
const mockGetViewUrl = vi.fn();
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
  resolveAnnotation: vi.fn(),
  reopenAnnotation: vi.fn(),
  deleteAnnotation: vi.fn(),
}));

vi.mock('../api/documents', () => ({
  getViewUrl: (...args: unknown[]) => mockGetViewUrl(...args),
}));

// FINDING-018: unlike the annotations spec's stub, Page here reports the
// `width` prop it actually received, so the test can observe pageWidth.
vi.mock('react-pdf', () => ({
  Document: ({ children, onLoadSuccess }: { children: ReactNode; onLoadSuccess: (a: { numPages: number }) => void }) => {
    useEffect(() => onLoadSuccess({ numPages: 1 }), [onLoadSuccess]);
    return <div>{children}</div>;
  },
  Page: ({ width }: { width: number }) => <div data-testid="pdf-page-width">{width}</div>,
  pdfjs: mockPdfjs,
}));

function renderViewer() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DocumentViewer
        documentId="doc-1"
        version={{ id: 'version-1', fileName: 'policy.pdf' }}
        onClose={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

describe('FINDING-018: DocumentViewer page width tracks window resize', () => {
  const originalInnerWidth = window.innerWidth;

  beforeEach(() => {
    mockHasPermission.mockReset().mockReturnValue(false);
    mockListAnnotations.mockReset().mockResolvedValue({
      items: [],
      canAnnotate: false,
      canComplianceDelete: false,
    });
    mockGetViewUrl.mockReset().mockResolvedValue({
      url: 'https://example.test/policy.pdf',
      mimeType: 'application/pdf',
      fileName: 'policy.pdf',
      expiresAt: '2026-01-01T00:05:00.000Z',
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: originalInnerWidth });
  });

  it('recomputes pageWidth when the window is resized while the viewer is open', async () => {
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1200 });
    renderViewer();

    const initial = await screen.findByTestId('pdf-page-width');
    // clamp(320, innerWidth - 420, 900): 1200 - 420 = 780
    expect(initial).toHaveTextContent('780');

    act(() => {
      Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 800 });
      window.dispatchEvent(new Event('resize'));
    });

    // clamp(320, innerWidth - 420, 900): 800 - 420 = 380
    await waitFor(() => expect(screen.getByTestId('pdf-page-width')).toHaveTextContent('380'));
  });
});
