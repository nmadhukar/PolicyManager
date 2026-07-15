import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReviewsPage } from './ReviewsPage';

const mockHasPermission = vi.fn();
const mockListTasks = vi.fn();
const mockComplete = vi.fn();
const mockCompliance = vi.fn();
const mockSweep = vi.fn();

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'a@b.com', name: 'Admin', roles: ['Admin'], permissions: [], mustChangePassword: false },
    status: 'authenticated',
    hasPermission: mockHasPermission,
  }),
}));

vi.mock('../api/reviews', () => ({
  listReviewTasks: (...a: unknown[]) => mockListTasks(...a),
  completeReview: (...a: unknown[]) => mockComplete(...a),
  getComplianceSummary: (...a: unknown[]) => mockCompliance(...a),
  runReviewSweep: (...a: unknown[]) => mockSweep(...a),
}));

// Stub the heavy read-only preview (pulls in pdf.js) — we only assert it opens.
vi.mock('../ui/DocumentViewer', () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="doc-preview">
      preview
      <button onClick={onClose}>Close preview</button>
    </div>
  ),
}));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ReviewsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const overdueTask = {
  id: 't-overdue',
  documentId: 'doc-1',
  documentTitle: 'Overdue Policy',
  documentNumber: 'D-1',
  versionId: 'v1',
  dueDate: '2020-01-01T00:00:00.000Z',
  status: 'overdue' as const,
  assignedToId: 'u1',
  assignedToName: 'Admin',
  completedAt: null,
  completedByName: null,
  notes: null,
  createdAt: '2019-12-01T00:00:00.000Z',
  reviewCadence: 'quarterly' as const,
  unresolvedAnnotationCount: 0,
  hasViewed: true, // viewed by default so the Complete button is enabled
  reviewedVersionId: 'v1', // the version the preview opens / the gate checks
};
const upcomingTask = {
  ...overdueTask,
  id: 't-upcoming',
  documentId: 'doc-2',
  documentTitle: 'Upcoming Policy',
  documentNumber: 'D-2',
  dueDate: '2999-01-01T00:00:00.000Z',
  status: 'pending' as const,
};
const completedTask = {
  ...overdueTask,
  id: 't-done',
  documentId: 'doc-3',
  documentTitle: 'Finished Policy',
  status: 'completed' as const,
  completedAt: '2026-01-01T00:00:00.000Z',
};

const summary = { totalDocuments: 10, current: 7, dueSoon: 2, overdue: 1, percentCurrent: 70 };

describe('ReviewsPage', () => {
  beforeEach(() => {
    mockHasPermission.mockReset().mockReturnValue(false);
    mockListTasks.mockReset().mockResolvedValue({
      items: [overdueTask, upcomingTask, completedTask],
      total: 3,
      page: 1,
      pageSize: 200,
    });
    mockComplete.mockReset().mockResolvedValue({ ...overdueTask, status: 'completed' });
    mockCompliance.mockReset().mockResolvedValue(summary);
    mockSweep.mockReset().mockResolvedValue({ tasksCreated: 2, overdueMarked: 1, documentsConsidered: 3 });
  });

  it('renders My Reviews sections with the assigned tasks', async () => {
    renderPage();
    expect(await screen.findByText('Overdue Policy')).toBeInTheDocument();
    expect(screen.getByText('Upcoming Policy')).toBeInTheDocument();
    expect(screen.getByText('Finished Policy')).toBeInTheDocument();
    // Only the two OPEN tasks get a Complete button.
    expect(screen.getAllByRole('button', { name: 'Complete review' })).toHaveLength(2);
    // Requested own tasks only.
    expect(mockListTasks).toHaveBeenCalledWith({ mine: true, pageSize: 200 });
  });

  it('shows compliance cards + run-sweep only for review.manage', async () => {
    mockHasPermission.mockImplementation((k: string) => k === 'review.manage');
    renderPage();
    await waitFor(() => expect(screen.getByText('70%')).toBeInTheDocument());
    expect(screen.getByText('Compliance')).toBeInTheDocument();
    expect(mockCompliance).toHaveBeenCalled();

    // Run sweep triggers the API and reports the result.
    fireEvent.click(screen.getByRole('button', { name: 'Run review sweep' }));
    await waitFor(() => expect(mockSweep).toHaveBeenCalled());
    expect(await screen.findByText(/Sweep complete/)).toBeInTheDocument();
  });

  it('hides the compliance panel for a non-manager', async () => {
    renderPage();
    await screen.findByText('Overdue Policy');
    expect(screen.queryByText('Compliance')).not.toBeInTheDocument();
    expect(mockCompliance).not.toHaveBeenCalled();
  });

  it('completes a review through the modal', async () => {
    renderPage();
    await screen.findByText('Overdue Policy');

    fireEvent.click(screen.getAllByRole('button', { name: 'Complete review' })[0]);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Notes/), { target: { value: 'Reviewed, all good' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Complete review' }));

    await waitFor(() =>
      expect(mockComplete).toHaveBeenCalledWith(
        't-overdue',
        expect.objectContaining({ notes: 'Reviewed, all good' }),
      ),
    );
  });

  it('disables Complete review until viewed, and opens the read-only preview from the review row', async () => {
    mockListTasks.mockResolvedValue({
      items: [{ ...overdueTask, hasViewed: false }],
      total: 1,
      page: 1,
      pageSize: 200,
    });
    renderPage();
    await screen.findByText('Overdue Policy');

    // Complete is blocked until the document is opened/viewed.
    expect(screen.getByRole('button', { name: 'Complete review' })).toBeDisabled();
    expect(screen.queryByTestId('doc-preview')).not.toBeInTheDocument();

    // Clicking "Open document to review" opens the SAME preview overlay the
    // acknowledgment flow uses (which records the view server-side).
    fireEvent.click(screen.getByRole('button', { name: /Open document to review/ }));
    expect(await screen.findByTestId('doc-preview')).toBeInTheDocument();
  });

  it('shows an empty state when there are no tasks', async () => {
    mockListTasks.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 200 });
    renderPage();
    expect(await screen.findByText('No reviews assigned to you')).toBeInTheDocument();
  });
});
