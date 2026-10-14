// A parquet file, paged.
//
// The GRPO completions are ~500 files of full prompts and completions, so this
// never loads a whole file: it reads the footer for the schema, renders one
// window of rows, and fetches a single cell in full only when asked. Long cells
// arrive marked with an ellipsis, and the column is named so the reader knows
// which ones were shortened.

import { useCallback, useEffect, useState } from 'react'
import { Badge, Icon, Section, Spinner } from '../components/ui'
import * as api from '../lib/api'
import { baseName } from '../lib/format'
import { useT } from '../lib/i18n'
import type { ParquetPage } from '../lib/types'

const PAGE_SIZE = 50

export default function ParquetView({
  path,
  onAsk,
  onBack,
}: {
  path: string
  onAsk?: (text: string) => void
  onBack: () => void
}) {
  const t = useT()
  const [page, setPage] = useState<ParquetPage | null>(null)
  const [offset, setOffset] = useState(0)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<{ row: number; col: string; value: unknown } | null>(null)

  const load = useCallback(
    async (off: number) => {
      setBusy(true)
      setErr(null)
      try {
        setPage(await api.parquetPage(path, off, PAGE_SIZE))
        setOffset(off)
      } catch (e) {
        setErr(api.humanError(e))
      } finally {
        setBusy(false)
      }
    },
    [path],
  )

  useEffect(() => {
    void load(0)
  }, [load])

  const openCell = async (globalRow: number, col: string) => {
    try {
      const v = await api.parquetCell(path, globalRow, col)
      setExpanded({ row: globalRow, col, value: v })
    } catch (e) {
      setErr(api.humanError(e))
    }
  }

  const cols = page?.columns ?? []
  const total = page?.totalRows ?? 0
  const last = Math.max(0, Math.floor(Math.max(0, total - 1) / PAGE_SIZE) * PAGE_SIZE)

  return (
    <div className="data-layout">
      <div className="data-main">
        <div className="data-head">
          <Icon name="database" size={14} />
          <span className="mono truncate" title={path}>
            {baseName(path)}
          </span>
          <Badge kind="info">parquet</Badge>
          {page && <span className="tiny faint">{t('{n} rows', { n: page.totalRows })}</span>}
          {page && <span className="tiny faint">{t('{n} row groups', { n: page.rowGroups })}</span>}
          <div className="grow" />
          {onAsk && (
            <button
              className="chip"
              title={path}
              onClick={() => onAsk(t('Read {path} and describe what this table holds.', { path }))}
            >
              <Icon name="cpu" size={12} /> {t('Ask')}
            </button>
          )}
          <button className="btn ghost sm" onClick={onBack}>
            <Icon name="x" size={12} /> {t('Close')}
          </button>
        </div>

        {err && (
          <div className="note-line" style={{ margin: 14 }}>
            {err}
          </div>
        )}

        <div className="data-body">
          {busy && !page ? (
            <div className="row" style={{ gap: 8, padding: 20 }}>
              <Spinner /> {t('reading the footer…')}
            </div>
          ) : page ? (
            <>
              {page.clipped.length > 0 && (
                <div className="hint" style={{ marginBottom: 8 }}>
                  {t('Long cells are shortened here. Click one to read it whole: {c}', {
                    c: page.clipped.join(', '),
                  })}
                </div>
              )}
              <div className="table-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th className="dt-gutter">{t('#')}</th>
                      {cols.map((c) => (
                        <th key={c.name} title={c.kind}>
                          <span className="truncate">{c.name}</span>
                          <span className="tiny faint mono"> {c.kind}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {page.rows.map((r, i) => {
                      const globalRow = offset + i
                      return (
                        <tr key={globalRow}>
                          <td className="dt-gutter mono">{globalRow}</td>
                          {cols.map((c) => {
                            const v = r[c.name]
                            const isLong = page.clipped.includes(c.name)
                            return (
                              <td
                                key={c.name}
                                className="dt-cell"
                                style={isLong ? { cursor: 'pointer' } : undefined}
                                onClick={isLong ? () => void openCell(globalRow, c.name) : undefined}
                              >
                                <span className="truncate">
                                  {v === null || v === undefined
                                    ? '—'
                                    : typeof v === 'object'
                                      ? JSON.stringify(v)
                                      : String(v)}
                                </span>
                              </td>
                            )
                          })}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </div>

        {page && total > PAGE_SIZE && (
          <div className="pager">
            <button className="btn sm" disabled={busy || offset === 0} onClick={() => void load(0)}>
              ⟨⟨ {t('first')}
            </button>
            <button
              className="btn sm"
              disabled={busy || offset === 0}
              onClick={() => void load(Math.max(0, offset - PAGE_SIZE))}
            >
              {t('prev')}
            </button>
            <span className="tiny faint mono">
              {offset}–{Math.min(offset + PAGE_SIZE, total)} {t('of')} {total}
            </span>
            <button
              className="btn sm"
              disabled={busy || offset >= last}
              onClick={() => void load(Math.min(last, offset + PAGE_SIZE))}
            >
              {t('next')}
            </button>
            <button
              className="btn sm"
              disabled={busy || offset >= last}
              onClick={() => void load(last)}
            >
              {t('last')} ⟩⟩
            </button>
            {busy && <Spinner size={12} />}
          </div>
        )}
      </div>

      <div className="data-side">
        <Section label={t('Cell')}>
          {expanded ? (
            <>
              <div className="tiny faint mono" style={{ marginBottom: 6 }}>
                {t('row {n} · {c}', { n: expanded.row, c: expanded.col })}
              </div>
              <pre className="code wrap" style={{ maxHeight: 520 }}>
                {typeof expanded.value === 'string'
                  ? expanded.value
                  : JSON.stringify(expanded.value, null, 2)}
              </pre>
            </>
          ) : (
            <p className="hint">{t('Click a shortened cell to read the whole value here.')}</p>
          )}
        </Section>
      </div>
    </div>
  )
}
