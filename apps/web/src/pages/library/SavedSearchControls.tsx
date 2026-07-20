import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type DocumentSortField, type SavedSearchItem, type SortOrder } from '@policymanager/shared';
import { createSavedSearch, deleteSavedSearch, runSavedSearch } from '../../api/savedSearches';
import { apiErrorMessage } from '../../lib/apiError';
import { useToast } from '../../ui/Toast';
import { EMPTY_FILTERS, type Filters } from './types';

export function sanitizeSavedFilters(value: Record<string, unknown>): Partial<Filters> {
  const next: Partial<Filters> = {};
  for (const key of Object.keys(EMPTY_FILTERS) as (keyof Filters)[]) {
    const raw = value[key];
    if (typeof raw === 'string') next[key] = raw;
  }
  return next;
}

export function SavedSearchControls({
  filters,
  sort,
  order,
  searches,
  onApply,
}: {
  filters: Filters;
  sort: DocumentSortField;
  order: SortOrder;
  searches: SavedSearchItem[];
  onApply: (filters: Partial<Filters>, sort?: DocumentSortField, order?: SortOrder) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const selected = searches.find((s) => s.id === selectedId);

  const save = useMutation({
    mutationFn: () =>
      createSavedSearch({
        name: name.trim(),
        scope: 'private',
        filters: { ...filters },
        sort: { field: sort, order },
      }),
    onSuccess: () => {
      setName('');
      void queryClient.invalidateQueries({ queryKey: ['saved-searches'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not save this search.')),
  });
  const remove = useMutation({
    mutationFn: () => deleteSavedSearch(selectedId),
    onSuccess: () => {
      setSelectedId('');
      void queryClient.invalidateQueries({ queryKey: ['saved-searches'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not delete this saved search.')),
  });
  const run = useMutation({
    mutationFn: (id: string) => runSavedSearch(id),
  });

  const apply = () => {
    if (!selected) return;
    void run.mutate(selected.id);
    const savedSort = selected.sort ?? {};
    const nextSort =
      typeof savedSort.field === 'string' ? (savedSort.field as DocumentSortField) : undefined;
    const nextOrder =
      savedSort.order === 'asc' || savedSort.order === 'desc'
        ? (savedSort.order as SortOrder)
        : undefined;
    onApply(sanitizeSavedFilters(selected.filters), nextSort, nextOrder);
  };

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-3">
      <div className="min-w-[13rem] flex-1">
        <label htmlFor="saved-search-select" className="label">
          Saved searches
        </label>
        <select
          id="saved-search-select"
          className="input"
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
        >
          <option value="">Choose saved search</option>
          {searches.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.scope !== 'private' ? ` (${s.scope})` : ''}
            </option>
          ))}
        </select>
      </div>
      <button className="btn-secondary" type="button" onClick={apply} disabled={!selected}>
        Apply
      </button>
      <button
        className="btn-secondary"
        type="button"
        onClick={() => remove.mutate()}
        disabled={!selected || remove.isPending}
      >
        Delete saved search
      </button>
      <div className="min-w-[12rem] flex-1">
        <label htmlFor="saved-search-name" className="label">
          Save current search
        </label>
        <input
          id="saved-search-name"
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Due soon policies"
        />
      </div>
      <button
        className="btn-primary"
        type="button"
        onClick={() => save.mutate()}
        disabled={!name.trim() || save.isPending}
      >
        Save
      </button>
    </div>
  );
}
