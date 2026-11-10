import { LibraryPageSize, type LibraryPageSize as PageSize } from '@shared/ipc';

export function LibraryPagination({
  page,
  pageSize,
  total,
  busy,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  pageSize: PageSize;
  total: number;
  busy: boolean;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: PageSize) => void;
}): React.JSX.Element {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  return (
    <nav className="library-pagination" aria-label="Library pages">
      <span role="status">
        {first}-{last} of {total.toLocaleString()} matches
      </span>
      <label>
        Items per page
        <select
          aria-label="Items per page"
          value={pageSize}
          disabled={busy}
          onChange={(event) =>
            onPageSizeChange(LibraryPageSize.parse(Number(event.target.value)))
          }
        >
          {[24, 48, 96, 192].map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </label>
      <div>
        <button
          type="button"
          aria-label="First page"
          disabled={busy || page <= 1}
          onClick={() => onPageChange(1)}
        >
          First
        </button>
        <button
          type="button"
          aria-label="Previous page"
          disabled={busy || page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          Previous
        </button>
        <span>
          Page {page} of {pages}
        </span>
        <button
          type="button"
          aria-label="Next page"
          disabled={busy || page >= pages}
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </button>
        <button
          type="button"
          aria-label="Last page"
          disabled={busy || page >= pages}
          onClick={() => onPageChange(pages)}
        >
          Last
        </button>
      </div>
    </nav>
  );
}
