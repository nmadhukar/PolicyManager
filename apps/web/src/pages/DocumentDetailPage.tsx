import { FormEvent, ReactNode, Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import {
  ACCESS_LEVELS,
  DOCUMENT_STATUSES,
  EXTRACTION_STATUS_LABELS,
  PERMISSIONS,
  REVIEW_CADENCES,
  type DocumentDetail,
  type DocumentVersionSummary,
} from '@policymanager/shared';
import {
  UPLOAD_ACCEPT,
  UpdateDocumentInput,
  archiveDocument,
  getDocument,
  getDownloadUrl,
  getVersionHtml,
  regenerateRendition,
  restoreVersion,
  retryExtraction,
  softDeleteDocument,
  unarchiveDocument,
  updateDocument,
  uploadVersion,
} from '../api/documents';
import { compareVersions, fetchComparePdf } from '../api/documentCompare';
import { flattenCategories, listCategoryTree } from '../api/categories';
import { DocumentAclPanel } from './DocumentAclPanel';
import { DocumentReviewersPanel } from './DocumentReviewersPanel';
import { DocumentSignoffPanel } from './DocumentSignoffPanel';
import { DocumentAcknowledgmentPanel } from './DocumentAcknowledgmentPanel';
import { useAuth } from '../auth/AuthContext';
import { formatBytes, formatDate, formatDateTime, statusBadgeClasses, statusLabel } from '../lib/format';
import { AppShell } from '../ui/AppShell';
import { CategorySelectWithCreate } from '../ui/CategorySelectWithCreate';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Modal } from '../ui/Modal';
import { EmptyState, ErrorState, ForbiddenState, LoadingState } from '../ui/states';
import { TagInput } from '../ui/TagInput';
import { useToast } from '../ui/Toast';
import { useFocusTrap } from '../ui/useFocusTrap';
import { apiErrorMessage } from '../lib/apiError';
import { downloadBlob, triggerUrlDownload } from '../lib/download';

// Heavy viewing/editing surfaces are code-split so the detail page (and its tests)
// don't pull in pdf.js / OnlyOffice / TipTap until a user actually opens one.
const DocumentViewer = lazy(() => import('../ui/DocumentViewer'));
const OnlyOfficeEditor = lazy(() => import('../ui/OnlyOfficeEditor'));
const TipTapEditor = lazy(() => import('../ui/TipTapEditor'));

/** File extensions OnlyOffice can edit in-browser (mirrors the API's allow-list). */
const OFFICE_EDITABLE = ['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'odt', 'ods', 'odp', 'rtf'];

function fileExtension(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  return idx >= 0 ? fileName.slice(idx + 1).toLowerCase() : '';
}
function isOfficeEditable(v: DocumentVersionSummary): boolean {
  return OFFICE_EDITABLE.includes(fileExtension(v.fileName));
}
function isHtmlDoc(v: DocumentVersionSummary): boolean {
  return v.mimeType.startsWith('text/html') || fileExtension(v.fileName) === 'html';
}
/**
 * Flattens an app-authored HTML version to plain text for a `.txt` download.
 * Uses the browser's parser (no dependency); block-level elements become line
 * breaks so paragraphs, headings, and list items land on separate lines.
 */
function htmlToPlainText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const BLOCK = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BR', 'TR', 'BLOCKQUOTE', 'PRE']);
  const lines: string[] = [];
  let current = '';
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      current += node.textContent ?? '';
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = (node as Element).tagName;
    if (tag === 'BR') {
      lines.push(current);
      current = '';
      return;
    }
    const isBlock = BLOCK.has(tag);
    if (isBlock && current.trim()) {
      lines.push(current);
      current = '';
    }
    node.childNodes.forEach(walk);
    if (isBlock) {
      lines.push(current);
      current = '';
    }
  };
  doc.body.childNodes.forEach(walk);
  if (current.trim()) lines.push(current);
  // Collapse runs of blank lines, trim trailing whitespace per line.
  return lines
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function extractionBadgeClasses(status: DocumentVersionSummary['extractionStatus']): string {
  switch (status) {
    case 'done':
      return 'bg-emerald-100 text-emerald-800';
    case 'processing':
    case 'pending':
      return 'bg-amber-100 text-amber-800';
    case 'failed':
      return 'bg-red-100 text-red-700';
    default:
      return 'bg-slate-100 text-ink-soft';
  }
}

