import { ReactNode, useMemo, useState } from 'react';
import {
  ACCESS_LEVELS,
  DOCUMENT_STATUSES,
  DOCUMENT_DUE_STATE_LABELS,
  DOCUMENT_DUE_STATES,
  EXTRACTION_STATUSES,
  EXTRACTION_STATUS_LABELS,
} from '@policymanager/shared';
import { statusLabel } from '../../lib/format';
import type { Filters } from './types';

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

export function FiltersBar({
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
                {`${' '.repeat(c.depth * 2)}${c.name}`}
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
