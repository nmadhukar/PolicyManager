import { FormEvent, ReactNode, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import {
  ACCESS_LEVELS,
  DOCUMENT_STATUSES,
  DOCUMENT_DUE_STATE_LABELS,
  DOCUMENT_DUE_STATES,
  EXTRACTION_STATUSES,
  EXTRACTION_STATUS_LABELS,
  PERMISSIONS,
  REVIEW_CADENCES,
  type DocumentSortField,
  type DocumentDueState,
  type DocumentStatus,
  type SavedSearchItem,
  type ExtractionStatus,
  type ReviewCadence,
  type SortOrder,
} from '@policymanager/shared';
import {
  archiveDocument,
  bulkUpdateReviewSchedule,
  type BulkReviewScheduleInput,
  CreateDocumentInput,
  createDocument,
  type DocumentListItem,
  DocumentListParams,
  listDocuments,
  restoreDocument,
  softDeleteDocument,
  unarchiveDocument,
} from '../api/documents';
import {
  createSavedSearch,
  deleteSavedSearch,
  listSavedSearches,
  runSavedSearch,
} from '../api/savedSearches';
import { flattenCategories, listCategoryTree } from '../api/categories';
import { listUsers } from '../api/users';
import { useAuth } from '../auth/AuthContext';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import { apiErrorMessage } from '../lib/apiError';
import { formatDate, statusBadgeClasses, statusLabel } from '../lib/format';
import { AppShell } from '../ui/AppShell';
import { CategorySelectWithCreate } from '../ui/CategorySelectWithCreate';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState, ErrorState, ForbiddenState, LoadingState } from '../ui/states';
import { TagInput } from '../ui/TagInput';
import { useToast } from '../ui/Toast';

/** Library scope: active (default), archived-only, or the soft-delete trash. */
type LibraryView = 'active' | 'archived' | 'trash';

interface Filters {
  q: string;
  categoryId: string;
  ownerId: string;
  tag: string;
  tags: string;
  status: string;
  accessLevel: string;
  extractionStatus: string;
  reviewAfter: string;
  reviewBefore: string;
  effectiveAfter: string;
  effectiveBefore: string;
  dueState: string;
}

const EMPTY_FILTERS: Filters = {
  q: '',
  categoryId: '',
  ownerId: '',
  tag: '',
  tags: '',
  status: '',
  accessLevel: '',
  extractionStatus: '',
  reviewAfter: '',
  reviewBefore: '',
  effectiveAfter: '',
  effectiveBefore: '',
  dueState: '',
};

const PAGE_SIZE = 20;

export function LibraryPage() {
  const { hasPermission } = useAuth();
  return (
    <AppShell>
      <div className="mx-auto max-w-6xl">
        {hasPermission(PERMISSIONS.DOCUMENT_READ) ? <Library /> : <ForbiddenState />}
      </div>
    </AppShell>
  );
}

