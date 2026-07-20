import { FormEvent, MouseEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { Document, Page, pdfjs } from 'react-pdf';
import pdfWorkerUrl from 'react-pdf/node_modules/pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  ANNOTATION_TYPE_LABELS,
  ANNOTATION_TYPES,
  PERMISSIONS,
  ROLES,
  type AnnotationRect,
  type AnnotationType,
  type DocumentAnnotationItem,
} from '@policymanager/shared';
import {
  createAnnotation,
  deleteAnnotation,
  listAnnotations,
  reopenAnnotation,
  resolveAnnotation,
} from '../api/annotations';
import { getViewUrl } from '../api/documents';
import { useAuth } from '../auth/AuthContext';
import { apiErrorMessage } from '../lib/apiError';
import { ErrorState, LoadingState } from './states';
import { useFocusTrap } from './useFocusTrap';

// Load the pdf.js worker bundled inside react-pdf. Importing the app-level
// pdfjs-dist worker can drift from react-pdf's API version and break previews.
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const DEFAULT_RECT: AnnotationRect = { pageNumber: 1, x: 0.08, y: 0.08, width: 0.28, height: 0.08 };
const EMPTY_PAGE_ANNOTATIONS: DocumentAnnotationItem[] = [];

/**
 * Read-only in-browser document viewer (AGENTS.md §10a). Renders the version's
 * PDF rendition (or a source PDF/image) from a short-lived presigned URL. There
 * is NO editing affordance here — view-only users only ever see this.
 */
