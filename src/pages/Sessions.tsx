import { useMemo, useState } from 'react'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { Card, Empty, Icon, Spinner, Stat, rateKind } from '../components/ui'
import * as api from '../lib/api'
import { baseName, errorRate, fmtCompact, fmtDate, fmtDur, fmtInt, fmtPct, fmtUsd } from '../lib/format'
import { useApp } from '../lib/store'
import type { SessionSummary } from '../lib/types'

type SortKey =
  | 'title' | 'nToolCalls' | 'toolErrors' | 'errRate' | 'cost' | 'outputTokens'
  | 'maxContextTokens' | 'interrupts' | 'durationSec' | 'nAssistantMsgs'
  | 'thinkingRatio' | 'editFailed'

const COLS: { key: SortKey; label: string; num?: boolean }[] = [
  { key: 'nAssistantMsgs', label: 'Msgs', num: true },
  { key: 'nToolCalls', label: 'Tools', num: true },
  { key: 'toolErrors', label: 'Errors', num: true },
  { key: 'errRate', label: 'Err %', num: true },
  { key: 'editFailed', label: 'Edit fail', num: true },
  { key: 'interrupts', label: 'Intr', num: true },
  { key: 'outputTokens', label: 'Out tok', num: true },
  { key: 'thinkingRatio', label: 'Think', num: true },
  { key: 'maxContextTokens', label: 'Ctx max', num: true },
  { key: 'durationSec', label: 'Wall', num: true },
  { key: 'cost', label: 'Cost', num: true },
]

const thinkingRatio = (s: SessionSummary) =>
  s.outputTokens > 0 ? s.thinkingTokens / s.outputTokens : 0

function value(s: SessionSummary, k: SortKey): string | number | null {
  switch (k) {
    case 'title': return s.title || s.id
    case 'errRate': return errorRate(s)
    case 'cost': return s.cost?.totalUsd ?? null
    case 'thinkingRatio': return thinkingRatio(s)
    case 'durationSec': return s.durationSec ?? null
    case 'editFailed': return s.editFailed
    default: return s[k] as number
  }
}

