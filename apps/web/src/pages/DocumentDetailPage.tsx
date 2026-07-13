import { FormEvent, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import {
  ACCESS_LEVELS,
  DOCUMENT_STATUSES,
  PERMISSIONS,
  REVIEW_CADENCES,
  type DocumentDetail,
  type DocumentVersionSummary,
} from '@policymanager/shared';
import {
  UpdateDocumentInput,
  archiveDocument,
  getDocument,
  getDownloadUrl,
  restoreVersion,
  softDeleteDocument,
  unarchiveDocument,
  updateDocument,
  uploadVersion,
} from '../api/documents';
import { flattenCategories, listCategoryTree } from '../api/categories';
import { useAuth } from '../auth/AuthContext';
import { formatBytes, formatDate, statusBadgeClasses, statusLabel } from '../lib/format';
import { AppShell } from '../ui/AppShell';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState, ErrorState, ForbiddenState, LoadingState } from '../ui/states';
import { TagInput } from '../ui/TagInput';

export function DocumentDetailPage() {
  const { hasPermission } = useAuth();
  const { id } = useParams<{ id: string }>();

  return (
    <AppShell>
      <div className="mx-auto max-w-5xl">
        <Link to="/library" className="text-sm font-medium text-brand-600 hover:underline">
          ← Back to library
        </Link>
        <div className="mt-3">
          {hasPermission(PERMISSIONS.DOCUMENT_READ) ? (
            <Detail id={id ?? ''} />
          ) : (
            <ForbiddenState />
          )}
        </div>
      </div>
    </AppShell>
  );
}

