import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import {
  DOCUMENT_DUE_STATE_LABELS,
  EXTRACTION_STATUS_LABELS,
  PERMISSIONS,
  type DocumentSortField,
  type DocumentDueState,
  type DocumentStatus,
  type ExtractionStatus,
  type SortOrder,
} from '@policymanager/shared';
import { listDocuments, type DocumentListParams } from '../api/documents';
import { listSavedSearches } from '../api/savedSearches';
import { flattenCategories, listCategoryTree } from '../api/categories';
import { listUsers } from '../api/users';
import { useAuth } from '../auth/AuthContext';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import { statusLabel } from '../lib/format';
import { AppShell } from '../ui/AppShell';
import { EmptyState, ErrorState, ForbiddenState, LoadingState } from '../ui/states';
import { BulkReviewSchedulePanel, bulkScheduleFilters } from './library/BulkReviewSchedulePanel';
import { CreateDocumentPanel } from './library/CreateDocumentPanel';
import { DocumentsTable } from './library/DocumentsTable';
import { FiltersBar } from './library/LibraryFilters';
import { Pagination } from './library/Pagination';
import { SavedSearchControls } from './library/SavedSearchControls';
import { EMPTY_FILTERS, OWNER_OPTIONS_CAP, PAGE_SIZE, type Filters, type LibraryView } from './library/types';
import { ViewTabs } from './library/ViewTabs';

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
  // FINDING-002: previously merged every page's owners into `prev` forever,
  // growing unbounded for the life of the component (worse once the full
  // directory loads, since re-merging it added nothing but churn). When the
  // authoritative directory is available (usersQuery.data, admins only) it
  // fully replaces prior state instead of merging into it. The no-directory
  // fallback still accumulates owners seen across browsed pages (the intended
  // behavior for non-admins), but is capped so paging through a large library
  // can't grow the Map without bound — oldest entries are evicted first.
  useEffect(() => {
    if (usersQuery.data) {
      setOwnerOptions(new Map(usersQuery.data.map((u) => [u.id, u.name])));
      return;
    }
    const pageOwners = (query.data?.items ?? []).filter((item) => item.ownerName);
    if (pageOwners.length === 0) return;
    setOwnerOptions((prev) => {
      const next = new Map(prev);
      for (const item of pageOwners) next.set(item.ownerId, item.ownerName as string);
      while (next.size > OWNER_OPTIONS_CAP) {
        const oldest = next.keys().next().value;
        if (oldest === undefined) break;
        next.delete(oldest);
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
