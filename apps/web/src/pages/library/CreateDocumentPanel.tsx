import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { ACCESS_LEVELS, REVIEW_CADENCES } from '@policymanager/shared';
import { createDocument, type CreateDocumentInput } from '../../api/documents';
import { CategorySelectWithCreate } from '../../ui/CategorySelectWithCreate';
import { TagInput } from '../../ui/TagInput';

export function CreateDocumentPanel({
  categoryOptions,
  onClose,
}: {
  categoryOptions: { id: string; name: string; depth: number }[];
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<CreateDocumentInput>({ title: '', tags: [] });
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const titleInvalid = touched && form.title.trim().length === 0;

  const mutation = useMutation({
    mutationFn: createDocument,
    onSuccess: (doc) => {
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      navigate(`/library/${doc.id}`);
    },
    onError: (err) => {
      const status = (err as AxiosError).response?.status;
      setError(
        status === 409
          ? 'A document with that document number already exists.'
          : 'Unable to create the document. Please check the form and try again.',
      );
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (form.title.trim().length === 0) return;
    mutation.mutate({
      title: form.title.trim(),
      documentNumber: form.documentNumber?.trim() || undefined,
      categoryId: form.categoryId || undefined,
      description: form.description?.trim() || undefined,
      tags: form.tags,
      accessLevel: form.accessLevel,
      reviewCadence: form.reviewCadence,
      nextReviewDate: form.nextReviewDate || undefined,
    });
  };

  return (
    <form className="card space-y-4 p-6" onSubmit={onSubmit} aria-label="Create document">
      <h2 className="text-sm font-semibold text-ink">New document</h2>
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label htmlFor="cd-title" className="label">
            Title <span className="text-red-600">*</span>
          </label>
          <input
            id="cd-title"
            className="input"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            onBlur={() => setTouched(true)}
            aria-invalid={titleInvalid}
            aria-describedby={titleInvalid ? 'cd-title-err' : undefined}
            required
          />
          {titleInvalid && (
            <p id="cd-title-err" className="mt-1 text-xs text-red-600">
              Title is required.
            </p>
          )}
        </div>
        <div>
          <label htmlFor="cd-number" className="label">
            Document number
          </label>
          <input
            id="cd-number"
            className="input"
            placeholder="PP-042"
            value={form.documentNumber ?? ''}
            onChange={(e) => setForm({ ...form, documentNumber: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor="cd-category" className="label">
            Category
          </label>
          <CategorySelectWithCreate
            id="cd-category"
            value={form.categoryId ?? ''}
            categoryOptions={categoryOptions}
            onChange={(categoryId) => setForm({ ...form, categoryId: categoryId || undefined })}
          />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="cd-desc" className="label">
            Description
          </label>
          <textarea
            id="cd-desc"
            className="input min-h-[80px]"
            value={form.description ?? ''}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </div>
        <div className="sm:col-span-2">
          <span className="label">Tags</span>
          <TagInput
            value={form.tags ?? []}
            onChange={(tags) => setForm({ ...form, tags })}
            ariaLabel="Document tags"
          />
        </div>
        <div>
          <label htmlFor="cd-access" className="label">
            Access level
          </label>
          <select
            id="cd-access"
            className="input"
            value={form.accessLevel ?? ''}
            onChange={(e) =>
              setForm({ ...form, accessLevel: (e.target.value || undefined) as CreateDocumentInput['accessLevel'] })
            }
          >
            <option value="">Default (restricted)</option>
            {ACCESS_LEVELS.map((a) => (
              <option key={a} value={a}>
                {a.charAt(0).toUpperCase() + a.slice(1)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="cd-cadence" className="label">
            Review cadence
          </label>
          <select
            id="cd-cadence"
            className="input"
            value={form.reviewCadence ?? ''}
            onChange={(e) =>
              setForm({ ...form, reviewCadence: (e.target.value || undefined) as CreateDocumentInput['reviewCadence'] })
            }
          >
            <option value="">None</option>
            {REVIEW_CADENCES.filter((c) => c !== 'none').map((c) => (
              <option key={c} value={c}>
                {c.charAt(0).toUpperCase() + c.slice(1)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="cd-review" className="label">
            Next review date
          </label>
          <input
            id="cd-review"
            type="date"
            className="input"
            value={form.nextReviewDate ?? ''}
            onChange={(e) => setForm({ ...form, nextReviewDate: e.target.value })}
          />
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn-primary" disabled={mutation.isPending}>
          {mutation.isPending ? 'Creating…' : 'Create document'}
        </button>
      </div>
    </form>
  );
}