export function DocumentViewer({
  documentId,
  version,
  onClose,
}: {
  documentId: string;
  version: { id: string; fileName: string };
  onClose: () => void;
}) {
  const { hasPermission, user } = useAuth();
  const queryClient = useQueryClient();
  const [numPages, setNumPages] = useState(0);
  const [draftRect, setDraftRect] = useState<AnnotationRect>(DEFAULT_RECT);
  const [draftType, setDraftType] = useState<AnnotationType>('comment');
  const [draftBody, setDraftBody] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const hasCommentPermission = hasPermission(PERMISSIONS.DOCUMENT_COMMENT);

  // Focus management + Escape-to-close (AGENTS.md §10c).
  useFocusTrap(true, dialogRef, onClose);

  const ticketQuery = useQuery({
    queryKey: ['view-url', documentId, version.id],
    queryFn: () => getViewUrl(documentId, version.id),
    // Presigned URLs are short-lived; don't cache stale ones.
    staleTime: 0,
    gcTime: 0,
  });
  const status = (ticketQuery.error as AxiosError | null)?.response?.status;
  const annotationsQuery = useQuery({
    queryKey: ['annotations', documentId, version.id],
    queryFn: () => listAnnotations(documentId, version.id),
  });
  // Stable empty-array fallback (not a fresh `[]` literal) so identity only
  // changes when the query actually returns new data — required for the
  // useMemo below to skip recomputation on unrelated re-renders.
  const annotations = annotationsQuery.data?.items ?? EMPTY_PAGE_ANNOTATIONS;
  // FINDING-008: group once per `annotations` change into a per-page map
  // instead of each AnnotationOverlay instance re-filtering the FULL array on
  // every render (previously O(pages x annotations) synchronous work per render).
  const annotationsByPage = useMemo(() => {
    const map = new Map<number, DocumentAnnotationItem[]>();
    for (const a of annotations) {
      const list = map.get(a.pageNumber);
      if (list) list.push(a);
      else map.set(a.pageNumber, [a]);
    }
    return map;
  }, [annotations]);
  const openCount = annotations.filter((a) => a.status === 'open').length;
  const canAnnotate = hasCommentPermission || annotationsQuery.data?.canAnnotate === true;
  const canComplianceDelete =
    annotationsQuery.data?.canComplianceDelete ??
    ((user?.roles.includes(ROLES.ADMIN) ||
      user?.roles.includes(ROLES.COMPLIANCE_OFFICER)) ??
      false);

  const invalidateAnnotations = () => {
    void queryClient.invalidateQueries({ queryKey: ['annotations', documentId, version.id] });
    void queryClient.invalidateQueries({ queryKey: ['document', documentId] });
  };
  const create = useMutation({
    mutationFn: () =>
      createAnnotation(documentId, version.id, {
        ...draftRect,
        type: draftType,
        body: draftBody.trim(),
      }),
    onSuccess: () => {
      setDraftBody('');
      setFormError(null);
      invalidateAnnotations();
    },
    onError: (err) => setFormError(apiErrorMessage(err, 'Could not save the annotation.')),
  });
  const resolve = useMutation({
    mutationFn: (annotationId: string) => resolveAnnotation(documentId, version.id, annotationId),
    onMutate: () => setActionError(null),
    onSuccess: invalidateAnnotations,
    onError: (err) => setActionError(apiErrorMessage(err, 'Could not resolve the annotation.')),
  });
  const reopen = useMutation({
    mutationFn: (annotationId: string) => reopenAnnotation(documentId, version.id, annotationId),
    onMutate: () => setActionError(null),
    onSuccess: invalidateAnnotations,
    onError: (err) => setActionError(apiErrorMessage(err, 'Could not reopen the annotation.')),
  });
  const remove = useMutation({
    mutationFn: (annotationId: string) => deleteAnnotation(documentId, version.id, annotationId),
    onMutate: () => setActionError(null),
    onSuccess: invalidateAnnotations,
    onError: (err) => setActionError(apiErrorMessage(err, 'Could not delete the annotation.')),
  });

  // FINDING-018: previously computed once from window.innerWidth at mount, so
  // resizing the browser (or rotating a tablet) while the viewer was open left
  // the page width stale. Tracks viewport width via a resize listener instead.
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const pageWidth = Math.min(900, Math.max(320, viewportWidth - 420));

  const submitAnnotation = (e: FormEvent) => {
    e.preventDefault();
    if (!draftBody.trim()) {
      setFormError('Comment is required.');
      return;
    }
    create.mutate();
  };

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex flex-col bg-slate-900/70 focus:outline-none"
      role="dialog"
      aria-modal="true"
      aria-label={`Viewing ${version.fileName}`}
      onMouseDown={onClose}
    >
      <div className="flex items-center justify-between border-b border-slate-700 bg-slate-900 px-5 py-3 text-white">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{version.fileName}</div>
          <div className="text-xs text-slate-400">Read-only preview</div>
        </div>
        <button
          className="rounded-md bg-slate-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-600"
          onClick={onClose}
        >
          Close
        </button>
      </div>

      <div
        className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="overflow-auto p-4">
        {ticketQuery.isLoading && (
          <div className="mx-auto max-w-3xl">
            <LoadingState label="Preparing preview…" />
          </div>
        )}
        {status === 404 && (
          <div className="mx-auto max-w-3xl">
            <ErrorState
              title="No preview available"
              description="This version has no viewable rendition yet. Download the original, or regenerate the rendition from the version list."
            />
          </div>
        )}
        {ticketQuery.isError && status !== 404 && (
          <div className="mx-auto max-w-3xl">
            <ErrorState
              description="We couldn't load the preview."
              onRetry={() => void ticketQuery.refetch()}
            />
          </div>
        )}
        {ticketQuery.data &&
          (ticketQuery.data.mimeType.startsWith('image/') ? (
            <div className="relative mx-auto w-fit">
              <img
                src={ticketQuery.data.url}
                alt={version.fileName}
                className="max-h-[calc(100vh-8rem)] max-w-full rounded bg-white shadow"
                onClick={(e) => canAnnotate && setDraftRect(rectFromClick(e, 1))}
              />
              <AnnotationOverlay annotationsByPage={annotationsByPage} pageNumber={1} />
            </div>
          ) : (
            <Document
              file={ticketQuery.data.url}
              onLoadSuccess={({ numPages: n }) => setNumPages(n)}
              loading={
                <div className="mx-auto max-w-3xl">
                  <LoadingState label="Rendering document…" />
                </div>
              }
              error={
                <div className="mx-auto max-w-3xl">
                  <ErrorState description="This document could not be rendered." />
                </div>
              }
              className="flex flex-col items-center gap-4"
            >
              {Array.from({ length: numPages }, (_, i) => (
                <div key={i} className="relative" style={{ width: pageWidth }}>
                  <Page
                    pageNumber={i + 1}
                    width={pageWidth}
                    renderTextLayer={false}
                    renderAnnotationLayer={false}
                    className="rounded bg-white shadow"
                    onClick={(e) => canAnnotate && setDraftRect(rectFromClick(e, i + 1))}
                  />
                  <AnnotationOverlay annotationsByPage={annotationsByPage} pageNumber={i + 1} />
                </div>
              ))}
            </Document>
          ))}
        </div>

        <AnnotationPanel
          annotations={annotations}
          loading={annotationsQuery.isLoading}
          error={annotationsQuery.isError}
          openCount={openCount}
          canComment={canAnnotate}
          currentUserId={user?.id ?? null}
          canComplianceDelete={canComplianceDelete}
          draftRect={draftRect}
          draftType={draftType}
          draftBody={draftBody}
          formError={formError}
          actionError={actionError}
          busy={create.isPending}
          actionBusy={resolve.isPending || reopen.isPending || remove.isPending}
          onRectChange={setDraftRect}
          onTypeChange={setDraftType}
          onBodyChange={setDraftBody}
          onSubmit={submitAnnotation}
          onResolve={(id) => resolve.mutate(id)}
          onReopen={(id) => reopen.mutate(id)}
          onDelete={(id) => remove.mutate(id)}
          onRetry={() => void annotationsQuery.refetch()}
        />
      </div>
    </div>
  );
}

