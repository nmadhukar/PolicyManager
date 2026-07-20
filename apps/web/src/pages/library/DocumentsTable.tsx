import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type DocumentSortField, type SortOrder } from '@policymanager/shared';
import {
  archiveDocument,
  restoreDocument,
  softDeleteDocument,
  unarchiveDocument,
  type DocumentListItem,
} from '../../api/documents';
import { apiErrorMessage } from '../../lib/apiError';
import { formatDate, statusBadgeClasses, statusLabel } from '../../lib/format';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { useToast } from '../../ui/Toast';
import type { LibraryView } from './types';

const SORTABLE: { field: DocumentSortField; label: string }[] = [
  { field: 'title', label: 'Title' },
  { field: 'status', label: 'Status' },
  { field: 'nextReviewDate', label: 'Next review' },
];

export function DocumentsTable({
  items,
  view,
  canWrite,
  bulkSelectable,
  selectedIds,
  sort,
  order,
  onSort,
  onToggleSelected,
  onToggleVisible,
  isFetching,
}: {
  items: DocumentListItem[];
  view: LibraryView;
  canWrite: boolean;
  bulkSelectable: boolean;
  selectedIds: Set<string>;
  sort: DocumentSortField;
  order: SortOrder;
  onSort: (field: DocumentSortField) => void;
  onToggleSelected: (id: string) => void;
  onToggleVisible: () => void;
  isFetching: boolean;
}) {
  const navigate = useNavigate();
  // Soft-deleted documents 404 on the detail route, so rows are not navigable
  // in the trash — the row exposes Restore instead.
  const navigable = view !== 'trash';
  const showActions = canWrite;
  const visibleIds = items.map((doc) => doc.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const arrow = (field: DocumentSortField) =>
    sort === field ? (order === 'asc' ? ' ▲' : ' ▼') : '';

  const header = (field: DocumentSortField, label: string) => (
    <th key={field} scope="col" className="px-4 py-3 font-medium">
      <button
        className="inline-flex items-center font-medium text-ink-muted hover:text-ink"
        onClick={() => onSort(field)}
        aria-label={`Sort by ${label}`}
      >
        {label}
        <span aria-hidden>{arrow(field)}</span>
      </button>
    </th>
  );

  return (
    <div className={`card overflow-x-auto ${isFetching ? 'opacity-70' : ''}`} aria-busy={isFetching}>
      <table className="w-full min-w-[760px] text-left text-sm">
        <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-ink-muted">
          <tr>
            {bulkSelectable && (
              <th scope="col" className="w-10 px-4 py-3">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600"
                  aria-label="Select all visible documents"
                  checked={allVisibleSelected}
                  onChange={onToggleVisible}
                />
              </th>
            )}
            {SORTABLE.map((s) =>
              s.field === 'nextReviewDate' ? null : header(s.field, s.label),
            )}
            <th scope="col" className="px-4 py-3 font-medium">
              Category
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {view === 'trash' ? 'Deleted by' : 'Owner'}
            </th>
            {header('nextReviewDate', 'Next review')}
            {showActions && (
              <th scope="col" className="px-4 py-3 text-right font-medium">
                Actions
              </th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {items.map((doc) => (
            <tr
              key={doc.id}
              className={
                navigable
                  ? 'cursor-pointer hover:bg-slate-50 focus-within:bg-slate-50'
                  : 'hover:bg-slate-50'
              }
              onClick={navigable ? () => navigate(`/library/${doc.id}`) : undefined}
            >
              {bulkSelectable && (
                <td className="px-4 py-3 align-top">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600"
                    aria-label={`Select ${doc.title}`}
                    checked={selectedIds.has(doc.id)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => onToggleSelected(doc.id)}
                  />
                </td>
              )}
              <td className="px-4 py-3 align-top">
                {navigable ? (
                  <button
                    className="text-left font-medium text-brand-700 hover:underline"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(`/library/${doc.id}`);
                    }}
                  >
                    {doc.title}
                  </button>
                ) : (
                  <span className="font-medium text-ink">{doc.title}</span>
                )}
                {doc.documentNumber && (
                  <div className="text-xs text-ink-muted">{doc.documentNumber}</div>
                )}
              </td>
              <td className="px-4 py-3 align-top">
                <span
                  className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${statusBadgeClasses(
                    doc.status,
                  )}`}
                >
                  {statusLabel(doc.status)}
                </span>
                {doc.deletedAt && (
                  <span className="ml-1.5 inline-flex rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-700">
                    Deleted
                  </span>
                )}
              </td>
              <td className="px-4 py-3 align-top text-ink-soft">{doc.categoryName ?? '—'}</td>
              <td className="px-4 py-3 align-top text-ink-soft">
                {view === 'trash' ? (doc.deletedByName ?? '—') : (doc.ownerName ?? '—')}
              </td>
              <td className="px-4 py-3 align-top text-ink-soft">{formatDate(doc.nextReviewDate)}</td>
              {showActions && (
                <td className="px-4 py-3 text-right align-top">
                  <RowActions doc={doc} view={view} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Per-row soft-delete / restore / archive actions (write users only). */
function RowActions({ doc, view }: { doc: DocumentListItem; view: LibraryView }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['documents'] });

  const del = useMutation({
    mutationFn: () => softDeleteDocument(doc.id),
    onSuccess: () => {
      setConfirmDelete(false);
      void invalidate();
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not delete the document.')),
  });
  const restore = useMutation({
    mutationFn: () => restoreDocument(doc.id),
    onSuccess: invalidate,
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not restore the document.')),
  });
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

  const busy = del.isPending || restore.isPending || archive.isPending || unarchive.isPending;
  const btn = 'btn-secondary !px-2.5 !py-1 text-xs';

  return (
    <div className="inline-flex justify-end gap-2" onClick={(e) => e.stopPropagation()}>
      {view === 'trash' ? (
        <button className={btn} onClick={() => restore.mutate()} disabled={busy}>
          {restore.isPending ? '…' : 'Restore'}
        </button>
      ) : (
        <>
          {doc.status === 'archived' ? (
            <button className={btn} onClick={() => unarchive.mutate()} disabled={busy}>
              {unarchive.isPending ? '…' : 'Unarchive'}
            </button>
          ) : (
            <button className={btn} onClick={() => archive.mutate()} disabled={busy}>
              {archive.isPending ? '…' : 'Archive'}
            </button>
          )}
          <button
            className="btn-danger !px-2.5 !py-1 text-xs"
            onClick={() => setConfirmDelete(true)}
            disabled={busy}
          >
            Delete
          </button>
        </>
      )}
      <ConfirmDialog
        open={confirmDelete}
        title="Move to trash?"
        body={
          <>
            <span className="font-medium text-ink">{doc.title}</span> will be moved to the trash.
            Nothing is permanently deleted — you can restore it later.
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
