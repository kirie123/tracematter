import { useMemo, useState } from 'react'
import { save as saveDialog } from '@tauri-apps/plugin-dialog'
import { Badge, Card, Empty, Icon, Stat } from '../components/ui'
import * as api from '../lib/api'
import { boolish, numish, str } from '../lib/format'
import { useT } from '../lib/i18n'
import { useApp } from '../lib/store'
import type { LabelRecord } from '../lib/types'

/** Distinct values of one field, with counts, for building filter chips. */
function tally(rows: LabelRecord[], field: string): [string, number][] {
  const m = new Map<string, number>()
  for (const r of rows) {
    const v = r.values?.[field]
    if (v == null) continue
    const k = typeof v === 'boolean' ? String(v) : String(v)
    m.set(k, (m.get(k) || 0) + 1)
  }
  return Array.from(m.entries()).sort((a, b) => b[1] - a[1])
}

interface Filters {
  q: string
  values: Record<string, string>
  minConfidence: number
  sftOnly: boolean
  failuresOnly: boolean
}

const EMPTY: Filters = { q: '', values: {}, minConfidence: 0, sftOnly: false, failuresOnly: false }

function apply(rows: LabelRecord[], f: Filters, sftField: string): LabelRecord[] {
  const needle = f.q.trim().toLowerCase()
  return rows.filter((r) => {
    if (f.failuresOnly && !r.error) return false
    if (f.sftOnly && !boolish(r.values?.[sftField])) return false
    if (f.minConfidence > 0) {
      const c = numish(r.values?.confidence)
      if (c < f.minConfidence) return false
    }
    for (const [k, v] of Object.entries(f.values)) {
      if (!v) continue
      if (str(r.values?.[k]) !== v) return false
    }
    if (needle) {
      const hay = (r.id + ' ' + (r.title || '') + ' ' + JSON.stringify(r.values)).toLowerCase()
      if (!hay.includes(needle)) return false
    }
    return true
  })
}

