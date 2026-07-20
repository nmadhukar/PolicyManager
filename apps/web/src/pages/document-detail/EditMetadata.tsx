import { FormEvent, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import {
  ACCESS_LEVELS,
  DOCUMENT_STATUSES,
  REVIEW_CADENCES,
  type DocumentDetail,
} from '@policymanager/shared';
import { UpdateDocumentInput, updateDocument } from '../../api/documents';
import { flattenCategories, listCategoryTree } from '../../api/categories';
import { formatDate, formatDateTime, statusLabel } from '../../lib/format';
import { CategorySelectWithCreate } from '../../ui/CategorySelectWithCreate';

/** The Details <dl> rows + optional Description block (no card, no header, no tags). */
export function MetadataBody({ doc }: { doc: DocumentDetail }) {
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
    <>
      <dl className="space-y-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4">
            <dt className="shrink-0 text-ink-muted">{label}</dt>
            <dd className="min-w-0 break-words text-right font-medium text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      {doc.description && (
        <div className="mt-4 border-t border-slate-100 pt-3">
          <dt className="text-xs uppercase tracking-wide text-ink-muted">Description</dt>
          {/* overflow-wrap:anywhere + whitespace-pre-wrap so a long unbroken
           * string (e.g. a pasted URL/error log) breaks and wraps inside the
           * card instead of overflowing its right edge. */}
          <dd className="mt-1 whitespace-pre-wrap text-sm text-ink-soft [overflow-wrap:anywhere]">
            {doc.description}
          </dd>
        </div>
      )}
    </>
  );
}

export function EditMetadata({ doc, onDone }: { doc: DocumentDetail; onDone: () => void }) {
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