function rectFromClick(e: MouseEvent<HTMLElement>, pageNumber: number): AnnotationRect {
  const box = e.currentTarget.getBoundingClientRect();
  const x = Math.min(Math.max((e.clientX - box.left) / box.width, 0), 0.92);
  const y = Math.min(Math.max((e.clientY - box.top) / box.height, 0), 0.92);
  return { pageNumber, x, y, width: 0.08, height: 0.05 };
}

function AnnotationOverlay({
  annotationsByPage,
  pageNumber,
}: {
  annotationsByPage: Map<number, DocumentAnnotationItem[]>;
  pageNumber: number;
}) {
  const pageAnnotations = annotationsByPage.get(pageNumber) ?? EMPTY_PAGE_ANNOTATIONS;
  return (
    <div className="pointer-events-none absolute inset-0">
      {pageAnnotations.map((a) => (
        <div
          key={a.id}
          className={`absolute rounded border-2 ${
            a.status === 'open'
              ? 'border-amber-500 bg-amber-200/25'
              : 'border-emerald-500 bg-emerald-200/20'
          }`}
          style={{
            left: `${a.x * 100}%`,
            top: `${a.y * 100}%`,
            width: `${a.width * 100}%`,
            height: `${a.height * 100}%`,
          }}
          title={a.body}
        />
      ))}
    </div>
  );
}

