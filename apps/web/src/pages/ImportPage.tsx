import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import {
  IMPORT_ITEM_STATUS_LABELS,
  PERMISSIONS,
  SAMPLE_MANIFEST_CSV,
  type ImportBatchDetail,
  type ImportItemResult,
  type ImportItemStatus,
} from '@policymanager/shared';
import { UPLOAD_ACCEPT } from '../api/documents';
import {
  getImportBatch,
  listImportBatches,
  runBulkImport,
  runManifestImport,
} from '../api/imports';
import { useAuth } from '../auth/AuthContext';
import { formatDateTime } from '../lib/format';
import { AppShell } from '../ui/AppShell';
import { EmptyState, ErrorState, ForbiddenState, LoadingState } from '../ui/states';

type ImportMode = 'manifest' | 'bulk';

interface ManifestPreview {
  columns: string[];
  rowCount: number;
  hasTitle: boolean;
}

/** Naive, client-side manifest peek for pre-submit hints only (server is authoritative). */
function previewManifest(text: string): ManifestPreview {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return { columns: [], rowCount: 0, hasTitle: false };
  const columns = lines[0].split(',').map((c) => c.trim());
  return {
    columns,
    rowCount: Math.max(lines.length - 1, 0),
    hasTitle: columns.some((c) => c.toLowerCase() === 'title'),
  };
}

