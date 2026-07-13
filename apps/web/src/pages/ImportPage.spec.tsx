import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ImportPage } from './ImportPage';

const mockHasPermission = vi.fn();
const mockRunManifest = vi.fn();
const mockRunBulk = vi.fn();
const mockList = vi.fn();
const mockGetBatch = vi.fn();

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'a@b.com', name: 'Admin', roles: ['Admin'], permissions: [], mustChangePassword: false },
    status: 'authenticated',
    logout: vi.fn(),
    hasPermission: mockHasPermission,
  }),
}));

vi.mock('../api/imports', () => ({
  runManifestImport: (...a: unknown[]) => mockRunManifest(...a),
  runBulkImport: (...a: unknown[]) => mockRunBulk(...a),
  listImportBatches: (...a: unknown[]) => mockList(...a),
  getImportBatch: (...a: unknown[]) => mockGetBatch(...a),
}));

const reportDetail = {
  id: 'batch-1',
  fileName: 'manifest.csv',
  totalRows: 3,
  createdCount: 1,
  duplicateCount: 1,
  errorCount: 1,
  status: 'completed',
  createdById: 'u1',
  createdByName: 'Admin',
  createdAt: '2026-07-13T00:00:00.000Z',
  completedAt: '2026-07-13T00:00:01.000Z',
  items: [
    { id: 'i1', rowNumber: 1, title: 'New Doc', documentNumber: 'PP-NEW', categoryName: 'Clinical', fileName: 'new.pdf', status: 'created', documentId: 'doc-1', message: 'Created with version 1 from "new.pdf".' },
    { id: 'i2', rowNumber: 2, title: 'Dup Doc', documentNumber: 'PP-DUP', categoryName: null, fileName: 'dup.pdf', status: 'duplicate', documentId: 'existing', message: 'Skipped: a document with this document number already exists.' },
    { id: 'i3', rowNumber: 3, title: 'Missing', documentNumber: null, categoryName: null, fileName: 'ghost.pdf', status: 'error', documentId: null, message: 'File "ghost.pdf" referenced in the manifest was not uploaded.' },
  ],
};