function Detail({ id }: { id: string }) {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission(PERMISSIONS.DOCUMENT_WRITE);

  const query = useQuery({ queryKey: ['document', id], queryFn: () => getDocument(id), enabled: !!id });
  const status = (query.error as AxiosError | null)?.response?.status;

  if (query.isLoading) return <LoadingState label="Loading document…" />;
  if (status === 403) return <ForbiddenState />;
  if (status === 404) {
    return <EmptyState title="Document not found" description="It may have been removed." />;
  }
  if (query.isError || !query.data) {
    return (
      <ErrorState description="We couldn't load this document." onRetry={() => void query.refetch()} />
    );
  }

  const doc = query.data;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">{doc.title}</h1>
          <div className="mt-1 flex items-center gap-2 text-sm text-ink-muted">
            {doc.documentNumber && <span>{doc.documentNumber}</span>}
            <span
              className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${statusBadgeClasses(
                doc.status,
              )}`}
            >
              {statusLabel(doc.status)}
            </span>
          </div>
        </div>
        {canWrite && <DocumentActions doc={doc} />}
      </header>

      {doc.status === 'archived' && (
        <div
          className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-ink-soft"
          role="status"
        >
          <span aria-hidden>🗄️</span>
          <span>
            This document is <span className="font-medium text-ink">archived</span> — it stays
            accessible but is hidden from active lists.
          </span>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <VersionsCard doc={doc} canWrite={canWrite} />
        </div>
        <div className="space-y-6">
          <MetadataCard doc={doc} canWrite={canWrite} />
          {canWrite && <QuickTags doc={doc} />}
        </div>
      </div>
    </div>
  );
}

/** Archive/Unarchive + soft-delete actions in the detail header (write users). */
function DocumentActions({ doc }: { doc: DocumentDetail }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['document', doc.id] });
    void queryClient.invalidateQueries({ queryKey: ['documents'] });
  };

  const archive = useMutation({ mutationFn: () => archiveDocument(doc.id), onSuccess: invalidate });
  const unarchive = useMutation({
    mutationFn: () => unarchiveDocument(doc.id),
    onSuccess: invalidate,
  });
  const del = useMutation({
    mutationFn: () => softDeleteDocument(doc.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      // The document now 404s on this route — return to the library.
      navigate('/library');
    },
  });

  const busy = archive.isPending || unarchive.isPending || del.isPending;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {doc.status === 'archived' ? (
        <button className="btn-secondary" onClick={() => unarchive.mutate()} disabled={busy}>
          {unarchive.isPending ? 'Unarchiving…' : 'Unarchive'}
        </button>
      ) : (
        <button className="btn-secondary" onClick={() => archive.mutate()} disabled={busy}>
          {archive.isPending ? 'Archiving…' : 'Archive'}
        </button>
      )}
      <button className="btn-danger" onClick={() => setConfirmDelete(true)} disabled={busy}>
        Delete
      </button>
      <ConfirmDialog
        open={confirmDelete}
        title="Move to trash?"
        body={
          <>
            <span className="font-medium text-ink">{doc.title}</span> will be moved to the trash.
            Nothing is permanently deleted — an administrator can restore it from the Trash view.
          </>
        }
        confirmLabel="Delete"
        tone="danger"
        busy={del.isPending}
        onConfirm={() => del.mutate()}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}

function MetadataCard({ doc, canWrite }: { doc: DocumentDetail; canWrite: boolean }) {
  const [editing, setEditing] = useState(false);
  if (editing) return <EditMetadata doc={doc} onDone={() => setEditing(false)} />;

  const rows: [string, string][] = [
    ['Document number', doc.documentNumber ?? '—'],
    ['Category', doc.categoryName ?? 'Uncategorized'],
    ['Owner', doc.ownerName ?? '—'],
    ['Status', statusLabel(doc.status)],
    ['Access level', doc.accessLevel],
    ['Review cadence', doc.reviewCadence],
    ['Next review', formatDate(doc.nextReviewDate)],
    ['Effective date', formatDate(doc.effectiveDate)],
  ];

  return (
    <div className="card p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">Details</h2>
        {canWrite && (
          <button
            className="text-xs font-medium text-brand-600 hover:underline"
            onClick={() => setEditing(true)}
          >
            Edit
          </button>
        )}
      </div>
      <dl className="space-y-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4">
            <dt className="text-ink-muted">{label}</dt>
            <dd className="text-right font-medium text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      {doc.description && (
        <div className="mt-4 border-t border-slate-100 pt-3">
          <dt className="text-xs uppercase tracking-wide text-ink-muted">Description</dt>
          <dd className="mt-1 text-sm text-ink-soft">{doc.description}</dd>
        </div>
      )}
      {doc.tags.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {doc.tags.map((t) => (
            <span
              key={t}
              className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-ink-soft"
            >
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function EditMetadata({ doc, onDone }: { doc: DocumentDetail; onDone: () => void }) {
  const queryClient = useQueryClient();
  const categoriesQuery = useQuery({ queryKey: ['category-tree'], queryFn: listCategoryTree });
  const categoryOptions = useMemo(
    () => flattenCategories(categoriesQuery.data ?? []),
    [categoriesQuery.data],
  );

  const [form, setForm] = useState<UpdateDocumentInput>({
    title: doc.title,
    documentNumber: doc.documentNumber ?? '',
    categoryId: doc.categoryId ?? '',
    description: doc.description ?? '',
    status: doc.status,
    accessLevel: doc.accessLevel,
    reviewCadence: doc.reviewCadence,
    nextReviewDate: doc.nextReviewDate ? doc.nextReviewDate.slice(0, 10) : '',
    effectiveDate: doc.effectiveDate ? doc.effectiveDate.slice(0, 10) : '',
  });
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (patch: UpdateDocumentInput) => updateDocument(doc.id, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['document', doc.id] });
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      onDone();
    },
    onError: (err) => {
      const status = (err as AxiosError).response?.status;
      setError(
        status === 409
          ? 'That document number is already in use.'
          : 'Unable to save changes. Please try again.',
      );
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if ((form.title ?? '').trim().length === 0) {
      setError('Title is required.');
      return;
    }
    mutation.mutate({
      title: form.title?.trim(),
      documentNumber: form.documentNumber?.trim() || undefined,
      categoryId: form.categoryId ? form.categoryId : null,
      description: form.description?.trim() || undefined,
      status: form.status,
      accessLevel: form.accessLevel,
      reviewCadence: form.reviewCadence,
      nextReviewDate: form.nextReviewDate ? form.nextReviewDate : null,
      effectiveDate: form.effectiveDate ? form.effectiveDate : null,
    });
  };

  return (
    <form className="card space-y-4 p-5" onSubmit={onSubmit} aria-label="Edit document">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">Edit details</h2>
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </div>
      )}
      <div>
        <label htmlFor="ed-title" className="label">
          Title <span className="text-red-600">*</span>
        </label>
        <input
          id="ed-title"
          className="input"
          value={form.title ?? ''}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
          required
        />
      </div>
      <div>
        <label htmlFor="ed-number" className="label">
          Document number
        </label>
        <input
          id="ed-number"
          className="input"
          value={form.documentNumber ?? ''}
          onChange={(e) => setForm({ ...form, documentNumber: e.target.value })}
        />
      </div>
      <div>
        <label htmlFor="ed-category" className="label">
          Category
        </label>
        <select
          id="ed-category"
          className="input"
          value={form.categoryId ?? ''}
          onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
        >
          <option value="">Uncategorized</option>
          {categoryOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {`${' '.repeat(c.depth * 2)}${c.name}`}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="ed-status" className="label">
          Status
        </label>
        <select
          id="ed-status"
          className="input"
          value={form.status}
          onChange={(e) => setForm({ ...form, status: e.target.value as DocumentDetail['status'] })}
        >
          {DOCUMENT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {statusLabel(s)}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="ed-access" className="label">
            Access level
          </label>
          <select
            id="ed-access"
            className="input"
            value={form.accessLevel}
            onChange={(e) =>
              setForm({ ...form, accessLevel: e.target.value as DocumentDetail['accessLevel'] })
            }
          >
            {ACCESS_LEVELS.map((a) => (
              <option key={a} value={a}>
                {a.charAt(0).toUpperCase() + a.slice(1)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="ed-cadence" className="label">
            Review cadence
          </label>
          <select
            id="ed-cadence"
            className="input"
            value={form.reviewCadence}
            onChange={(e) =>
              setForm({ ...form, reviewCadence: e.target.value as DocumentDetail['reviewCadence'] })
            }
          >
            {REVIEW_CADENCES.map((c) => (
              <option key={c} value={c}>
                {c.charAt(0).toUpperCase() + c.slice(1)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="ed-review" className="label">
            Next review date
          </label>
          <input
            id="ed-review"
            type="date"
            className="input"
            value={form.nextReviewDate ?? ''}
            onChange={(e) => setForm({ ...form, nextReviewDate: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor="ed-effective" className="label">
            Effective date
          </label>
          <input
            id="ed-effective"
            type="date"
            className="input"
            value={form.effectiveDate ?? ''}
            onChange={(e) => setForm({ ...form, effectiveDate: e.target.value })}
          />
        </div>
      </div>
      <div>
        <label htmlFor="ed-desc" className="label">
          Description
        </label>
        <textarea
          id="ed-desc"
          className="input min-h-[80px]"
          value={form.description ?? ''}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-secondary" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="btn-primary" disabled={mutation.isPending}>
          {mutation.isPending ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}

function QuickTags({ doc }: { doc: DocumentDetail }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (tags: string[]) => updateDocument(doc.id, { tags }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['document', doc.id] }),
  });

  return (
    <div className="card p-5">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-muted">Tags</h2>
      <TagInput
        value={doc.tags}
        onChange={(tags) => mutation.mutate(tags)}
        ariaLabel="Edit document tags"
      />
      {mutation.isPending && <p className="mt-2 text-xs text-ink-muted">Saving…</p>}
    </div>
  );
}

function VersionsCard({ doc, canWrite }: { doc: DocumentDetail; canWrite: boolean }) {
  return (
    <div className="card p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
          Version history
        </h2>
        <span className="text-xs text-ink-muted">
          {doc.versions.length} version{doc.versions.length === 1 ? '' : 's'}
        </span>
      </div>

      {canWrite && <UploadVersion doc={doc} />}

      {doc.versions.length === 0 ? (
        <p className="mt-4 text-sm text-ink-muted">
          No versions uploaded yet.{canWrite ? ' Upload a file above to create version 1.' : ''}
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-ink-muted">
              <tr>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Version
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  File
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Uploaded
                </th>
                <th scope="col" className="py-2 pr-0 text-right font-medium">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {doc.versions.map((v) => {
                const isCurrent = v.id === doc.currentVersion?.id;
                return (
                  <tr key={v.id} className={isCurrent ? 'bg-brand-50/40' : undefined}>
                    <td className="py-2.5 pr-4 align-top">
                      <div className="font-medium text-ink">
                        v{v.versionNumber}
                        {isCurrent && (
                          <span className="ml-2 rounded bg-brand-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-brand-700">
                            Current
                          </span>
                        )}
                      </div>
                      {v.changeSummary && (
                        <div className="text-xs text-ink-muted">{v.changeSummary}</div>
                      )}
                    </td>
                    <td className="py-2.5 pr-4 align-top text-ink-soft">
                      <div>{v.fileName}</div>
                      <div className="text-xs text-ink-muted">{formatBytes(v.sizeBytes)}</div>
                    </td>
                    <td className="py-2.5 pr-4 align-top text-ink-soft">
                      <div>{formatDate(v.createdAt)}</div>
                      <div className="text-xs text-ink-muted">{v.uploadedByName ?? '—'}</div>
                    </td>
                    <td className="py-2.5 pr-0 text-right align-top">
                      <div className="inline-flex items-center justify-end gap-2">
                        {canWrite && !isCurrent && (
                          <RestoreVersionButton doc={doc} version={v} />
                        )}
                        <DownloadButton documentId={doc.id} versionId={v.id} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Restores an older version as a NEW current version (confirm first). The old
 * version stays in history — nothing is overwritten.
 */
function RestoreVersionButton({
  doc,
  version,
}: {
  doc: DocumentDetail;
  version: DocumentVersionSummary;
}) {
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const mutation = useMutation({
    mutationFn: () => restoreVersion(doc.id, version.id),
    onSuccess: () => {
      setConfirm(false);
      void queryClient.invalidateQueries({ queryKey: ['document', doc.id] });
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
    },
  });

  return (
    <>
      <button
        className="btn-secondary !px-3 !py-1 text-xs"
        onClick={() => setConfirm(true)}
        disabled={mutation.isPending}
      >
        {mutation.isPending ? '…' : 'Restore'}
      </button>
      <ConfirmDialog
        open={confirm}
        title={`Restore v${version.versionNumber}?`}
        body={
          <>
            This copies <span className="font-medium text-ink">v{version.versionNumber}</span> to a
            new current version. Existing versions are kept in history — nothing is overwritten.
          </>
        }
        confirmLabel="Restore version"
        busy={mutation.isPending}
        onConfirm={() => mutation.mutate()}
        onCancel={() => setConfirm(false)}
      />
    </>
  );
}

function DownloadButton({ documentId, versionId }: { documentId: string; versionId: string }) {
  const [error, setError] = useState(false);
  const mutation = useMutation({
    mutationFn: () => getDownloadUrl(documentId, versionId),
    onSuccess: (ticket) => {
      setError(false);
      window.open(ticket.url, '_blank', 'noopener,noreferrer');
    },
    onError: () => setError(true),
  });

  return (
    <div className="inline-flex flex-col items-end">
      <button
        className="btn-secondary !px-3 !py-1 text-xs"
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending}
      >
        {mutation.isPending ? '…' : 'Download'}
      </button>
      {error && <span className="mt-1 text-[10px] text-red-600">Failed</span>}
    </div>
  );
}

function UploadVersion({ doc }: { doc: DocumentDetail }) {
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [changeSummary, setChangeSummary] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => {
      if (!file) throw new Error('no file');
      return uploadVersion(doc.id, file, changeSummary.trim() || undefined);
    },
    onSuccess: () => {
      setFile(null);
      setChangeSummary('');
      if (fileRef.current) fileRef.current.value = '';
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['document', doc.id] });
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
    },
    onError: () => setError('Upload failed. Please try again.'),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!file) {
      setError('Choose a file to upload.');
      return;
    }
    mutation.mutate();
  };

  return (
    <form
      className="rounded-lg border border-dashed border-slate-300 bg-slate-50/50 p-4"
      onSubmit={onSubmit}
      aria-label="Upload new version"
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[12rem] flex-1">
          <label htmlFor="uv-file" className="label">
            Upload new version
          </label>
          <input
            id="uv-file"
            ref={fileRef}
            type="file"
            className="block w-full text-sm text-ink-soft file:mr-3 file:rounded-md file:border-0 file:bg-brand-600 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-brand-700"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </div>
        <div className="min-w-[12rem] flex-1">
          <label htmlFor="uv-summary" className="label">
            Change summary
          </label>
          <input
            id="uv-summary"
            className="input"
            placeholder="What changed?"
            value={changeSummary}
            onChange={(e) => setChangeSummary(e.target.value)}
          />
        </div>
        <button type="submit" className="btn-primary" disabled={mutation.isPending}>
          {mutation.isPending ? 'Uploading…' : 'Upload'}
        </button>
      </div>
      {error && (
        <p className="mt-2 text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
