import { FormEvent, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { createCategory, type FlatCategory } from '../api/categories';

/**
 * Category picker with inline creation. This is the UI surface for
 * `POST /document-categories`: document writers can build the folder tree from
 * the document workflow instead of needing a separate admin screen.
 */
export function CategorySelectWithCreate({
  id,
  value,
  categoryOptions,
  onChange,
}: {
  id: string;
  value: string;
  categoryOptions: FlatCategory[];
  onChange: (categoryId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [localOptions, setLocalOptions] = useState<FlatCategory[]>([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  const options = [...categoryOptions, ...localOptions];
  const create = useMutation({
    mutationFn: () =>
      createCategory({
        name: name.trim(),
        parentId: parentId || undefined,
        description: description.trim() || undefined,
      }),
    onSuccess: (category) => {
      const parent = options.find((c) => c.id === category.parentId);
      const created = {
        id: category.id,
        name: category.name,
        depth: parent ? parent.depth + 1 : 0,
      };
      setLocalOptions((current) =>
        current.some((c) => c.id === category.id) ? current : [...current, created],
      );
      onChange(category.id);
      setName('');
      setDescription('');
      setParentId('');
      setAdding(false);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['category-tree'] });
    },
    onError: (err) => {
      const status = (err as AxiosError).response?.status;
      setError(
        status === 409
          ? 'A category with that name already exists here.'
          : status === 400
            ? 'Choose a valid parent category.'
            : 'Could not create the category. Please try again.',
      );
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError('Category name is required.');
      return;
    }
    setError(null);
    create.mutate();
  };

  return (
    <div className="space-y-2">
      <select
        id={id}
        className="input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Uncategorized</option>
        {options.map((c) => (
          <option key={c.id} value={c.id}>
            {`${' '.repeat(c.depth * 2)}${c.name}`}
          </option>
        ))}
      </select>
      {!adding ? (
        <button
          type="button"
          className="text-xs font-medium text-brand-600 hover:underline"
          onClick={() => {
            setParentId(value);
            setAdding(true);
          }}
        >
          New category
        </button>
      ) : (
        <form
          className="rounded-lg border border-slate-200 bg-slate-50 p-3"
          onSubmit={submit}
          aria-label="Create category"
          noValidate
        >
          {error && (
            <div
              className="mb-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700"
              role="alert"
            >
              {error}
            </div>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <label htmlFor={`${id}-new-name`} className="label">
                Category name <span className="text-red-600">*</span>
              </label>
              <input
                id={`${id}-new-name`}
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div>
              <label htmlFor={`${id}-new-parent`} className="label">
                Parent
              </label>
              <select
                id={`${id}-new-parent`}
                className="input"
                value={parentId}
                onChange={(e) => setParentId(e.target.value)}
              >
                <option value="">Root category</option>
                {options.map((c) => (
                  <option key={c.id} value={c.id}>
                    {`${' '.repeat(c.depth * 2)}${c.name}`}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="mt-2">
            <label htmlFor={`${id}-new-description`} className="label">
              Description <span className="font-normal text-ink-muted">(optional)</span>
            </label>
            <input
              id={`${id}-new-description`}
              className="input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              className="btn-secondary !py-1.5 text-sm"
              onClick={() => {
                setAdding(false);
                setError(null);
              }}
              disabled={create.isPending}
            >
              Cancel
            </button>
            <button type="submit" className="btn-primary !py-1.5 text-sm" disabled={create.isPending}>
              {create.isPending ? 'Creating...' : 'Create category'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
