import React, { useMemo, useState } from 'react';
import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';

export interface Column<T> {
  key: string;
  label: string;
  /** Value used for sorting. Omit to make the column unsortable. */
  sortValue?: (row: T) => string | number | null | undefined;
  render: (row: T) => React.ReactNode;
  align?: 'left' | 'right' | 'center';
  /** Tailwind width/visibility classes, e.g. "w-24" or "hidden lg:table-cell" */
  className?: string;
}

interface Props<T> {
  rows: T[] | undefined;
  columns: Column<T>[];
  rowKey: (row: T) => string;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  onRowClick?: (row: T) => void;
  empty?: React.ReactNode;
  /** Shown above the table on the right, e.g. "24 givers" */
  countLabel?: (n: number) => string;
}

/** Dense, sortable table: click a header to sort, click again to reverse. */
export function DataTable<T>({ rows, columns, rowKey, initialSort, onRowClick, empty, countLabel }: Props<T>) {
  const [sort, setSort] = useState(initialSort ?? null);

  const sorted = useMemo(() => {
    if (!rows) return undefined;
    const col = columns.find(c => c.key === sort?.key);
    if (!sort || !col?.sortValue) return rows;
    const get = col.sortValue;
    return [...rows].sort((a, b) => {
      const x = get(a), y = get(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;           // blanks last, either direction
      if (y == null) return -1;
      const cmp = typeof x === 'number' && typeof y === 'number'
        ? x - y
        : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' });
      return sort.dir === 'asc' ? cmp : -cmp;
    });
  }, [rows, columns, sort]);

  const toggle = (c: Column<T>) => {
    if (!c.sortValue) return;
    setSort(s => (s?.key === c.key ? { key: c.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: c.key, dir: 'asc' }));
  };

  const alignClass = (a?: string) => (a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left');

  return (
    <div className="bg-white rounded-2xl shadow-md border border-gray-100 overflow-hidden">
      {countLabel && sorted && (
        <div className="px-4 py-2 text-xs text-gray-500 border-b border-gray-100 bg-gray-50/60">{countLabel(sorted.length)}</div>
      )}
      <div className="overflow-auto max-h-[calc(100vh-15rem)]">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
            <tr>
              {columns.map(c => {
                const active = sort?.key === c.key;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    onClick={() => toggle(c)}
                    aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                    className={`px-4 py-3 font-semibold whitespace-nowrap select-none ${alignClass(c.align)} ${c.className ?? ''} ${c.sortValue ? 'cursor-pointer hover:text-gray-800' : ''}`}
                  >
                    <span className={`inline-flex items-center gap-1 ${c.align === 'right' ? 'flex-row-reverse' : ''}`}>
                      {c.label}
                      {c.sortValue && (active
                        ? (sort!.dir === 'asc' ? <ChevronUp className="w-3.5 h-3.5 text-church-500" /> : <ChevronDown className="w-3.5 h-3.5 text-church-500" />)
                        : <ChevronsUpDown className="w-3.5 h-3.5 opacity-30" />)}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {sorted?.map(row => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={`group hover:bg-blue-50/50 ${onRowClick ? 'cursor-pointer' : ''}`}
              >
                {columns.map(c => (
                  <td key={c.key} className={`px-4 py-2.5 align-top ${alignClass(c.align)} ${c.className ?? ''}`}>{c.render(row)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {sorted && sorted.length === 0 && (
          <div className="py-12 text-center text-gray-400">{empty ?? 'Nothing to show.'}</div>
        )}
        {!sorted && <div className="py-12 text-center text-gray-400">Loading…</div>}
      </div>
    </div>
  );
}

export default DataTable;