export default function Review() {
  const { labels, job, config, toast } = useApp()
  const [f, setF] = useState<Filters>(EMPTY)
  const t = useT()

  const schema = config?.schemas.find((s) => s.id === config.activeSchemaId) ?? config?.schemas[0]
  const fields = schema?.fields ?? []
  const sftField = fields.find((x) => x.kind === 'bool')?.name ?? 'sft_worthy'

  const rows = useMemo(() => apply(labels, f, sftField), [labels, f, sftField])

  const stats = useMemo(() => {
    const ok = labels.filter((r) => !r.error)
    const conf = ok.map((r) => numish(r.values?.confidence)).filter((n) => n > 0)
    const meanConf = conf.length ? conf.reduce((a, b) => a + b, 0) / conf.length : null
    return {
      total: labels.length,
      failed: labels.length - ok.length,
      worthy: ok.filter((r) => boolish(r.values?.[sftField])).length,
      meanConf,
      highConfWorthy: ok.filter((r) => boolish(r.values?.[sftField]) && numish(r.values?.confidence) >= 0.6).length,
    }
  }, [labels, sftField])

  const setValue = (k: string, v: string) =>
    setF((prev) => ({ ...prev, values: { ...prev.values, [k]: prev.values[k] === v ? '' : v } }))

  const doExport = async (kind: 'jsonl' | 'csv') => {
    try {
      const p = await saveDialog({
        title: t('Export labels'),
        defaultPath: 'tracematter-labels.' + kind,
      })
      if (typeof p !== 'string') return
      const n = await api.exportResults(rows, p, fields)
      toast(t('wrote {n} rows to {p}', { n, p: p }), 'ok')
    } catch (e) {
      toast(api.humanError(e), 'err')
    }
  }

  if (labels.length === 0) {
    return (
      <Empty
        title={t('No labels yet')}
        hint={t('Run a batch on the Annotate screen, or point the loader at a JSONL file produced by an earlier run.')}
      />
    )
  }

  return (
    <div className="page">
      <div className="row wrap" style={{ marginBottom: 14, gap: 12 }}>
        <Card tight>
          <div className="row" style={{ gap: 22 }}>
            <Stat label={t('rows')} value={String(stats.total)} />
            <Stat label={t('failed')} value={String(stats.failed)} tone={stats.failed ? 'var(--bad)' : undefined} />
            <Stat label={sftField} value={String(stats.worthy)} tone="var(--ok)" />
            <Stat label={t('{f} and confident', { f: sftField })} value={String(stats.highConfWorthy)} />
            <Stat label={t('mean confidence')} value={stats.meanConf == null ? t('n/a') : stats.meanConf.toFixed(3)} />
          </div>
        </Card>
        {job && (
          <Card tight>
            <div className="row" style={{ gap: 18 }}>
              <Stat label={t('job')} value={job.status} />
              <Stat label={t('done')} value={job.completed + '/' + job.total} />
            </div>
          </Card>
        )}
      </div>

      <div className="row wrap" style={{ marginBottom: 12, gap: 8 }}>
        <input
          className="input"
          style={{ maxWidth: 260 }}
          placeholder={t('Search rows')}
          value={f.q}
          onChange={(e) => setF({ ...f, q: e.target.value })}
        />
        <button className={'chip' + (f.sftOnly ? ' on' : '')} onClick={() => setF({ ...f, sftOnly: !f.sftOnly })}>
          {t('{f} only', { f: sftField })}
        </button>
        <button className={'chip' + (f.failuresOnly ? ' on' : '')} onClick={() => setF({ ...f, failuresOnly: !f.failuresOnly })}>
          {t('failures only')}
        </button>
        <span className="tiny faint">{t('confidence at least')}</span>
        <input
          className="input"
          type="number"
          step="0.1"
          min="0"
          max="1"
          style={{ width: 72 }}
          value={f.minConfidence}
          onChange={(e) => setF({ ...f, minConfidence: +e.target.value || 0 })}
        />
        <button className="btn sm" onClick={() => setF(EMPTY)}>{t('reset')}</button>
        <div className="grow" />
        <span className="faint small">{t('{a} of {b}', { a: rows.length, b: labels.length })}</span>
        <button className="btn sm" onClick={() => doExport('jsonl')}><Icon name="download" size={13} /> {t('JSONL')}</button>
        <button className="btn sm" onClick={() => doExport('csv')}><Icon name="download" size={13} /> {t('CSV')}</button>
      </div>

      {fields.filter((x) => x.kind === 'enum').map((x) => {
        const vals = tally(rows.length ? rows : labels, x.name)
        if (vals.length === 0) return null
        return (
          <div key={x.name} className="row wrap" style={{ marginBottom: 8, gap: 6 }}>
            <span className="tiny faint" style={{ minWidth: 92 }}>{x.name}</span>
            {vals.map(([v, n]) => (
              <button
                key={v}
                className={'chip' + (f.values[x.name] === v ? ' on' : '')}
                onClick={() => setValue(x.name, v)}
              >
                {v} <span className="faint">{n}</span>
              </button>
            ))}
          </div>
        )
      })}

      <div className="sep" />

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ maxHeight: 'calc(100vh - 330px)', overflow: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 120 }}>{t('Turn')}</th>
                <th style={{ width: 300 }}>{t('Session / turn')}</th>
                {fields.map((x) => (
                  <th key={x.name} className={x.kind === 'int' || x.kind === 'float' ? 'num' : ''}>{x.name}</th>
                ))}
                <th style={{ width: 90 }} className="num">{t('Latency')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="mono tiny">{r.id}</td>
                  <td className="truncate" style={{ maxWidth: 300 }} title={r.title || ''}>
                    {r.title || <span className="faint">{t('(untitled)')}</span>}
                    <div className="tiny faint">{t('{n} tools, {m} err', { n: r.nTools, m: r.nErrors })}</div>
                  </td>
                  {fields.map((x) => {
                    const v = r.values?.[x.name]
                    if (r.error) return <td key={x.name} className="faint">{t('n/a')}</td>
                    if (x.kind === 'bool') {
                      return (
                        <td key={x.name}>
                          {v ? <Badge kind="ok">{t('yes')}</Badge> : <Badge>x</Badge>}
                        </td>
                      )
                    }
                    if (x.name === 'confidence') {
                      const c = numish(v)
                      return (
                        <td key={x.name}>
                          <span className={'badge ' + (c >= 0.75 ? 'ok' : c >= 0.5 ? 'warn' : 'bad')}>{c.toFixed(2)}</span>
                        </td>
                      )
                    }
                    if (x.kind === 'int' || x.kind === 'float') {
                      return <td key={x.name} className="num mono">{String(v ?? t('n/a'))}</td>
                    }
                    if (x.kind === 'text' || (typeof v === 'string' && v.length > 40)) {
                      return (
                        <td key={x.name} className="tiny" style={{ maxWidth: 360 }} title={str(v)}>
                          <div className="truncate">{str(v)}</div>
                        </td>
                      )
                    }
                    return <td key={x.name}>{str(v) || <span className="faint">{t('n/a')}</span>}</td>
                  })}
                  <td className="num tiny faint mono">{r.latencyMs ? (r.latencyMs / 1000).toFixed(1) + 's' : t('n/a')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && <Empty title={t('Nothing matches these filters')} />}
      </div>

      <div className="tiny faint" style={{ marginTop: 8 }}>
        {t('Rows come from the current run and are also written to the output file as they finish.')}
      </div>
    </div>
  )
}

