// A generic table over a list of records.
//
// Columns are inferred from the rows rather than declared, because the point of
// this component is to render a dataset nobody has written a schema for. Cell
// rendering is type-aware, and a cell that opens into a tree is the same gesture
// as clicking a row in the timeline: pick a thing, look at it closely, edit it.

import { useMemo, useState, type ReactNode } from 'react'
import { Icon } from './ui'
import { leafText } from './JsonTree'

export interface Column {
  path: string
  label: string
  /** Share of rows carrying this key. */
  coverage: number
  types: string[]
}

/** Columns from the union of keys across the sampled rows, most-present first. */
export function inferColumns(rows: Record<string, unknown>[], max = 12): Column[] {
  const acc = new Map<string, { hits: number; types: Set<string> }>()
  for (const r of rows) {
    for (const [k, v] of Object.entries(r)) {
      const e = acc.get(k) ?? { hits: 0, types: new Set<string>() }
      e.hits += 1
      e.types.add(
        v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v,
      )
      acc.set(k, e)
    }
  }
  const n = Math.max(1, rows.length)
  return Array.from(acc.entries())
    .map(([path, e]) => ({ path, label: path, coverage: e.hits / n, types: Array.from(e.types) }))
    .sort((a, b) => b.coverage - a.coverage || a.path.localeCompare(b.path))
    .slice(0, max)
}

type SortDir = 'asc' | 'desc'

function cellText(v: unknown, max = 160): string {
  if (v === undefined) return ''
  if (v === null) return 'null'
  if (typeof v === 'object') {
    const s = JSON.stringify(v)
    return s.length > max ? s.slice(0, max) + '…' : s
  }
  return leafText(v, max)
}

/** How a value should be tinted: verdicts get colour, everything else does not. */
export function cellTone(path: string, v: unknown): string {
  if (typeof v === 'boolean') return v ? 'ok' : 'bad'
  const lk = path.toLowerCase()
  if (lk === 'correct' || lk === 'answered' || lk === 'passed') return v ? 'ok' : 'bad'
  if (lk === 'verdict' && typeof v === 'string') {
    if (v.toLowerCase() === 'pass') return 'ok'
    if (v.toLowerCase() === 'fail') return 'bad'
    return 'warn'
  }
  return ''
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0
  if (a === undefined || a === null) return -1
  if (b === undefined || b === null) return 1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return a ? 1 : -1
  return String(a).localeCompare(String(b), undefined, { numeric: true })
}

export interface DataTableProps<T> {
  rows: T[]
  columns: Column[]
  /** Pull the value for a column out of a row. */
  value: (row: T, path: string) => unknown
  /** Stable identity for a row, used by selection and React keys. */
  rowKey: (row: T, index: number) => string
  selectedKey?: string | null
  onPick?: (row: T, index: number) => void
  /** Optional leading cell, e.g. a line number, rendered tight and greyed. */
  gutter?: (row: T, index: number) => ReactNode
  /** Rows shown per page. 0 means all of them. */
  pageSize?: number
  /** Cap on rendered rows before "load more" is offered, so 64k rows stay cheap. */
  initialCap?: number
  empty?: ReactNode
}

export function DataTable<T>({
  rows,
  columns,
  value,
  rowKey,
  selectedKey,
  onPick,
  gutter,
  pageSize = 0,
  initialCap = 300,
  empty,
}: DataTableProps<T>) {
  const [sort, setSort] = useState<{ path: string; dir: SortDir } | null>(null)
  const [cap, setCap] = useState(initialCap)

  const sorted = useMemo(() => {
    if (!sort) return rows
    const copy = rows.slice()
    copy.sort((a, b) => {
      const c = compare(value(a, sort.path), value(b, sort.path))
      return sort.dir === 'asc' ? c : -c
    })
    return copy
  }, [rows, sort, value])

  const limited = pageSize > 0 ? sorted.slice(0, pageSize) : sorted.slice(0, cap)
  const hidden = sorted.length - limited.length

  if (rows.length === 0) {
    return <div className="empty">{empty ?? 'no rows'}</div>
  }

  const click = (path: string) => {
    setSort((s) =>
      !s || s.path !== path
        ? { path, dir: 'asc' }
        : s.dir === 'asc'
          ? { path, dir: 'desc' }
          : null,
    )
  }

  return (
    <div className="dt-wrap">
      <div className="table-wrap">
        <table className="tbl dt">
          <thead>
            <tr>
              {gutter && <th className="dt-gutter" />}
              {columns.map((c) => (
                <th
                  key={c.path}
                  className="sortable"
                  title={`${c.path} · ${(c.coverage * 100).toFixed(0)}% of rows`}
                  onClick={() => click(c.path)}
                >
                  <span className="truncate">{c.label}</span>
                  {sort?.path === c.path && (
                    <span className="arrow">{sort.dir === 'asc' ? '↑' : '↓'}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {limited.map((r, i) => {
              const k = rowKey(r, i)
              return (
                <tr
                  key={k}
                  className={selectedKey === k ? 'on' : ''}
                  onClick={() => onPick?.(r, i)}
                >
                  {gutter && <td className="dt-gutter mono">{gutter(r, i)}</td>}
                  {columns.map((c) => {
                    const v = value(r, c.path)
                    const tone = cellTone(c.path, v)
                    return (
                      <td key={c.path} className={'dt-cell' + (tone ? ' tone-' + tone : '')}>
                        {typeof v === 'object' && v !== null ? (
                          <span className="faint">{cellText(v)}</span>
                        ) : (
                          <span className="truncate">{cellText(v)}</span>
                        )}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {hidden > 0 && (
        <div className="dt-more">
          <button className="btn sm" onClick={() => setCap((c) => c + 1000)}>
            <Icon name="chevron" size={12} /> show 1000 more
          </button>
          <span className="tiny faint">{hidden} rows not rendered</span>
        </div>
      )}
    </div>
  )
}