function Library() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission(PERMISSIONS.DOCUMENT_WRITE);
  const canManageReviews = hasPermission(PERMISSIONS.REVIEW_MANAGE);
  const canManageUsers = hasPermission(PERMISSIONS.USER_MANAGE);

  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [view, setView] = useState<LibraryView>('active');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<DocumentSortField>('createdAt');
  const [order, setOrder] = useState<SortOrder>('desc');
  const [showCreate, setShowCreate] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const debouncedQ = useDebouncedValue(filters.q, 300);
  const debouncedTag = useDebouncedValue(filters.tag, 300);

  const params: DocumentListParams = useMemo(
    () => ({
      q: debouncedQ || undefined,
      categoryId: filters.categoryId || undefined,
      ownerId: filters.ownerId || undefined,
      tag: debouncedTag || undefined,
      tags: filters.tags || undefined,
      // The Archived view forces status=archived; other views honor the filter.
      status:
        view === 'archived' ? 'archived' : (filters.status as DocumentStatus) || undefined,
      accessLevel: (filters.accessLevel as DocumentListParams['accessLevel']) || undefined,
      extractionStatus:
        (filters.extractionStatus as DocumentListParams['extractionStatus']) || undefined,
      reviewAfter: filters.reviewAfter || undefined,
      reviewBefore: filters.reviewBefore || undefined,
      effectiveAfter: filters.effectiveAfter || undefined,
      effectiveBefore: filters.effectiveBefore || undefined,
      dueState: filters.dueState || undefined,
      // Trash view is the only place soft-deleted rows appear (server also
      // enforces document.write for this).
      deleted: view === 'trash' ? true : undefined,
      page,
      pageSize: PAGE_SIZE,
      sort,
      order,
    }),
    [debouncedQ, debouncedTag, filters, page, sort, order, view],
  );

  const query = useQuery({
    queryKey: ['documents', params],
    queryFn: () => listDocuments(params),
    placeholderData: keepPreviousData,
  });

  useEffect(() => {
    setSelectedIds(new Set());
  }, [params]);

  const categoriesQuery = useQuery({ queryKey: ['category-tree'], queryFn: listCategoryTree });
  const categoryOptions = useMemo(
    () => flattenCategories(categoriesQuery.data ?? []),
    [categoriesQuery.data],
  );

  // Prefer the full user directory for the owner filter (admins); gracefully fall
  // back to owners seen across loaded result pages when that endpoint is 403/empty.
  const usersQuery = useQuery({
    queryKey: ['users'],
    queryFn: listUsers,
    enabled: canManageUsers,
    retry: false,
  });
  const savedSearchesQuery = useQuery({
    queryKey: ['saved-searches'],
    queryFn: listSavedSearches,
  });

  const [ownerOptions, setOwnerOptions] = useState<Map<string, string>>(new Map());
  // State update lives in an effect (not render/useMemo) to avoid a setState-in-render.
  useEffect(() => {
    setOwnerOptions((prev) => {
      const next = new Map(prev);
      for (const u of usersQuery.data ?? []) next.set(u.id, u.name);
      for (const item of query.data?.items ?? []) {
        if (item.ownerName) next.set(item.ownerId, item.ownerName);
      }
      return next;
    });
  }, [usersQuery.data, query.data]);

  const patch = (part: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...part }));
    setPage(1);
  };

  const changeSort = (field: DocumentSortField) => {
    if (sort === field) {
      setOrder((o) => (o === 'asc' ? 'desc' : 'asc'));
    } else {
      setSort(field);
      setOrder(field === 'title' ? 'asc' : 'desc');
    }
    setPage(1);
  };

  const changeView = (next: LibraryView) => {
    setView(next);
    setPage(1);
  };

  const forbidden = (query.error as AxiosError | null)?.response?.status === 403;

  const total = query.data?.total ?? 0;
  const totalPages = Math.max(Math.ceil(total / PAGE_SIZE), 1);
  const items = query.data?.items ?? [];

  const activeChips = buildActiveChips(filters, categoryOptions, ownerOptions);
  const bulkSchedulingEnabled = canManageReviews && view !== 'trash';
  const toggleSelected = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleVisible = () => {
    const visibleIds = items.map((doc) => doc.id);
    const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const id of visibleIds) {
        if (allVisibleSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };
  const clearSelected = () => setSelectedIds(new Set());

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Document Library</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Search, filter, and manage your clinic&apos;s controlled documents.
          </p>
        </div>
        {canWrite && view === 'active' && (
          <button className="btn-primary" onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? 'Close' : 'New document'}
          </button>
        )}
      </header>

      <ViewTabs view={view} onChange={changeView} canWrite={canWrite} />

      {showCreate && canWrite && view === 'active' && (
        <CreateDocumentPanel
          categoryOptions={categoryOptions}
          onClose={() => setShowCreate(false)}
        />
      )}

      <FiltersBar
        filters={filters}
        onChange={patch}
        categoryOptions={categoryOptions}
        ownerOptions={ownerOptions}
      >
        <SavedSearchControls
          filters={filters}
          sort={sort}
          order={order}
          searches={savedSearchesQuery.data ?? []}
          onApply={(next, nextSort, nextOrder) => {
            setFilters({ ...EMPTY_FILTERS, ...next });
            if (nextSort) setSort(nextSort);
            if (nextOrder) setOrder(nextOrder);
            setPage(1);
          }}
        />
      </FiltersBar>

      {bulkSchedulingEnabled && (
        <BulkReviewSchedulePanel
          selectedIds={[...selectedIds]}
          totalMatching={total}
          filters={bulkScheduleFilters(params)}
          onDone={clearSelected}
        />
      )}

      {activeChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-2" aria-label="Active filters">
          {activeChips.map((chip) => (
            <button
              key={chip.key}
              className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-white px-3 py-1 text-xs text-ink-soft hover:bg-slate-50"
              onClick={() => patch({ [chip.key]: '' } as Partial<Filters>)}
            >
              <span className="text-ink-muted">{chip.label}:</span>
              <span className="font-medium text-ink">{chip.value}</span>
              <span aria-hidden className="text-ink-muted">
                ✕
              </span>
              <span className="sr-only">Remove filter</span>
            </button>
          ))}
          <button
            className="text-xs font-medium text-brand-600 hover:underline"
            onClick={() => {
              setFilters(EMPTY_FILTERS);
              setPage(1);
            }}
          >
            Clear all
          </button>
        </div>
      )}

      {query.isLoading ? (
        <LoadingState label="Loading documents…" />
      ) : forbidden ? (
        <ForbiddenState />
      ) : query.isError ? (
        <ErrorState
          description="We couldn't load the document library."
          onRetry={() => void query.refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState
          title={
            view === 'trash'
              ? 'Trash is empty'
              : view === 'archived'
                ? 'No archived documents'
                : 'No documents found'
          }
          description={
            view === 'trash'
              ? 'Deleted documents appear here and can be restored.'
              : view === 'archived'
                ? 'Documents you archive will appear here.'
                : activeChips.length > 0
                  ? 'Try adjusting or clearing your filters.'
                  : 'Create your first document to get started.'
          }
          action={
            canWrite && view === 'active' && activeChips.length === 0 ? (
              <button className="btn-primary" onClick={() => setShowCreate(true)}>
                New document
              </button>
            ) : undefined
          }
        />
      ) : (
        <DocumentsTable
          items={items}
          view={view}
          canWrite={canWrite}
          bulkSelectable={bulkSchedulingEnabled}
          selectedIds={selectedIds}
          sort={sort}
          order={order}
          onSort={changeSort}
          onToggleSelected={toggleSelected}
          onToggleVisible={toggleVisible}
          isFetching={query.isFetching}
        />
      )}

      {items.length > 0 && (
        <Pagination
          page={page}
          totalPages={totalPages}
          total={total}
          onPrev={() => setPage((p) => Math.max(p - 1, 1))}
          onNext={() => setPage((p) => Math.min(p + 1, totalPages))}
        />
      )}
    </div>
  );
}