const batchSummary = {
  id: 'batch-1',
  fileName: 'manifest.csv',
  totalRows: 3,
  createdCount: 1,
  duplicateCount: 1,
  errorCount: 1,
  status: 'completed',
  createdById: 'u1',
  createdByName: 'Admin',
  createdAt: '2026-07-13T00:00:00.000Z',
  completedAt: '2026-07-13T00:00:01.000Z',
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ImportPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const csvFile = () => new File(['title,fileName\nNew Doc,new.pdf\n'], 'manifest.csv', { type: 'text/csv' });
const pdfFile = (name: string) => new File(['%PDF-1.4'], name, { type: 'application/pdf' });
const zipFile = () => new File(['PK'], 'clinic-policies.zip', { type: 'application/zip' });

describe('ImportPage', () => {
  beforeEach(() => {
    mockHasPermission.mockReset().mockReturnValue(true);
    mockRunManifest.mockReset().mockResolvedValue(reportDetail);
    mockRunBulk.mockReset().mockResolvedValue({ ...reportDetail, fileName: null });
    mockList.mockReset().mockResolvedValue({ items: [batchSummary], total: 1, page: 1, pageSize: 10 });
    mockGetBatch.mockReset().mockResolvedValue(reportDetail);
  });

  it('shows the forbidden state without document.write (never calls the API)', async () => {
    mockHasPermission.mockReturnValue(false);
    renderPage();
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(mockList).not.toHaveBeenCalled();
  });

  it('renders the import form with a sample-manifest download', async () => {
    renderPage();
    expect(await screen.findByRole('form', { name: 'Import documents' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download sample manifest' })).toBeInTheDocument();
    expect(screen.getByLabelText('Manifest (CSV)')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'ZIP archive' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Folder' })).toBeInTheDocument();
    expect(screen.getByText(/Drop files or folders here/i)).toBeInTheDocument();
  });

  it('validates that a manifest file is chosen before running', async () => {
    renderPage();
    await screen.findByRole('form', { name: 'Import documents' });
    fireEvent.click(screen.getByRole('button', { name: 'Run import' }));
    expect(await screen.findByText('Choose a CSV manifest file to import.')).toBeInTheDocument();
    expect(mockRunManifest).not.toHaveBeenCalled();
  });

  it('runs a manifest import and renders the per-row report with a link to the created doc', async () => {
    renderPage();
    const form = await screen.findByRole('form', { name: 'Import documents' });

    fireEvent.change(within(form).getByLabelText('Manifest (CSV)'), {
      target: { files: [csvFile()] },
    });
    fireEvent.change(within(form).getByLabelText('Referenced files'), {
      target: { files: [pdfFile('new.pdf')] },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Run import' }));

    await waitFor(() => expect(mockRunManifest).toHaveBeenCalled());

    // Report renders with the summary counts and each row's status.
    expect(await screen.findByText('Import report')).toBeInTheDocument();
    // "Created" appears as both a summary tile label and a row badge.
    expect(screen.getAllByText('Created').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Duplicate')).toBeInTheDocument();
    expect(screen.getByText('Error')).toBeInTheDocument();
    // The created document is linked to its detail page.
    const link = screen.getByRole('link', { name: 'View document' });
    expect(link).toHaveAttribute('href', '/library/doc-1');
  });

  it('runs a manifest-less bulk import when in "Files only" mode', async () => {
    renderPage();
    const form = await screen.findByRole('form', { name: 'Import documents' });

    fireEvent.click(within(form).getByRole('tab', { name: 'Files only' }));
    fireEvent.change(within(form).getByLabelText('Files to import'), {
      target: { files: [pdfFile('a.pdf'), pdfFile('b.pdf')] },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Run import' }));

    await waitFor(() => expect(mockRunBulk).toHaveBeenCalled());
    expect(mockRunManifest).not.toHaveBeenCalled();
    expect(await screen.findByText('Import report')).toBeInTheDocument();
  });

  it('runs a ZIP archive import through the bulk endpoint', async () => {
    renderPage();
    const form = await screen.findByRole('form', { name: 'Import documents' });

    fireEvent.click(within(form).getByRole('tab', { name: 'ZIP archive' }));
    fireEvent.change(within(form).getByLabelText('ZIP archive to import'), {
      target: { files: [zipFile()] },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Run import' }));

    await waitFor(() => expect(mockRunBulk).toHaveBeenCalledWith([expect.any(File)], undefined));
    expect(await screen.findByText('Import report')).toBeInTheDocument();
  });

  it('runs a folder import with relative paths preserved', async () => {
    const folderFile = pdfFile('Treatment Plan.pdf');
    Object.defineProperty(folderFile, 'webkitRelativePath', {
      value: 'Policies/Clinical/Treatment Plan.pdf',
    });
    renderPage();
    const form = await screen.findByRole('form', { name: 'Import documents' });

    fireEvent.click(within(form).getByRole('tab', { name: 'Folder' }));
    fireEvent.change(within(form).getByLabelText('Folder to import'), {
      target: { files: [folderFile] },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Run import' }));

    await waitFor(() =>
      expect(mockRunBulk).toHaveBeenCalledWith(
        [folderFile],
        ['Policies/Clinical/Treatment Plan.pdf'],
      ),
    );
    expect(await screen.findByText('Import report')).toBeInTheDocument();
  });

  it('lists recent imports and loads a batch report on demand', async () => {
    renderPage();
    // Recent imports table populated from listImportBatches.
    const recent = (await screen.findByText('Recent imports')).closest('div') as HTMLElement;
    fireEvent.click(within(recent).getByRole('button', { name: 'View report' }));
    await waitFor(() => expect(mockGetBatch).toHaveBeenCalled());
    // React Query v5 passes (variables, context) to the mutationFn — assert the id arg.
    expect(mockGetBatch.mock.calls[0][0]).toBe('batch-1');
    expect(await screen.findByText('Import report')).toBeInTheDocument();
  });
});