/** Triggers a browser download of the sample manifest template. */
function downloadSampleManifest(): void {
  try {
    const blob = new Blob([SAMPLE_MANIFEST_CSV], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'policymanager-import-template.csv';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  } catch {
    /* download is a convenience; ignore environments without URL/Blob support */
  }
}

const STATUS_BADGE: Record<ImportItemStatus, string> = {
  created: 'bg-green-100 text-green-700',
  duplicate: 'bg-amber-100 text-amber-800',
  error: 'bg-red-100 text-red-700',
  skipped: 'bg-slate-100 text-ink-soft',
  pending: 'bg-slate-100 text-ink-soft',
};

/**
 * Import & Consolidation page (`/library/import`, Phase 8). Gated by `document.write`
 * — the server enforces it too; the UI gate is convenience only (AGENTS.md §8).
 * Supports a CSV manifest + referenced files, or a manifest-less bulk upload, then
 * renders the per-row import report with links to the created documents.
 */
export function ImportPage() {
  const { hasPermission } = useAuth();
  return (
    <AppShell>
      <div className="mx-auto max-w-5xl">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-ink">Import documents</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Consolidate scattered policies, job descriptions, and curriculums into PolicyManager. Use
            a CSV manifest to set titles, categories, and numbers, or bulk-upload files as-is.
            Duplicates are detected and skipped automatically.
          </p>
        </div>
        {hasPermission(PERMISSIONS.DOCUMENT_WRITE) ? <ImportManager /> : <ForbiddenState />}
      </div>
    </AppShell>
  );
}

function ImportManager() {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<ImportMode>('manifest');
  const [manifestFile, setManifestFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ManifestPreview | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [report, setReport] = useState<ImportBatchDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const batchesQuery = useQuery({
    queryKey: ['import-batches'],
    queryFn: () => listImportBatches(1, 10),
  });

  const onImported = (detail: ImportBatchDetail) => {
    setReport(detail);
    setError(null);
    void queryClient.invalidateQueries({ queryKey: ['import-batches'] });
  };
  const onFailed = (err: unknown) => {
    const message = (err as AxiosError<{ message?: string }>)?.response?.data?.message;
    setError(
      typeof message === 'string'
        ? message
        : 'The import could not be processed. Check the manifest and files, then try again.',
    );
  };

  const runManifest = useMutation({
    mutationFn: () => runManifestImport(manifestFile as File, files),
    onSuccess: onImported,
    onError: onFailed,
  });
  const runBulk = useMutation({
    mutationFn: () => runBulkImport(files),
    onSuccess: onImported,
    onError: onFailed,
  });
  const viewReport = useMutation({ mutationFn: getImportBatch, onSuccess: setReport });

  const busy = runManifest.isPending || runBulk.isPending;

  const onManifestChange = async (file: File | null) => {
    setManifestFile(file);
    setPreview(null);
    if (!file) return;
    try {
      setPreview(previewManifest(await file.text()));
    } catch {
      setPreview(null);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (mode === 'manifest') {
      if (!manifestFile) {
        setError('Choose a CSV manifest file to import.');
        return;
      }
      runManifest.mutate();
    } else {
      if (files.length === 0) {
        setError('Choose one or more files to import.');
        return;
      }
      runBulk.mutate();
    }
  };

  return (
    <div className="space-y-6">
      <form onSubmit={onSubmit} className="card space-y-5 p-5" aria-label="Import documents">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex rounded-lg border border-slate-200 p-0.5" role="tablist">
            <ModeTab active={mode === 'manifest'} onClick={() => setMode('manifest')}>
              CSV manifest
            </ModeTab>
            <ModeTab active={mode === 'bulk'} onClick={() => setMode('bulk')}>
              Files only
            </ModeTab>
          </div>
          <button type="button" className="btn-secondary" onClick={downloadSampleManifest}>
            Download sample manifest
          </button>
        </div>

        {error && (
          <div
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            role="alert"
          >
            {error}
          </div>
        )}

        {mode === 'manifest' ? (
          <div className="space-y-4">
            <div>
              <label htmlFor="manifest-file" className="label">
                Manifest (CSV)
              </label>
              <input
                id="manifest-file"
                type="file"
                accept=".csv,text/csv"
                className="block w-full text-sm text-ink-soft file:mr-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-2 file:text-sm file:font-medium file:text-brand-700"
                onChange={(e) => void onManifestChange(e.target.files?.[0] ?? null)}
              />
              {preview && <ManifestPreviewHints preview={preview} />}
            </div>
            <div>
              <label htmlFor="manifest-files" className="label">
                Referenced files
              </label>
              <input
                id="manifest-files"
                type="file"
                multiple
                accept={UPLOAD_ACCEPT}
                className="block w-full text-sm text-ink-soft file:mr-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-2 file:text-sm file:font-medium file:text-brand-700"
                onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
              />
              <p className="mt-1 text-xs text-ink-muted">
                Files are matched to manifest rows by file name. Accepted: PDF, Office, images, or
                text. {files.length} selected.
              </p>
            </div>
          </div>
        ) : (
          <div>
            <label htmlFor="bulk-files" className="label">
              Files to import
            </label>
            <input
              id="bulk-files"
              type="file"
              multiple
              accept={UPLOAD_ACCEPT}
              className="block w-full text-sm text-ink-soft file:mr-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-2 file:text-sm file:font-medium file:text-brand-700"
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
            <p className="mt-1 text-xs text-ink-muted">
              Each file becomes a document titled from its file name. Accepted: PDF, Office, images,
              or text. Identical files (same checksum) are skipped. {files.length} selected.
            </p>
          </div>
        )}

        <div className="flex justify-end">
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? 'Importing…' : 'Run import'}
          </button>
        </div>
      </form>

      {report && <ImportReport report={report} />}

      <RecentImports
        query={batchesQuery}
        onView={(id) => viewReport.mutate(id)}
        loadingId={viewReport.isPending ? viewReport.variables : undefined}
      />
    </div>
  );
}

function ModeTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-sm font-medium ${
        active ? 'bg-brand-600 text-white' : 'text-ink-soft hover:bg-slate-100'
      }`}
    >
      {children}
    </button>
  );
}

function ManifestPreviewHints({ preview }: { preview: ManifestPreview }) {
  return (
    <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-ink-soft">
      <div>
        Detected {preview.rowCount} {preview.rowCount === 1 ? 'row' : 'rows'} and{' '}
        {preview.columns.length} columns: <span className="text-ink">{preview.columns.join(', ')}</span>
      </div>
      {!preview.hasTitle && (
        <div className="mt-1 font-medium text-red-700">
          The manifest is missing a required “title” column.
        </div>
      )}
    </div>
  );
}

function ImportReport({ report }: { report: ImportBatchDetail }) {
  return (
    <div className="card space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-ink">Import report</h2>
        <span className="text-xs text-ink-muted">
          {report.fileName ? `Manifest: ${report.fileName}` : 'Bulk upload'} ·{' '}
          {formatDateTime(report.createdAt)}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryTile label="Rows" value={report.totalRows} tone="slate" />
        <SummaryTile label="Created" value={report.createdCount} tone="green" />
        <SummaryTile label="Duplicates" value={report.duplicateCount} tone="amber" />
        <SummaryTile label="Errors" value={report.errorCount} tone="red" />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-ink-muted">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Row</th>
              <th scope="col" className="px-3 py-2 font-medium">Title</th>
              <th scope="col" className="px-3 py-2 font-medium">File</th>
              <th scope="col" className="px-3 py-2 font-medium">Status</th>
              <th scope="col" className="px-3 py-2 font-medium">Detail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {report.items.map((item) => (
              <ReportRow key={item.id} item={item} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ReportRow({ item }: { item: ImportItemResult }) {
  const status = item.status as ImportItemStatus;
  return (
    <tr>
      <td className="px-3 py-2 align-top text-ink-soft">{item.rowNumber}</td>
      <td className="px-3 py-2 align-top">
        <div className="font-medium text-ink">{item.title ?? '—'}</div>
        {item.documentNumber && (
          <div className="text-xs text-ink-muted">{item.documentNumber}</div>
        )}
      </td>
      <td className="px-3 py-2 align-top text-ink-soft">{item.fileName ?? '—'}</td>
      <td className="px-3 py-2 align-top">
        <span
          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[status]}`}
        >
          {IMPORT_ITEM_STATUS_LABELS[status] ?? status}
        </span>
      </td>
      <td className="px-3 py-2 align-top text-ink-soft">
        {item.documentId ? (
          <Link to={`/library/${item.documentId}`} className="text-brand-600 hover:underline">
            {item.status === 'created' ? 'View document' : 'View existing'}
          </Link>
        ) : (
          <span>{item.message ?? '—'}</span>
        )}
        {item.documentId && item.message && (
          <div className="text-xs text-ink-muted">{item.message}</div>
        )}
      </td>
    </tr>
  );
}

function SummaryTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'slate' | 'green' | 'amber' | 'red';
}) {
  const toneClasses = {
    slate: 'text-ink',
    green: 'text-green-700',
    amber: 'text-amber-700',
    red: 'text-red-700',
  }[tone];
  return (
    <div className="rounded-lg border border-slate-200 p-3 text-center">
      <div className={`text-2xl font-semibold ${toneClasses}`}>{value}</div>
      <div className="text-xs uppercase tracking-wide text-ink-muted">{label}</div>
    </div>
  );
}

function RecentImports({
  query,
  onView,
  loadingId,
}: {
  query: ReturnType<typeof useQuery<Awaited<ReturnType<typeof listImportBatches>>>>;
  onView: (id: string) => void;
  loadingId?: string;
}) {
  if (query.isLoading) return <LoadingState label="Loading recent imports…" />;
  if (query.isError) {
    return (
      <ErrorState
        description="We couldn't load recent imports."
        onRetry={() => void query.refetch()}
      />
    );
  }
  const batches = query.data?.items ?? [];
  if (batches.length === 0) {
    return (
      <EmptyState
        title="No imports yet"
        description="Your import history will appear here once you run your first import."
      />
    );
  }

  return (
    <div className="card p-5">
      <h2 className="mb-3 text-base font-semibold text-ink">Recent imports</h2>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-ink-muted">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">When</th>
              <th scope="col" className="px-3 py-2 font-medium">Source</th>
              <th scope="col" className="px-3 py-2 font-medium">Created</th>
              <th scope="col" className="px-3 py-2 font-medium">Duplicates</th>
              <th scope="col" className="px-3 py-2 font-medium">Errors</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Report</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {batches.map((batch) => (
              <tr key={batch.id}>
                <td className="px-3 py-2 align-top text-ink-soft">
                  {formatDateTime(batch.createdAt)}
                </td>
                <td className="px-3 py-2 align-top text-ink">
                  {batch.fileName ?? 'Bulk upload'}
                  <div className="text-xs text-ink-muted">by {batch.createdByName ?? 'Unknown'}</div>
                </td>
                <td className="px-3 py-2 align-top text-green-700">{batch.createdCount}</td>
                <td className="px-3 py-2 align-top text-amber-700">{batch.duplicateCount}</td>
                <td className="px-3 py-2 align-top text-red-700">{batch.errorCount}</td>
                <td className="px-3 py-2 align-top text-right">
                  <button
                    className="text-xs font-medium text-brand-600 hover:underline disabled:opacity-50"
                    onClick={() => onView(batch.id)}
                    disabled={loadingId === batch.id}
                  >
                    {loadingId === batch.id ? 'Loading…' : 'View report'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