/** Which full-screen surface is open over the detail page (one at a time). */
type Overlay =
  | { kind: 'view'; version: DocumentVersionSummary }
  | { kind: 'compare'; from: DocumentVersionSummary; to: DocumentVersionSummary }
  | { kind: 'edit-office' }
  | { kind: 'edit-text'; version?: DocumentVersionSummary };

export function DocumentDetailPage() {
  const { hasPermission } = useAuth();
  const { id } = useParams<{ id: string }>();

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-7xl">
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
  const canManageReviews = hasPermission(PERMISSIONS.REVIEW_MANAGE);

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
        <div className="min-w-0">
          <h1 className="break-words text-2xl font-semibold text-ink">{doc.title}</h1>
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

      <VersionsCard doc={doc} canWrite={canWrite} />
      {/* Masonry via CSS columns: cards flow to fill vertical space so a short
       * card (e.g. Tags) doesn't leave a gap below it the way a fixed grid row
       * would. Each child gets break-inside-avoid so it isn't split across a
       * column boundary, and mb-6 for the vertical rhythm (columns have no gap).
       * `[&>*]:min-w-0` keeps a card with wide inner content from overflowing. */}
      <div className="gap-6 [column-fill:balance] md:columns-2 xl:columns-3 [&>*]:mb-6 [&>*]:break-inside-avoid [&>*]:min-w-0">
        <MetadataCard doc={doc} canWrite={canWrite} />
        <DocumentSignoffPanel doc={doc} />
        {canManageReviews && <DocumentAcknowledgmentPanel doc={doc} />}
        {canManageReviews && <DocumentReviewersPanel doc={doc} />}
        {canWrite && <DocumentAclPanel doc={doc} />}
        {canWrite && <QuickTags doc={doc} />}
      </div>
    </div>
  );
}