export default function Sessions() {
  const app = useApp()
  const { scan, scanning, rescan, selected, toggleSelected, selectAll, clearSelected, openTrace, config, toast } = app
  const [root, setRoot] = useState('')
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<SortKey>('cost')
  const [asc, setAsc] = useState(false)
  const [problemsOnly, setProblemsOnly] = useState(false)
  const [busy, setBusy] = useState(false)

  const effectiveRoot = root || config?.workspaceRoot || ''

  const rows = useMemo(() => {
    if (!scan) return []
    const needle = q.trim().toLowerCase()
    const out = scan.sessions.filter((s) => {
      if (problemsOnly) {
        const r = errorRate(s)
        const bad = (r != null && r > 0.05) || s.interrupts > 0 || s.editFailed > 0
        if (!bad) return false
      }
      if (!needle) return true
      return (
        (s.title || '').toLowerCase().includes(needle) ||
        s.id.toLowerCase().includes(needle) ||
        (s.model || '').toLowerCase().includes(needle) ||
        Object.keys(s.toolCalls).some((t) => t.toLowerCase().includes(needle))
      )
    })
    return out.sort((a, b) => {
      const va = value(a, sort)
      const vb = value(b, sort)
      if (va == null && vb == null) return 0
      if (va == null) return 1
      if (vb == null) return -1
      const c = typeof va === 'string' ? va.localeCompare(String(vb)) : (va as number) - (vb as number)
      return asc ? c : -c
    })
  }, [scan, q, sort, asc, problemsOnly])

  const totals = useMemo(() => {
    const base = scan?.sessions ?? []
    const sum = (f: (s: SessionSummary) => number) => base.reduce((a, s) => a + f(s), 0)
    const calls = sum((s) => s.nToolCalls)
    const errs = sum((s) => s.toolErrors)
    return {
      sessions: base.length,
      msgs: sum((s) => s.nAssistantMsgs),
      calls,
      errs,
      errRate: calls > 0 ? errs / calls : null,
      cost: base.reduce((a, s) => a + (s.cost?.totalUsd ?? 0), 0),
      hasCost: base.some((s) => s.cost?.totalUsd != null),
      out: sum((s) => s.outputTokens),
      think: sum((s) => s.thinkingTokens),
      cache: sum((s) => s.cacheReadTokens),
    }
  }, [scan])

  const pickRoot = async () => {
    try {
      const picked = await openDialog({
        directory: true, multiple: false,
        title: 'Select the folder holding transcript files',
      })
      if (typeof picked === 'string') {
        setRoot(picked)
        await rescan(picked)
      }
    } catch (e) {
      toast(api.humanError(e), 'err')
    }
  }

  const autoDetect = async () => {
    setBusy(true)
    try {
      const candidates = await api.defaultRoots()
      for (const c of candidates) {
        if (!c.exists) continue
        const r = await api.scanSessions(c.path)
        if (r.sessions.length > 0) {
          setRoot(c.path)
          await rescan(c.path)
          toast(`found ${r.sessions.length} sessions in ${c.path}`, 'ok')
          return
        }
      }
      toast('no transcripts found in the usual places - pick a folder manually', 'err')
    } catch (e) {
      toast(api.humanError(e), 'err')
    } finally {
      setBusy(false)
    }
  }

  if (!scan) {
    return (
      <div className="page">
        <div className="card" style={{ maxWidth: 660, margin: '48px auto' }}>
          <h3 className="card-title">Pick a workspace</h3>
          <p className="card-sub">
            Point TraceMatter at the folder holding your agent transcripts. Every <code>.jsonl</code> file at
            any depth below it is scanned. You can change this later in Settings.
          </p>
          <div className="row">
            <input
              className="input mono grow"
              placeholder="C:\path\to\transcripts"
              value={effectiveRoot}
              onChange={(e) => setRoot(e.target.value)}
            />
            <button className="btn" onClick={pickRoot}>Browse</button>
            <button
              className="btn primary"
              disabled={!effectiveRoot || scanning}
              onClick={() => rescan(effectiveRoot)}
            >
              {scanning ? <Spinner /> : <Icon name="search" size={14} />} Scan
            </button>
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            Files are read locally and never leave this machine.
          </div>
          <div className="sep" />
          <button className="btn" disabled={busy} onClick={autoDetect}>
            {busy ? <Spinner /> : <Icon name="folder" size={14} />} Look in the usual places
          </button>
        </div>
      </div>
    )
  }


  return (
    <div className="page">
      <div className="row wrap" style={{ marginBottom: 14, gap: 12 }}>
        <Card tight>
          <div className="row" style={{ gap: 22 }}>
            <Stat label="sessions" value={fmtInt(totals.sessions)} />
            <Stat label="messages" value={fmtInt(totals.msgs)} />
            <Stat label="tool calls" value={fmtInt(totals.calls)} />
            <Stat label="errors" value={fmtInt(totals.errs)} tone={totals.errs ? 'var(--warn)' : undefined} />
            <Stat label="error rate" value={fmtPct(totals.errRate)} />
          </div>
        </Card>
        <Card tight>
          <div className="row" style={{ gap: 22 }}>
            <Stat label="output tokens" value={fmtCompact(totals.out)} />
            <Stat label="thinking" value={fmtCompact(totals.think)} />
            <Stat label="cache reads" value={fmtCompact(totals.cache)} />
            {totals.hasCost && <Stat label="reported cost" value={fmtUsd(totals.cost)} />}
          </div>
        </Card>
      </div>
      <div className="row wrap" style={{ marginBottom: 12 }}>
        <input
          className="input"
          style={{ maxWidth: 250 }}
          placeholder="Filter by title, id, model, tool"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button
          className={'chip' + (problemsOnly ? ' on' : '')}
          onClick={() => setProblemsOnly((v) => !v)}
          title="Only sessions with over 5% tool errors, an interrupt, or a failed edit"
        >
          <Icon name="alert" size={12} /> needs attention
        </button>
        <span className="faint small">{rows.length} of {scan.sessions.length}</span>
        <div className="grow" />
        <select
          className="select"
          style={{ maxWidth: 156 }}
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
        >
          <option value="title">sort: session</option>
          {COLS.map((c) => (
            <option key={c.key} value={c.key}>sort: {c.label}</option>
          ))}
        </select>
        <button className="btn sm" onClick={() => setAsc((v) => !v)}>{asc ? 'asc' : 'desc'}</button>
        <button className="btn sm" onClick={() => selectAll(rows.map((r) => r.path))}>select all</button>
        <button className="btn sm" disabled={!selected.size} onClick={clearSelected}>clear</button>
        <button className="btn sm" onClick={() => rescan()}>
          <Icon name="refresh" size={13} /> rescan
        </button>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ maxHeight: 'calc(100vh - 300px)', overflow: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 32 }} />
                <th onClick={() => { setSort('title'); setAsc(sort === 'title' ? !asc : true) }}>
                  Session {sort === 'title' && <span className="faint">{asc ? 'up' : 'down'}</span>}
                </th>
                {COLS.map((c) => (
                  <th
                    key={c.key}
                    className={c.num ? 'num' : ''}
                    onClick={() => { setSort(c.key); setAsc(sort === c.key ? !asc : false) }}
                  >
                    {c.label}
                    {sort === c.key && <span className="faint"> {asc ? 'up' : 'down'}</span>}
                  </th>
                ))}
                <th className="nowrap">When</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const er = errorRate(s)
                const isSel = selected.has(s.path)
                const topTools = Object.entries(s.toolCalls)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 3)
                  .map(([k, v]) => `${k}:${v}`)
                  .join(' ')
                return (
                  <tr key={s.path} className={isSel ? 'sel' : ''}>
                    <td>
                      <input type="checkbox" checked={isSel} onChange={() => toggleSelected(s.path)} />
                    </td>
                    <td style={{ maxWidth: 330 }}>
                      <div
                        className="truncate"
                        style={{ fontWeight: 550, cursor: 'pointer' }}
                        title="Open this trace"
                        onClick={() => openTrace(s)}
                      >
                        {s.title || <span className="faint">(untitled session)</span>}
                      </div>
                      <div className="tiny faint truncate mono">
                        {s.id.slice(0, 8)}
                        {s.model ? ' - ' + s.model.replace(/^claude-/, '') : ''}
                        {s.nFilesTouched ? ` - ${s.nFilesTouched} files` : ''}
                        {s.repeatBash ? ` - ${s.repeatBash} repeat` : ''}
                        {topTools ? ' - ' + topTools : ''}
                      </div>
                    </td>
                    <td className="num mono">{fmtInt(s.nAssistantMsgs)}</td>
                    <td className="num mono">{fmtInt(s.nToolCalls)}</td>
                    <td className="num mono">
                      {s.toolErrors ? <span style={{ color: 'var(--bad)' }}>{s.toolErrors}</span> : '0'}
                    </td>
                    <td className="num mono">
                      {er == null ? 'n/a' : <span className={rateKind(er) ? `badge ${rateKind(er)}` : ''}>{fmtPct(er)}</span>}
                    </td>
                    <td className="num mono">
                      {s.editCalls === 0
                        ? 'n/a'
                        : s.editFailed > 0
                          ? <span style={{ color: 'var(--warn)' }}>{s.editFailed}/{s.editCalls}</span>
                          : `0/${s.editCalls}`}
                    </td>
                    <td className="num mono">
                      {s.interrupts ? <span style={{ color: 'var(--violet)' }}>{s.interrupts}</span> : '0'}
                    </td>
                    <td className="num mono">{fmtCompact(s.outputTokens)}</td>
                    <td className="num mono">{fmtPct(thinkingRatio(s), 0)}</td>
                    <td className="num mono">{fmtCompact(s.maxContextTokens)}</td>
                    <td className="num mono">{fmtDur(s.durationSec)}</td>
                    <td className="num mono">{s.cost?.totalUsd != null ? fmtUsd(s.cost.totalUsd) : 'n/a'}</td>
                    <td className="tiny faint nowrap">{s.lastTs ? fmtDate(s.lastTs) : 'n/a'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && (
          <Empty title="No sessions match" hint="Clear the filter, or rescan the workspace." />
        )}
      </div>

      <div className="row" style={{ marginTop: 10, gap: 14 }}>
        <span className="tiny faint truncate">
          workspace <span className="mono">{scan.root}</span> ({baseName(scan.root)})
        </span>
        <div className="grow" />
        <span className="tiny faint">
          Click a session title to open its trace; tick rows to add them to the annotation pool.
        </span>
      </div>
    </div>
  )
}