interface ChipInfo {
  key: keyof Filters;
  label: string;
  value: string;
}

function buildActiveChips(
  filters: Filters,
  categoryOptions: { id: string; name: string }[],
  ownerOptions: Map<string, string>,
): ChipInfo[] {
  const chips: ChipInfo[] = [];
  if (filters.q) chips.push({ key: 'q', label: 'Search', value: filters.q });
  if (filters.categoryId) {
    chips.push({
      key: 'categoryId',
      label: 'Category',
      value: categoryOptions.find((c) => c.id === filters.categoryId)?.name ?? 'Selected',
    });
  }
  if (filters.ownerId) {
    chips.push({
      key: 'ownerId',
      label: 'Owner',
      value: ownerOptions.get(filters.ownerId) ?? 'Selected',
    });
  }
  if (filters.tag) chips.push({ key: 'tag', label: 'Tag', value: filters.tag });
  if (filters.tags) chips.push({ key: 'tags', label: 'Tags', value: filters.tags });
  if (filters.status) {
    chips.push({ key: 'status', label: 'Status', value: statusLabel(filters.status as DocumentStatus) });
  }
  if (filters.accessLevel) {
    chips.push({ key: 'accessLevel', label: 'Access', value: filters.accessLevel });
  }
  if (filters.extractionStatus) {
    chips.push({
      key: 'extractionStatus',
      label: 'Extraction',
      value: EXTRACTION_STATUS_LABELS[filters.extractionStatus as ExtractionStatus],
    });
  }
  if (filters.reviewAfter) {
    chips.push({ key: 'reviewAfter', label: 'Review after', value: filters.reviewAfter });
  }
  if (filters.reviewBefore) {
    chips.push({ key: 'reviewBefore', label: 'Review before', value: filters.reviewBefore });
  }
  if (filters.effectiveAfter) {
    chips.push({ key: 'effectiveAfter', label: 'Effective after', value: filters.effectiveAfter });
  }
  if (filters.effectiveBefore) {
    chips.push({ key: 'effectiveBefore', label: 'Effective before', value: filters.effectiveBefore });
  }
  if (filters.dueState) {
    chips.push({
      key: 'dueState',
      label: 'Quick filter',
      value: DOCUMENT_DUE_STATE_LABELS[filters.dueState as DocumentDueState],
    });
  }
  return chips;
}