/** Archive/Unarchive + soft-delete actions in the detail header (write users). */
function DocumentActions({ doc }: { doc: DocumentDetail }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['document', doc.id] });
    void queryClient.invalidateQueries({ queryKey: ['documents'] });
  };

  const archive = useMutation({
    mutationFn: () => archiveDocument(doc.id),
    onSuccess: invalidate,
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not archive the document.')),
  });
  const unarchive = useMutation({
    mutationFn: () => unarchiveDocument(doc.id),
    onSuccess: invalidate,
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not unarchive the document.')),
  });
  const del = useMutation({
    mutationFn: () => softDeleteDocument(doc.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      // The document now 404s on this route — return to the library.
      navigate('/library');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not delete the document.')),
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
    // Uploaded (first created) vs last edited — the document-level distinction.
    // Per-version times are shown in the version history (each version is
    // immutable, so it carries only its own creation time).
    ['Created', formatDateTime(doc.createdAt)],
    ['Last edited', formatDateTime(doc.updatedAt)],
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
        <CategorySelectWithCreate
          id="ed-category"
          value={form.categoryId ?? ''}
          categoryOptions={categoryOptions}
          onChange={(categoryId) => setForm({ ...form, categoryId })}
        />
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
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: (tags: string[]) => updateDocument(doc.id, { tags }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['document', doc.id] }),
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not update tags.')),
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
  const queryClient = useQueryClient();
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  // Version count captured when the OnlyOffice editor closes. While set, we poll
  // for the async save-back to land (a NEW version) and show a saving overlay —
  // OnlyOffice writes the version server-side AFTER the editor closes, so an
  // immediate refetch would miss it.
  const [savingBaseline, setSavingBaseline] = useState<number | null>(null);

  const close = () => setOverlay(null);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['document', doc.id] });
    void queryClient.invalidateQueries({ queryKey: ['documents'] });
  };
  const closeAndRefresh = () => {
    refresh();
    close();
  };
  // Closing the OnlyOffice editor: enter "saving" mode and poll until the new
  // version appears (or a timeout), instead of refetching once and missing it.
  const closeOfficeEditor = () => {
    setSavingBaseline(doc.versions.length);
    close();
  };

  // While saving: the new version landed (count grew) -> stop.
  const savedArrived = savingBaseline !== null && doc.versions.length > savingBaseline;
  useEffect(() => {
    if (savingBaseline === null) return;
    if (savedArrived) {
      setSavingBaseline(null);
      return;
    }
    // Poll for the async save-back, and give up after ~15s so the overlay can't
    // hang forever — e.g. a no-change close (OnlyOffice writes no new version)
    // or a failed save. A real save's version row appears within a few seconds.
    const poll = setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: ['document', doc.id] });
    }, 1500);
    const giveUp = setTimeout(() => setSavingBaseline(null), 15_000);
    return () => {
      clearInterval(poll);
      clearTimeout(giveUp);
    };
  }, [savingBaseline, savedArrived, queryClient, doc.id]);

  const current = doc.currentVersion;
  // What editor (if any) applies to the current version.
  const canEditOffice = !!current && isOfficeEditable(current);
  const canEditText = !!current && isHtmlDoc(current);

  return (
    <div className="card p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
          Version history
        </h2>
        <div className="flex items-center gap-2">
          {doc.versions.length > 1 && doc.versions[1] && doc.currentVersion && (
            <button
              className="btn-secondary !px-3 !py-1 text-xs"
              onClick={() =>
                setOverlay({ kind: 'compare', from: doc.versions[1], to: doc.currentVersion as DocumentVersionSummary })
              }
            >
              Compare latest
            </button>
          )}
          <span className="text-xs text-ink-muted">
            {doc.versions.length} version{doc.versions.length === 1 ? '' : 's'}
          </span>
        </div>
      </div>

      {canWrite && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {current && canEditOffice && (
            <button className="btn-secondary !py-1.5 text-sm" onClick={() => setOverlay({ kind: 'edit-office' })}>
              Edit in OnlyOffice
            </button>
          )}
          {current && canEditText && (
            <button
              className="btn-secondary !py-1.5 text-sm"
              onClick={() => setOverlay({ kind: 'edit-text', version: current })}
            >
              Edit text
            </button>
          )}
          <button
            className="btn-secondary !py-1.5 text-sm"
            onClick={() => setOverlay({ kind: 'edit-text' })}
          >
            New text document
          </button>
        </div>
      )}

      {canWrite && <UploadVersion doc={doc} />}

      {doc.versions.length === 0 ? (
        <p className="mt-4 text-sm text-ink-muted">
          No versions yet.{canWrite ? ' Upload a file above, or start a new text document.' : ''}
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[480px] table-fixed text-left text-sm">
            <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-ink-muted">
              <tr>
                <th scope="col" className="w-[16%] py-2 pr-4 font-medium">
                  Version
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  File
                </th>
                <th scope="col" className="w-[22%] py-2 pr-4 font-medium">
                  Uploaded
                </th>
                <th scope="col" className="w-[200px] py-2 pr-0 text-right font-medium">
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
                      <div className="truncate" title={v.fileName}>{v.fileName}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
                        <span>{formatBytes(v.sizeBytes)}</span>
                        <span
                          className={`rounded-full px-2 py-0.5 font-medium ${extractionBadgeClasses(
                            v.extractionStatus,
                          )}`}
                          title={v.extractionError ?? undefined}
                        >
                          {EXTRACTION_STATUS_LABELS[v.extractionStatus]}
                        </span>
                        {v.ocrApplied && (
                          <span className="rounded-full bg-brand-100 px-2 py-0.5 font-medium text-brand-700">
                            OCR
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-2.5 pr-4 align-top text-ink-soft">
                      <div>{formatDateTime(v.createdAt)}</div>
                      <div className="text-xs text-ink-muted">{v.uploadedByName ?? '—'}</div>
                    </td>
                    <td className="py-2.5 pr-0 text-right align-top">
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        {/* Primary inline action: View if previewable, else the write-only preview generator. */}
                        {v.hasRendition ? (
                          <button
                            className="btn-secondary !px-3 !py-1 text-xs"
                            onClick={() => setOverlay({ kind: 'view', version: v })}
                          >
                            View
                          </button>
                        ) : (
                          canWrite && <RegenerateButton documentId={doc.id} versionId={v.id} />
                        )}
                        {/* Download stays inline — most-used secondary action. */}
                        <DownloadButton documentId={doc.id} versionId={v.id} />
                        {/* Low-frequency actions collapse into an overflow menu. */}
                        <VersionActionsMenu>
                          {canWrite &&
                            isCurrent &&
                            (v.extractionStatus === 'failed' || v.extractionStatus === 'skipped') && (
                              <RetryExtractionButton documentId={doc.id} menuItem />
                            )}
                          {canWrite && !isCurrent && (
                            <RestoreVersionButton doc={doc} version={v} menuItem />
                          )}
                          {!isCurrent && doc.currentVersion && (
                            <button
                              type="button"
                              role="menuitem"
                              className="flex w-full items-center px-4 py-2 text-left text-sm text-ink-soft hover:bg-slate-50"
                              onClick={() =>
                                setOverlay({
                                  kind: 'compare',
                                  from: v,
                                  to: doc.currentVersion as DocumentVersionSummary,
                                })
                              }
                            >
                              Compare
                            </button>
                          )}
                          {isHtmlDoc(v) && (
                            <DownloadTxtButton documentId={doc.id} version={v} menuItem />
                          )}
                        </VersionActionsMenu>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {overlay && (
        <Suspense fallback={<OverlayFallback />}>
          {overlay.kind === 'view' && (
            <DocumentViewer documentId={doc.id} version={overlay.version} onClose={close} />
          )}
          {overlay.kind === 'compare' && (
            <CompareModal documentId={doc.id} from={overlay.from} to={overlay.to} onClose={close} />
          )}
          {overlay.kind === 'edit-office' && (
            // On close we poll for the async save-back (see closeOfficeEditor)
            // and show a saving overlay until the new version appears.
            <OnlyOfficeEditor documentId={doc.id} onClose={closeOfficeEditor} />
          )}
          {overlay.kind === 'edit-text' && (
            <TipTapEditor
              documentId={doc.id}
              version={overlay.version}
              onSaved={closeAndRefresh}
              onClose={close}
            />
          )}
        </Suspense>
      )}

      {savingBaseline !== null && <SavingOverlay />}
    </div>
  );
}

/**
 * Full-screen "saving" overlay shown after the OnlyOffice editor closes, while
 * we poll for the async save-back to produce a new version. Dismissed by the
 * caller once the version lands (or after the timeout).
 */
function SavingOverlay() {
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-slate-900/60"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-3 rounded-lg bg-white px-5 py-4 text-sm font-medium text-ink shadow-lg">
        <span
          aria-hidden
          className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600"
        />
        Saving your changes…
      </div>
    </div>
  );
}

/** Neutral full-screen splash while a lazy editor/viewer bundle loads. */
function OverlayFallback() {
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-slate-900/60 text-sm text-white"
      role="status"
    >
      Loading…
    </div>
  );
}

