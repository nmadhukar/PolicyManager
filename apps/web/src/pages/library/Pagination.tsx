export function Pagination({
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