function AnnotationPanel({
  annotations,
  loading,
  error,
  openCount,
  canComment,
  currentUserId,
  canComplianceDelete,
  draftRect,
  draftType,
  draftBody,
  formError,
  actionError,
  busy,
  actionBusy,
  onRectChange,
  onTypeChange,
  onBodyChange,
  onSubmit,
  onResolve,
  onReopen,
  onDelete,
  onRetry,
}: {
  annotations: DocumentAnnotationItem[];
  loading: boolean;
  error: boolean;
  openCount: number;
  canComment: boolean;
  currentUserId: string | null;
  canComplianceDelete: boolean;
  draftRect: AnnotationRect;
  draftType: AnnotationType;
  draftBody: string;
  formError: string | null;
  actionError: string | null;
  busy: boolean;
  actionBusy: boolean;
  onRectChange: (rect: AnnotationRect) => void;
  onTypeChange: (type: AnnotationType) => void;
  onBodyChange: (body: string) => void;
  onSubmit: (e: FormEvent) => void;
  onResolve: (id: string) => void;
  onReopen: (id: string) => void;
  onDelete: (id: string) => void;
  onRetry: () => void;
}) {
  const sorted = useMemo(
    () => [...annotations].sort((a, b) => (a.status === b.status ? a.pageNumber - b.pageNumber : a.status === 'open' ? -1 : 1)),
    [annotations],
  );

  return (
    <aside className="flex min-h-0 flex-col border-l border-slate-700 bg-white">
      <div className="border-b border-slate-200 px-4 py-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
            Annotations
          </h2>
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
            {openCount} open
          </span>
        </div>
      </div>

      {canComment && (
        <form className="space-y-3 border-b border-slate-200 p-4" onSubmit={onSubmit}>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="ann-page" className="label">
                Page
              </label>
              <input
                id="ann-page"
                className="input"
                type="number"
                min={1}
                value={draftRect.pageNumber}
                onChange={(e) =>
                  onRectChange({ ...draftRect, pageNumber: Math.max(Number(e.target.value), 1) })
                }
              />
            </div>
            <div>
              <label htmlFor="ann-type" className="label">
                Type
              </label>
              <select
                id="ann-type"
                className="input"
                value={draftType}
                onChange={(e) => onTypeChange(e.target.value as AnnotationType)}
              >
                {ANNOTATION_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {ANNOTATION_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label htmlFor="ann-body" className="label">
              Comment
            </label>
            <textarea
              id="ann-body"
              className="input min-h-[82px]"
              value={draftBody}
              onChange={(e) => onBodyChange(e.target.value)}
              maxLength={4000}
            />
          </div>
          {formError && (
            <p className="text-xs text-red-600" role="alert">
              {formError}
            </p>
          )}
          <button type="submit" className="btn-primary w-full !py-2 text-sm" disabled={busy}>
            {busy ? 'Saving...' : 'Add annotation'}
          </button>
        </form>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {actionError && (
          <p
            className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
            role="alert"
          >
            {actionError}
          </p>
        )}
        {loading ? (
          <LoadingState label="Loading annotations..." />
        ) : error ? (
          <ErrorState description="Could not load annotations." onRetry={onRetry} />
        ) : sorted.length === 0 ? (
          <p className="text-sm text-ink-muted">No annotations.</p>
        ) : (
          <ul className="space-y-3">
            {sorted.map((a) => {
              const canChange = canComment || a.authorId === currentUserId;
              const canDelete = canComplianceDelete || a.authorId === currentUserId;
              return (
                <li key={a.id} className="rounded-lg border border-slate-200 p-3 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-medium text-ink">
                        {ANNOTATION_TYPE_LABELS[a.type]} - page {a.pageNumber}
                      </div>
                      <div className="text-xs text-ink-muted">
                        {a.authorName ?? 'Unknown'} - {a.status === 'open' ? 'Open' : 'Resolved'}
                      </div>
                    </div>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        a.status === 'open'
                          ? 'bg-amber-100 text-amber-800'
                          : 'bg-emerald-100 text-emerald-800'
                      }`}
                    >
                      {a.status}
                    </span>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-ink-soft">{a.body}</p>
                  {(canChange || canDelete) && (
                    <div className="mt-3 flex flex-wrap justify-end gap-2">
                      {canChange &&
                        (a.status === 'open' ? (
                          <button
                            className="btn-secondary !px-2 !py-1 text-xs"
                            disabled={actionBusy}
                            onClick={() => onResolve(a.id)}
                          >
                            Resolve
                          </button>
                        ) : (
                          <button
                            className="btn-secondary !px-2 !py-1 text-xs"
                            disabled={actionBusy}
                            onClick={() => onReopen(a.id)}
                          >
                            Reopen
                          </button>
                        ))}
                      {canDelete && (
                        <button
                          className="btn-danger !px-2 !py-1 text-xs"
                          disabled={actionBusy}
                          onClick={() => onDelete(a.id)}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}

export default DocumentViewer;