function SavedSearchControls({
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

function sanitizeSavedFilters(value: Record<string, unknown>): Partial<Filters> {
  const next: Partial<Filters> = {};
  for (const key of Object.keys(EMPTY_FILTERS) as (keyof Filters)[]) {
    const raw = value[key];
    if (typeof raw === 'string') next[key] = raw;
  }
  return next;
}

function bulkScheduleFilters(
  params: DocumentListParams,
): NonNullable<BulkReviewScheduleInput['filters']> {
  const filterKeys: (keyof NonNullable<BulkReviewScheduleInput['filters']>)[] = [
    'q',
    'categoryId',
    'ownerId',
    'tag',
    'tags',
    'status',
    'accessLevel',
    'extractionStatus',
    'reviewBefore',
    'reviewAfter',
    'effectiveBefore',
    'effectiveAfter',
    'dueState',
    'includeArchived',
  ];
  const rest: Record<string, unknown> = {};
  for (const key of filterKeys) rest[key] = params[key];
  return Object.fromEntries(
    Object.entries(rest).filter(([, value]) => value !== undefined && value !== ''),
  ) as NonNullable<BulkReviewScheduleInput['filters']>;
}

function BulkReviewSchedulePanel({
  selectedIds,
  totalMatching,
  filters,
  onDone,
}: {
  selectedIds: string[];
  totalMatching: number;
  filters: NonNullable<BulkReviewScheduleInput['filters']>;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [reviewCadence, setReviewCadence] = useState<ReviewCadence>('annual');
  const [nextReviewDate, setNextReviewDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pendingTarget, setPendingTarget] = useState<'selected' | 'filtered' | null>(null);
  const requiresDate = reviewCadence !== 'none';

  const mutation = useMutation({
    mutationFn: (input: BulkReviewScheduleInput) => bulkUpdateReviewSchedule(input),
    onSuccess: (result) => {
      setPendingTarget(null);
      setError(null);
      onDone();
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      toast.success(`Updated ${result.updated} review schedule${result.updated === 1 ? '' : 's'}.`);
    },
    onError: (err) => {
      setPendingTarget(null);
      toast.error(apiErrorMessage(err, 'Could not update review schedules.'));
    },
  });

  const validate = (): boolean => {
    if (requiresDate && !nextReviewDate) {
      setError('Next review date is required.');
      return false;
    }
    setError(null);
    return true;
  };

  const requestSubmit = (target: 'selected' | 'filtered') => {
    if (target === 'selected' && selectedIds.length === 0) {
      setError('Select at least one document.');
      return;
    }
    if (target === 'filtered' && totalMatching === 0) {
      setError('No matching documents.');
      return;
    }
    if (!validate()) return;
    setPendingTarget(target);
  };

  const confirm = () => {
    if (!pendingTarget) return;
    mutation.mutate({
      ...(pendingTarget === 'selected' ? { documentIds: selectedIds } : { filters }),
      reviewCadence,
      nextReviewDate: reviewCadence === 'none' ? null : nextReviewDate,
    });
  };

  const targetCount = pendingTarget === 'selected' ? selectedIds.length : totalMatching;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="grid gap-3 lg:grid-cols-[minmax(9rem,1fr)_minmax(9rem,1fr)_auto_auto] lg:items-end">
        <div>
          <label htmlFor="bulk-review-cadence" className="label">
            Bulk review cadence
          </label>
          <select
            id="bulk-review-cadence"
            className="input"
            value={reviewCadence}
            onChange={(e) => setReviewCadence(e.target.value as ReviewCadence)}
          >
            {REVIEW_CADENCES.map((cadence) => (
              <option key={cadence} value={cadence}>
                {cadence.charAt(0).toUpperCase() + cadence.slice(1)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="bulk-review-date" className="label">
            Next review date
          </label>
          <input
            id="bulk-review-date"
            type="date"
            className="input"
            value={nextReviewDate}
            onChange={(e) => setNextReviewDate(e.target.value)}
            disabled={!requiresDate}
          />
        </div>
        <button
          type="button"
          className="btn-secondary whitespace-nowrap"
          onClick={() => requestSubmit('selected')}
          disabled={selectedIds.length === 0 || mutation.isPending}
        >
          Schedule selected ({selectedIds.length})
        </button>
        <button
          type="button"
          className="btn-primary whitespace-nowrap"
          onClick={() => requestSubmit('filtered')}
          disabled={totalMatching === 0 || mutation.isPending}
        >
          Schedule filtered ({totalMatching})
        </button>
      </div>
      {error && (
        <p className="mt-2 text-sm text-red-600" role="alert">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={pendingTarget !== null}
        title="Apply review schedule?"
        body={
          <>
            This will update <span className="font-medium text-ink">{targetCount}</span>{' '}
            document{targetCount === 1 ? '' : 's'} to{' '}
            <span className="font-medium text-ink">{reviewCadence}</span>
            {reviewCadence === 'none' ? '.' : ` due ${nextReviewDate}.`}
          </>
        }
        confirmLabel="Apply schedule"
        busy={mutation.isPending}
        onConfirm={confirm}
        onCancel={() => setPendingTarget(null)}
      />
    </div>
  );
}

// Detailed-filter fields that live inside the collapsible panel — everything
// except the always-visible search (`q`) and the quick-filter chips (`dueState`).
const ADVANCED_FILTER_KEYS: (keyof Filters)[] = [
  'categoryId',
  'ownerId',
  'tag',
  'tags',
  'status',
  'accessLevel',
  'extractionStatus',
  'reviewAfter',
  'reviewBefore',
  'effectiveAfter',
  'effectiveBefore',
];

function FiltersBar({
  filters,
  onChange,
  categoryOptions,
  ownerOptions,
  children,
}: {
  filters: Filters;
  onChange: (part: Partial<Filters>) => void;
  categoryOptions: { id: string; name: string; depth: number }[];
  ownerOptions: Map<string, string>;
  /** Extra collapsible content rendered below the filter grid (saved searches) —
   * hidden/shown by the same Filters toggle. */
  children?: ReactNode;
}) {
  const activeCount = useMemo(
    () => ADVANCED_FILTER_KEYS.filter((k) => filters[k] !== '').length,
    [filters],
  );
  // Open by default if any advanced filter is already applied (e.g. restored
  // from a saved search), so active filters aren't hidden.
  const [open, setOpen] = useState(activeCount > 0);

  return (
    <div className="card space-y-4 p-4">
      <div>
        <label htmlFor="lib-search" className="sr-only">
          Search documents
        </label>
        <input
          id="lib-search"
          className="input"
          type="search"
          placeholder="Search by title, number, or description…"
          value={filters.q}
          onChange={(e) => onChange({ q: e.target.value })}
        />
      </div>
      <div className="flex flex-wrap gap-2" aria-label="Compliance quick filters">
        {DOCUMENT_DUE_STATES.map((state) => {
          const active = filters.dueState === state;
          return (
            <button
              key={state}
              type="button"
              className={`rounded-md border px-3 py-1.5 text-xs font-medium ${
                active
                  ? 'border-brand-600 bg-brand-50 text-brand-700'
                  : 'border-slate-300 bg-white text-ink-soft hover:bg-slate-50'
              }`}
              onClick={() => onChange({ dueState: active ? '' : state })}
            >
              {DOCUMENT_DUE_STATE_LABELS[state]}
            </button>
          );
        })}
      </div>
      <div className="border-t border-slate-100 pt-3">
        <button
          type="button"
          className="flex items-center gap-2 text-sm font-medium text-ink-soft hover:text-brand-600"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="lib-advanced-filters"
        >
          <svg
            viewBox="0 0 20 20"
            className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.75}
            aria-hidden
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="m5 7.5 5 5 5-5" />
          </svg>
          Filters
          {activeCount > 0 && (
            <span className="rounded-full bg-brand-100 px-2 py-0.5 text-xs font-semibold text-brand-700">
              {activeCount}
            </span>
          )}
        </button>
      </div>
      {open && (
      <div id="lib-advanced-filters" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label htmlFor="lib-category" className="label">
            Category
          </label>
          <select
            id="lib-category"
            className="input"
            value={filters.categoryId}
            onChange={(e) => onChange({ categoryId: e.target.value })}
          >
            <option value="">All categories</option>
            {categoryOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {`${' '.repeat(c.depth * 2)}${c.name}`}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="lib-owner" className="label">
            Owner
          </label>
          <select
            id="lib-owner"
            className="input"
            value={filters.ownerId}
            onChange={(e) => onChange({ ownerId: e.target.value })}
          >
            <option value="">All owners</option>
            {[...ownerOptions.entries()].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="lib-status" className="label">
            Status
          </label>
          <select
            id="lib-status"
            className="input"
            value={filters.status}
            onChange={(e) => onChange({ status: e.target.value })}
          >
            <option value="">Any status</option>
            {DOCUMENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="lib-access" className="label">
            Access level
          </label>
          <select
            id="lib-access"
            className="input"
            value={filters.accessLevel}
            onChange={(e) => onChange({ accessLevel: e.target.value })}
          >
            <option value="">Any access</option>
            {ACCESS_LEVELS.map((a) => (
              <option key={a} value={a}>
                {a.charAt(0).toUpperCase() + a.slice(1)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="lib-extraction" className="label">
            Extraction
          </label>
          <select
            id="lib-extraction"
            className="input"
            value={filters.extractionStatus}
            onChange={(e) => onChange({ extractionStatus: e.target.value })}
          >
            <option value="">Any extraction</option>
            {EXTRACTION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {EXTRACTION_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="lib-tag" className="label">
            Tag
          </label>
          <input
            id="lib-tag"
            className="input"
            placeholder="e.g. CARF"
            value={filters.tag}
            onChange={(e) => onChange({ tag: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor="lib-tags" className="label">
            Tags
          </label>
          <input
            id="lib-tags"
            className="input"
            placeholder="CARF, JCAHO"
            value={filters.tags}
            onChange={(e) => onChange({ tags: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor="lib-review-after" className="label">
            Next review after
          </label>
          <input
            id="lib-review-after"
            type="date"
            className="input"
            value={filters.reviewAfter}
            onChange={(e) => onChange({ reviewAfter: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor="lib-review-before" className="label">
            Next review before
          </label>
          <input
            id="lib-review-before"
            type="date"
            className="input"
            value={filters.reviewBefore}
            onChange={(e) => onChange({ reviewBefore: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor="lib-effective-after" className="label">
            Effective after
          </label>
          <input
            id="lib-effective-after"
            type="date"
            className="input"
            value={filters.effectiveAfter}
            onChange={(e) => onChange({ effectiveAfter: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor="lib-effective-before" className="label">
            Effective before
          </label>
          <input
            id="lib-effective-before"
            type="date"
            className="input"
            value={filters.effectiveBefore}
            onChange={(e) => onChange({ effectiveBefore: e.target.value })}
          />
        </div>
      </div>
      )}
      {open && children && (
        <div className="border-t border-slate-100 pt-4">{children}</div>
      )}
    </div>
  );
}

const SORTABLE: { field: DocumentSortField; label: string }[] = [
  { field: 'title', label: 'Title' },
  { field: 'status', label: 'Status' },
  { field: 'nextReviewDate', label: 'Next review' },
];

function ViewTabs({
  view,
  onChange,
  canWrite,
}: {
  view: LibraryView;
  onChange: (v: LibraryView) => void;
  canWrite: boolean;
}) {
  const tabs: { key: LibraryView; label: string }[] = [
    { key: 'active', label: 'Active' },
    { key: 'archived', label: 'Archived' },
    ...(canWrite ? [{ key: 'trash' as const, label: 'Trash' }] : []),
  ];
  return (
    <div
      className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5"
      role="tablist"
      aria-label="Library view"
    >
      {tabs.map((t) => {
        const active = view === t.key;
        return (
          <button
            key={t.key}
            role="tab"
            aria-selected={active}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
              active ? 'bg-brand-600 text-white' : 'text-ink-soft hover:bg-slate-50'
            }`}
            onClick={() => onChange(t.key)}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function DocumentsTable({
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

function Pagination({
  page,
  totalPages,
  total,
  onPrev,
  onNext,
}: {
  page: number;
  totalPages: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <div className="flex items-center justify-between text-sm text-ink-muted">
      <span>
        Page {page} of {totalPages} · {total} document{total === 1 ? '' : 's'}
      </span>
      <div className="flex gap-2">
        <button className="btn-secondary" onClick={onPrev} disabled={page <= 1}>
          Previous
        </button>
        <button className="btn-secondary" onClick={onNext} disabled={page >= totalPages}>
          Next
        </button>
      </div>
    </div>
  );
}

function CreateDocumentPanel({
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