function CompareModal({
  documentId,
  from,
  to,
  onClose,
}: {
  documentId: string;
  from: DocumentVersionSummary;
  to: DocumentVersionSummary;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: ['version-compare', documentId, from.id, to.id],
    queryFn: () => compareVersions(documentId, from.id, to.id),
  });
  const exportPdf = useMutation({
    mutationFn: () => fetchComparePdf(documentId, from.id, to.id),
    onSuccess: (blob) => downloadBlob(blob, `compare-v${from.versionNumber}-v${to.versionNumber}.pdf`),
  });

  return (
    <Modal open onClose={onClose} titleId="compare-title" busy={exportPdf.isPending} size="xl">
      <div className="max-h-[78vh] overflow-y-auto [scrollbar-gutter:stable]">
        <div className="min-w-0 border-b border-slate-200 pb-4">
          <h2 id="compare-title" className="text-base font-semibold text-ink">
            {query.data?.documentTitle ?? 'Version compare'}
          </h2>
          <p className="mt-1 text-sm text-ink-muted">
            Comparing v{query.data?.fromVersionNumber ?? from.versionNumber} (old) to v
            {query.data?.toVersionNumber ?? to.versionNumber} (new)
          </p>
        </div>

        {query.isLoading ? (
          <div className="mt-4">
            <LoadingState label="Comparing versions..." />
          </div>
        ) : query.isError || !query.data ? (
          <div className="mt-4">
            <ErrorState description="Could not compare these versions." onRetry={() => void query.refetch()} />
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            {query.data.warnings.map((w, i) => (
              <div
                key={i}
                role="status"
                className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
              >
                <span className="font-semibold">Warning: </span>
                {w}
              </div>
            ))}
            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <Metric label="Added" value={query.data.summary.added} tone="text-green-700" tile="border-green-200 bg-green-50" />
              <Metric label="Removed" value={query.data.summary.removed} tone="text-red-700" tile="border-red-200 bg-red-50" />
              <Metric label="Changed" value={query.data.summary.changed} tone="text-amber-800" tile="border-amber-200 bg-amber-50" />
              <Metric label="Unchanged" value={query.data.summary.unchanged} tone="text-ink-soft" tile="border-slate-200 bg-white" />
            </div>
            {query.data.metadataChanges.length > 0 && (
              <div className="rounded-lg border border-slate-200">
                <div className="border-b border-slate-100 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
                  Metadata changes
                </div>
                <div className="grid gap-2 border-b border-slate-100 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink-muted sm:grid-cols-[10rem_1fr_1fr]">
                  <div className="min-w-0">Field</div>
                  <div className="min-w-0">Old (v{query.data.fromVersionNumber})</div>
                  <div className="min-w-0">New (v{query.data.toVersionNumber})</div>
                </div>
                <div className="divide-y divide-slate-100 text-sm">
                  {query.data.metadataChanges.map((change) => (
                    <div key={change.field} className="grid gap-2 px-3 py-2 sm:grid-cols-[10rem_1fr_1fr]">
                      <div className="min-w-0 font-medium text-ink">{change.label}</div>
                      <div className="min-w-0 break-all font-mono text-xs text-red-800">{change.oldValue ?? '-'}</div>
                      <div className="min-w-0 break-all font-mono text-xs text-green-800">{change.newValue ?? '-'}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="overflow-hidden rounded-lg border border-slate-200">
              <div className="border-b border-slate-100 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
                Redline
              </div>
              <div className="max-h-[26rem] overflow-auto bg-slate-50 p-3 font-mono text-xs leading-5">
                {query.data.hunks.length === 0 ? (
                  <div className="py-6 text-center text-ink-muted">
                    {query.data.textAvailable
                      ? 'No text differences — the extracted text is identical.'
                      : 'Text comparison unavailable — extracted text is missing for one or both versions.'}
                  </div>
                ) : (
                  query.data.hunks.map((hunk, index) => {
                    const mark =
                      hunk.type === 'added' ? '+' : hunk.type === 'removed' ? '-' : hunk.type === 'changed' ? '~' : ' ';
                    const rowTone =
                      hunk.type === 'added'
                        ? 'bg-green-50 text-green-800'
                        : hunk.type === 'removed'
                          ? 'bg-red-50 text-red-800'
                          : hunk.type === 'changed'
                            ? 'bg-amber-50 text-amber-900'
                            : 'text-ink-soft';
                    return (
                      <div key={`${hunk.type}-${index}`} className={`flex gap-2 rounded px-2 py-0.5 ${rowTone}`}>
                        <span className="select-none font-semibold text-ink-muted">{mark}</span>
                        <span className="shrink-0 select-none text-ink-muted">
                          {hunk.oldLine ?? '-'}:{hunk.newLine ?? '-'}
                        </span>
                        <span className="min-w-0 whitespace-pre-wrap break-words">
                          {hunk.type === 'changed' ? (
                            <>
                              <span className="line-through">{hunk.oldText ?? ''}</span>
                              {'\n'}
                              <span>{hunk.newText ?? ''}</span>
                            </>
                          ) : hunk.type === 'removed' ? (
                            <span className="line-through">{hunk.oldText ?? hunk.newText}</span>
                          ) : (
                            hunk.newText ?? hunk.oldText
                          )}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2 border-t border-slate-200 pt-4">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={exportPdf.isPending}>
            Close
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => exportPdf.mutate()}
            disabled={exportPdf.isPending || query.isLoading || query.isError || !query.data}
          >
            {exportPdf.isPending ? 'Exporting…' : 'Export PDF'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Metric({
  label,
  value,
  tone,
  tile = 'border-slate-200 bg-white',
}: {
  label: string;
  value: number;
  tone: string;
  tile?: string;
}) {
  return (
    <div className={`rounded-lg border p-3 ${tile}`}>
      <div className={`text-xl font-semibold ${tone}`}>{value}</div>
      <div className="text-xs uppercase tracking-wide text-ink-muted">{label}</div>
    </div>
  );
}

/**
 * Regenerates a version's PDF preview on demand (e.g. after a transient Gotenberg
 * outage left it without a rendition). Refreshes history on success so the row
 * flips to offering "View".
 */
/** Re-runs text/OCR extraction for the whole document (recover a failed/stuck scan). */
function RetryExtractionButton({
  documentId,
  menuItem,
}: {
  documentId: string;
  menuItem?: boolean;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: () => retryExtraction(documentId),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['document', documentId] });
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      toast.success(
        `Re-extraction ran: ${result.done} done, ${result.skipped} skipped, ${result.failed} failed.`,
      );
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not re-run extraction.')),
  });
  return (
    <button
      role={menuItem ? 'menuitem' : undefined}
      className={
        menuItem
          ? 'flex w-full items-center px-4 py-2 text-left text-sm text-ink-soft hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50'
          : 'btn-secondary !px-3 !py-1 text-xs'
      }
      onClick={() => mutation.mutate()}
      disabled={mutation.isPending}
      title="Re-run text/OCR extraction for this document"
    >
      {mutation.isPending ? '…' : 'Re-extract'}
    </button>
  );
}

function RegenerateButton({ documentId, versionId }: { documentId: string; versionId: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: () => regenerateRendition(documentId, versionId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['document', documentId] }),
    onError: (err) =>
      toast.error(apiErrorMessage(err, 'Could not generate a preview for this version.')),
  });
  return (
    <button
      className="btn-secondary !px-3 !py-1 text-xs"
      onClick={() => mutation.mutate()}
      disabled={mutation.isPending}
      title="Generate a viewable PDF preview for this version"
    >
      {mutation.isPending ? '…' : 'Make preview'}
    </button>
  );
}

/**
 * Restores an older version as a NEW current version (confirm first). The old
 * version stays in history — nothing is overwritten.
 */
function RestoreVersionButton({
  doc,
  version,
  menuItem,
}: {
  doc: DocumentDetail;
  version: DocumentVersionSummary;
  menuItem?: boolean;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const mutation = useMutation({
    mutationFn: () => restoreVersion(doc.id, version.id),
    onSuccess: () => {
      setConfirm(false);
      void queryClient.invalidateQueries({ queryKey: ['document', doc.id] });
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not restore this version.')),
  });

  return (
    <>
      <button
        role={menuItem ? 'menuitem' : undefined}
        className={
          menuItem
            ? 'flex w-full items-center px-4 py-2 text-left text-sm text-ink-soft hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50'
            : 'btn-secondary !px-3 !py-1 text-xs'
        }
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

function DownloadButton({
  documentId,
  versionId,
  menuItem,
}: {
  documentId: string;
  versionId: string;
  menuItem?: boolean;
}) {
  const [error, setError] = useState(false);
  const mutation = useMutation({
    mutationFn: () => getDownloadUrl(documentId, versionId),
    onSuccess: (ticket) => {
      setError(false);
      // Hidden-anchor download: a post-await window.open would be popup-blocked.
      triggerUrlDownload(ticket.url, ticket.fileName);
    },
    onError: () => setError(true),
  });

  return (
    <div className={menuItem ? 'w-full' : 'inline-flex flex-col items-end'}>
      <button
        role={menuItem ? 'menuitem' : undefined}
        className={
          menuItem
            ? 'flex w-full items-center px-4 py-2 text-left text-sm text-ink-soft hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50'
            : 'btn-secondary !px-3 !py-1 text-xs'
        }
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending}
      >
        {mutation.isPending ? '…' : 'Download'}
      </button>
      {error && (
        <span className={menuItem ? 'block px-4 pb-1 text-[10px] text-red-600' : 'mt-1 text-[10px] text-red-600'}>
          Failed
        </span>
      )}
    </div>
  );
}

/**
 * Downloads an app-authored HTML version as plain text (.txt). The stored file
 * stays HTML (it drives the formatted viewer + PDF rendition); this just offers
 * a flattened plain-text copy. Only rendered for HTML versions.
 */
function DownloadTxtButton({
  documentId,
  version,
  menuItem,
}: {
  documentId: string;
  version: DocumentVersionSummary;
  menuItem?: boolean;
}) {
  const [error, setError] = useState(false);
  const mutation = useMutation({
    mutationFn: () => getVersionHtml(documentId, version.id),
    onSuccess: ({ html }) => {
      setError(false);
      const text = htmlToPlainText(html);
      const stem = version.fileName.replace(/\.[^.]+$/, '') || 'document';
      downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), `${stem}.txt`);
    },
    onError: () => setError(true),
  });

  return (
    <div className={menuItem ? 'w-full' : 'inline-flex flex-col items-end'}>
      <button
        role={menuItem ? 'menuitem' : undefined}
        className={
          menuItem
            ? 'flex w-full items-center px-4 py-2 text-left text-sm text-ink-soft hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50'
            : 'btn-secondary !px-3 !py-1 text-xs'
        }
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending}
        title="Download this text document as a plain .txt file (formatting removed)"
      >
        {mutation.isPending ? '…' : 'Download .txt'}
      </button>
      {error && (
        <span className={menuItem ? 'block px-4 pb-1 text-[10px] text-red-600' : 'mt-1 text-[10px] text-red-600'}>
          Failed
        </span>
      )}
    </div>
  );
}

/**
 * Overflow menu for low-frequency version-row actions (Restore, Compare,
 * Re-extract, Download .txt). Hand-rolled dropdown (no icon/menu lib) mirroring
 * the UserMenu pattern in AppShell: relative trigger + absolute right-0 z-20
 * panel, focus-trap, capture-phase outside-pointerdown to close.
 *
 * Deliberately does NOT close on panel click: the mounted mutation buttons
 * (Re-extract, Download .txt) own local pending/error state, so unmounting them
 * on click would drop that UI. Closes only on outside-click or Escape; the plain
 * Compare item closes explicitly. Renders nothing when it has no children so a
 * row with no overflow actions shows no trigger.
 */
function VersionActionsMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  // Fixed-viewport coordinates for the panel, computed from the trigger's rect.
  // `position: fixed` escapes the table's `overflow-x-auto` wrapper (an absolute
  // panel would be clipped by it); UserMenu can use `absolute` only because the
  // header has no overflow ancestor — this table does.
  const [coords, setCoords] = useState<{ top: number; right: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useFocusTrap(open, menuRef, () => setOpen(false));

  const openMenu = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setCoords({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    setOpen(true);
  };

  // Close on outside-click, and also on scroll/resize (the fixed panel would
  // otherwise drift away from its now-moved trigger).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (
        containerRef.current && !containerRef.current.contains(t) &&
        menuRef.current && !menuRef.current.contains(t)
      ) {
        setOpen(false);
      }
    };
    const onReposition = () => setOpen(false);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onReposition, true);
    window.addEventListener('resize', onReposition);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', onReposition, true);
      window.removeEventListener('resize', onReposition);
    };
  }, [open]);

  // All actions gated off for this row -> no trigger. (children may contain
  // `false`/`undefined` from short-circuited conditionals.)
  const hasChildren = Array.isArray(children) ? children.some(Boolean) : Boolean(children);
  if (!hasChildren) return null;

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        className="btn-secondary !px-2 !py-1 text-xs"
        onClick={() => (open ? setOpen(false) : openMenu())}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
        title="More actions"
      >
        {/* Hand-rolled horizontal ellipsis (no icon lib). */}
        <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor" aria-hidden>
          <circle cx="4" cy="10" r="1.5" />
          <circle cx="10" cy="10" r="1.5" />
          <circle cx="16" cy="10" r="1.5" />
        </svg>
      </button>

      {open && coords && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="More version actions"
          style={{ position: 'fixed', top: coords.top, right: coords.right }}
          className="z-30 flex w-48 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white py-1 text-left shadow-lg focus:outline-none"
        >
          {children}
        </div>
      )}
    </div>
  );
}

function UploadVersion({ doc }: { doc: DocumentDetail }) {
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [changeSummary, setChangeSummary] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);

  const mutation = useMutation({
    mutationFn: () => {
      if (!file) throw new Error('no file');
      return uploadVersion(doc.id, file, changeSummary.trim() || undefined, setProgress);
    },
    onSuccess: () => {
      setFile(null);
      setChangeSummary('');
      if (fileRef.current) fileRef.current.value = '';
      setError(null);
      setProgress(0);
      void queryClient.invalidateQueries({ queryKey: ['document', doc.id] });
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
    },
    onError: (err) => {
      setProgress(0);
      setError(
        apiErrorMessage(err, 'Upload failed. Please try again.', {
          413: 'This file is too large to upload.',
          415: 'This file type isn’t supported. Try PDF, Office, image, or text.',
        }),
      );
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!file) {
      setError('Choose a file to upload.');
      return;
    }
    setError(null);
    setProgress(0);
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
            accept={UPLOAD_ACCEPT}
            className="block w-full text-sm text-ink-soft file:mr-3 file:rounded-md file:border-0 file:bg-brand-600 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-brand-700"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <p className="mt-1 text-xs text-ink-muted">
            PDF, Office (Word/Excel/PowerPoint), images, or text.
          </p>
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
      {mutation.isPending && (
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between text-xs text-ink-muted">
            <span>Uploading{file ? ` ${file.name}` : ''}…</span>
            <span>{progress}%</span>
          </div>
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-slate-100"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            aria-label="Upload progress"
          >
            <div
              className="h-full rounded-full bg-brand-500 transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}
      {error && (
        <p className="mt-2 text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
