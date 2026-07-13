import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AcknowledgmentsPage } from './AcknowledgmentsPage';

const mockList = vi.fn();
const mockAcknowledge = vi.fn();

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 's@x.com', name: 'Sam Staff', roles: ['Staff'], permissions: [], mustChangePassword: false },
    status: 'authenticated',
    logout: vi.fn(),
    hasPermission: () => false,
  }),
}));

vi.mock('../api/acknowledgments', () => ({
  listMyAcknowledgments: (...a: unknown[]) => mockList(...a),
  acknowledge: (...a: unknown[]) => mockAcknowledge(...a),
}));

// The viewer is lazy-loaded and pulls in pdf.js; stub it to a trivial overlay.
vi.mock('../ui/DocumentViewer', () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <button onClick={onClose}>close-viewer</button>
  ),
}));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AcknowledgmentsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const pending = {
  id: 'asg-1',
  documentId: 'doc-1',
  documentTitle: 'Seclusion Policy',
  documentNumber: 'PP-042',
  versionId: 'v-2',
  versionNumber: 2,
  status: 'pending' as const,
  dueDate: '2099-01-01T00:00:00.000Z',
  completedAt: null,
  createdAt: '2026-07-01T00:00:00.000Z',
  assignedByName: 'Morgan Manager',
};
const completed = {
  ...pending,
  id: 'asg-2',
  documentId: 'doc-2',
  documentTitle: 'Safety Plan',
  status: 'completed' as const,
  completedAt: '2026-07-05T00:00:00.000Z',
};

describe('AcknowledgmentsPage', () => {
  beforeEach(() => {
    mockList.mockReset().mockResolvedValue([pending, completed]);
    mockAcknowledge.mockReset().mockResolvedValue({
      assignment: { ...pending, status: 'completed' },
      attestation: { id: 'att-1', action: 'acknowledged' },
    });
  });

  it('lists pending and completed acknowledgments', async () => {
    renderPage();
    expect(await screen.findByText('Seclusion Policy')).toBeInTheDocument();
    expect(screen.getByText('Safety Plan')).toBeInTheDocument();
    expect(screen.getByText('To acknowledge (1)')).toBeInTheDocument();
    expect(screen.getByText('Completed (1)')).toBeInTheDocument();
  });

  it('gates the acknowledge action on opening the document first', async () => {
    renderPage();
    await screen.findByText('Seclusion Policy');

    const attest = screen.getByRole('button', { name: 'I have read and understand' });
    expect(attest).toBeDisabled();

    // Open the document → attest becomes enabled.
    fireEvent.click(screen.getByRole('button', { name: 'Open & review' }));
    await waitFor(() => expect(attest).toBeEnabled());
  });

  it('records an acknowledgment with hasViewed=true after viewing', async () => {
    renderPage();
    await screen.findByText('Seclusion Policy');

    fireEvent.click(screen.getByRole('button', { name: 'Open & review' }));
    const attest = screen.getByRole('button', { name: 'I have read and understand' });
    await waitFor(() => expect(attest).toBeEnabled());
    fireEvent.click(attest);

    const dialog = await screen.findByRole('dialog');
    // Signature is prefilled with the user's name.
    expect(within(dialog).getByLabelText(/Signature/)).toHaveValue('Sam Staff');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Acknowledge' }));

    await waitFor(() =>
      expect(mockAcknowledge).toHaveBeenCalledWith(
        'asg-1',
        expect.objectContaining({ hasViewed: true, signatureName: 'Sam Staff' }),
      ),
    );
  });

  it('shows an empty state when there is nothing to acknowledge', async () => {
    mockList.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('Nothing to acknowledge')).toBeInTheDocument();
  });
});
