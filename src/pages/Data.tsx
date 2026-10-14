// The Data view: open a file, recognise what it is, render it in its natural
// shape, and edit a value.
//
// Two ideas hold this together:
//
//   * A **lens** is a rendering chosen by the detected family. The family is a
//     guess with a stated reason, and the reader can overrule it from the
//     header — a wrong guess should be visible and fixable, never silent.
//   * An edit is **always a fork first**. Nothing writes the source until the
//     reader asks for it by name, having seen the diff.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { Column, DataTable, inferColumns } from '../components/DataTable'
import { JsonTree } from '../components/JsonTree'
import { Badge, Empty, Icon, Section, Spinner } from '../components/ui'
import * as api from '../lib/api'
import { baseName, fmtCompact } from '../lib/format'
import { useT } from '../lib/i18n'
import { useApp } from '../lib/store'
import ParquetView from './ParquetView'
import type { Anchor, Document, Family, Row, SaveResult } from '../lib/types'

/** Which rendering is on screen. `auto` follows the detected family. */
type Lens = 'auto' | 'table' | 'tree' | 'raw' | 'criteria' | 'items' | 'passk' | 'chat'

/** The family a lens is the natural rendering for. */
const LENS_FOR: Partial<Record<Family, Lens>> = {
  harveyTask: 'criteria',
  harveyRun: 'table',
  harveyScores: 'table',
  evalSummary: 'items',
  evalItems: 'items',
  passK: 'passk',
  grpoCompletions: 'table',
  trainerCurve: 'table',
  openAiChat: 'chat',
  openAiChatRequest: 'chat',
  anthropicMessages: 'chat',
  claudeCode: 'chat',
  unknown: 'table',
}

const LENSES: { id: Lens; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'table', label: 'Table' },
  { id: 'tree', label: 'Tree' },
  { id: 'raw', label: 'Raw' },
]

const FAMILY_LABEL: Record<Family, string> = {
  unknown: 'unrecognised',
  harveyTask: 'harvey task',
  harveyRun: 'harvey run',
  harveyScores: 'harvey scores',
  evalSummary: 'eval summary',
  evalItems: 'eval items',
  passK: 'pass@k',
  grpoCompletions: 'GRPO completions',
  trainerCurve: 'training curve',
  openAiChat: 'OpenAI chat',
  openAiChatRequest: 'OpenAI request',
  anthropicMessages: 'Anthropic messages',
  claudeCode: 'Claude Code trace',
}

/** A parsed JSON object plus the line it came from. */
type Rec = Record<string, unknown> & { __line?: number }

/** A pending change, held in memory until the reader saves it. */
interface Draft {
  anchor: Anchor
  value: unknown
  /** What to show in the change list. */
  label: string
}

export default function Data({ onAsk }: { onAsk?: (text: string) => void }) {
  const t = useT()
  const { toast } = useApp()

  const [doc, setDoc] = useState<Document | null>(null)
  const [lens, setLens] = useState<Lens>('auto')
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [target, setTarget] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ anchor: Anchor; value: string; label: string } | null>(null)
  const [diff, setDiff] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [rows, setRows] = useState<Row[]>([])
  /** A parquet file renders through its own lens, not through `Document`. */
  const [parquet, setParquet] = useState<string | null>(null)

  const openFile = useCallback(
    async (p: string) => {
      if (!p) return
      setDrafts([])
      setTarget(null)
      setDiff(null)
      setSelected(null)
      try {
        if (p.toLowerCase().endsWith('.parquet')) {
          setParquet(p)
          setDoc(null)
          return
        }
        setParquet(null)
        const d = await api.dataOpen(p)
        setDoc(d)
        setRows(d.rows)
      } catch (e) {
        toast(api.humanError(e), 'err')
      }
    },
    [toast],
  )

  const browse = async () => {
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: 'data', extensions: ['json', 'jsonl', 'ndjson', 'parquet'] }],
    })
    if (typeof picked === 'string') void openFile(picked)
  }

  // The effective lens: an explicit choice wins, otherwise the family decides.
  const effective: Lens = useMemo(() => {
    if (lens !== 'auto') return lens
    if (!doc) return 'table'
    return LENS_FOR[doc.family] ?? 'table'
  }, [lens, doc])

  const dirty = drafts.length > 0

  // ---------------------------------------------------------------- editing

  const stage = (anchor: Anchor, value: unknown, label: string) => {
    setDrafts((d) => {
      const key = JSON.stringify(anchor)
      const next = d.filter((x) => JSON.stringify(x.anchor) !== key)
      next.push({ anchor, value, label })
      return next
    })
    setDiff(null)
  }

  const commit = async (toSource: boolean) => {
    if (!doc || drafts.length === 0) return
    setBusy(true)
    try {
      let out = target
      if (!toSource && !out) {
        out = await api.dataFork(doc.path)
        setTarget(out)
      }
      const args = {
        path: doc.path,
        target: toSource ? doc.path : (out as string),
        edits: drafts.map((d) => ({ anchor: d.anchor, value: d.value })),
        guard: { len: doc.guardLen, sum: doc.guardSum },
      }
      const res: SaveResult = toSource
        ? await api.dataOverwrite(args)
        : await api.dataSet(args)
      toast(
        t('saved {n} change(s) to {file}', {
          n: res.changedLines.length,
          file: baseName(res.target),
        }),
        'ok',
      )
      if (res.backup) toast(t('backup written to {f}', { f: baseName(res.backup) }), 'ok')
      const fresh = await api.dataOpen(res.target)
      setDoc(fresh)
      setRows(fresh.rows)
      setDrafts([])
      setDiff(null)
      setTarget(toSource ? null : res.target)
    } catch (e) {
      toast(api.humanError(e), 'err')
    } finally {
      setBusy(false)
    }
  }

  const previewDiff = async () => {
    if (!doc || drafts.length === 0) return
    setBusy(true)
    try {
      const out = await api.dataDiff({
        path: doc.path,
        target: target ?? doc.path,
        edits: drafts.map((d) => ({ anchor: d.anchor, value: d.value })),
        guard: { len: doc.guardLen, sum: doc.guardSum },
      })
      setDiff(out)
    } catch (e) {
      toast(api.humanError(e), 'err')
    } finally {
      setBusy(false)
    }
  }

  // Ctrl+S saves a copy; that is the safe default and the one worth a shortcut.
  const draftRef = useRef({ commit, dirty, busy })
  draftRef.current = { commit, dirty, busy }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== 's') return
      if (!draftRef.current.dirty || draftRef.current.busy) return
      e.preventDefault()
      void draftRef.current.commit(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ------------------------------------------------------------------ render

  if (parquet) {
    return <ParquetView path={parquet} onAsk={onAsk} onBack={() => setParquet(null)} />
  }

  if (!doc) {
    return (
      <div className="page">
        <div className="data-intro">
          <Empty
            title={t('No file open')}
            hint={t(
              'Open a JSON, JSONL or parquet file to read it as a table, a tree or its raw lines.',
            )}
          />
          <div className="row" style={{ gap: 8, marginTop: 14 }}>
            <button className="btn primary" onClick={browse}>
              <Icon name="folder" size={13} /> {t('Open a file')}
            </button>
          </div>
          <QuickPaths onPick={openFile} />
        </div>
      </div>
    )
  }

  const asObjects = rows
    .map((r) => r.value)
    .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v))
  const columns: Column[] = inferColumns(asObjects, 12)

  return (
    <div className="data-layout">
      <div className="data-main">
        <div className="data-head">
          <Icon name="file" size={14} />
          <span className="mono truncate" title={doc.path}>
            {doc.name}
          </span>
          <Badge>{FAMILY_LABEL[doc.family]}</Badge>
          <span className="tiny faint">{fmtCompact(doc.bytes)} B</span>
          <span className="tiny faint">
            {doc.kind === 'jsonl' ? t('{n} lines', { n: doc.totalLines }) : t('one document')}
          </span>
          {doc.bad > 0 && <Badge kind="bad">{t('{n} unparseable', { n: doc.bad })}</Badge>}
          <div className="grow" />
          {onAsk && (
            <button
              className="chip"
              onClick={() =>
                onAsk(
                  t(
                    'Read {path} and tell me what is in it: its shape, its key fields, and anything that looks wrong.',
                    { path: doc.path },
                  ),
                )
              }
            >
              <Icon name="cpu" size={12} /> {t('Ask')}
            </button>
          )}
          <button className="btn ghost sm" onClick={browse}>
            <Icon name="folder" size={12} /> {t('Open')}
          </button>
        </div>

        <div className="data-bar">
          <div className="tabs" style={{ border: 0 }}>
            {LENSES.map((l) => (
              <button
                key={l.id}
                className={'tab' + (lens === l.id ? ' on' : '')}
                onClick={() => setLens(l.id)}
              >
                {t(l.label)}
              </button>
            ))}
          </div>
          <div className="grow" />
          {doc.probe.length > 0 && (
            <span className="tiny faint truncate" title={doc.probe.join(' · ')}>
              {doc.probe[0]}
            </span>
          )}
        </div>

        {dirty && (
          <div className="dirtybar">
            <Icon name="pencil" size={12} />
            <span>
              {t('{n} unsaved change(s)', { n: drafts.length })}
              {target ? ` → ${baseName(target)}` : ''}
            </span>
            <div className="grow" />
            <button className="btn sm" disabled={busy} onClick={previewDiff}>
              {t('Preview diff')}
            </button>
            <button className="btn sm" disabled={busy} onClick={() => setDrafts([])}>
              {t('Discard')}
            </button>
            <button className="btn sm" disabled={busy} onClick={() => commit(false)}>
              {busy ? <Spinner size={11} /> : <Icon name="download" size={12} />} {t('Save copy')}
            </button>
            <button
              className="btn sm danger"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    t('Overwrite {f}? A timestamped .bak will be left beside it.', {
                      f: doc.name,
                    }),
                  )
                ) {
                  void commit(true)
                }
              }}
            >
              {t('Overwrite source')}
            </button>
          </div>
        )}

        {diff && (
          <div className="diffbox">
            <div className="row" style={{ marginBottom: 6 }}>
              <span className="small" style={{ fontWeight: 600 }}>
                {t('What the save will do')}
              </span>
              <div className="grow" />
              <button className="btn ghost sm" onClick={() => setDiff(null)}>
                {t('Hide')}
              </button>
            </div>
            <pre className="code wrap" style={{ maxHeight: 240 }}>
              {diff}
            </pre>
          </div>
        )}

        <div className="data-body">
          {effective === 'raw' && <RawLens doc={doc} />}

          {effective === 'tree' && (
            <div className="tree-pane">
              <JsonTree
                value={doc.kind === 'jsonDoc' ? doc.doc : rows.map((r) => r.value)}
                selected={selected}
                onSelect={(p, v, n) => {
                  setSelected(p)
                  if (n !== null) setEditing({ anchor: ptrAnchor(doc, p), value: JSON.stringify(v), label: p })
                }}
                onEdit={(p, v) =>
                  setEditing({ anchor: ptrAnchor(doc, p), value: JSON.stringify(v), label: p })
                }
                empty={t('nothing to show')}
              />
            </div>
          )}

          {effective === 'criteria' && <CriteriaLens doc={doc} onEdit={stage} />}

          {effective === 'items' && <ItemsLens rows={rows} />}

          {effective === 'passk' && <PassKLens rows={rows} />}

          {effective === 'chat' && <ChatLens doc={doc} rows={rows} />}

          {effective === 'table' && (
            <DataTable
              rows={rows}
              columns={columns}
              rowKey={(r) => String(r.line)}
              selectedKey={selected}
              value={(r, p) => (r.value as Record<string, unknown> | null)?.[p]}
              gutter={(r) => r.line}
              onPick={(r) => {
                setSelected(String(r.line))
                if (r.value) {
                  setEditing({
                    anchor: { kind: 'line', n: r.line, pointer: null },
                    value: JSON.stringify(r.value),
                    label: t('line {n}', { n: r.line }),
                  })
                }
              }}
              empty={
                doc.kind === 'jsonDoc'
                  ? t('this is one document - try the Tree lens')
                  : t('no rows')
              }
            />
          )}
        </div>
      </div>

      <div className="data-side">
        {editing ? (
          <Editor
            editing={editing}
            onChange={(v) => setEditing({ ...editing, value: v })}
            onCancel={() => setEditing(null)}
            onStage={() => {
              let parsed: unknown
              try {
                parsed = JSON.parse(editing.value)
              } catch {
                // A bare string is the common case for a text field, so accept
                // it rather than refusing the edit on a quoting technicality.
                parsed = editing.value
              }
              stage(editing.anchor, parsed, editing.label)
              setEditing(null)
              toast(t('staged - save a copy to keep it'), 'ok')
            }}
          />
        ) : (
          <div className="side-hint">
            <Section label={t('Inspector')}>
              <p className="hint">
                {t('Click a cell or a row, then a value, to edit it. Changes are held here until you save.')}
              </p>
              {drafts.length > 0 && (
                <div className="draftlist">
                  {drafts.map((d, i) => (
                    <div className="draftrow" key={i}>
                      <span className="mono tiny truncate">{d.label}</span>
                      <div className="grow" />
                      <button
                        className="ikon"
                        title={t('Remove')}
                        onClick={() => setDrafts((x) => x.filter((_, j) => j !== i))}
                      >
                        <Icon name="x" size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </Section>

            <Section label={t('Shape')}>
              <div className="kv">
                <div className="k">{t('rows sampled')}</div>
                <div className="v">{doc.shape.sampled}</div>
                <div className="k">{t('columns seen')}</div>
                <div className="v">{doc.shape.keys.length}</div>
                <div className="k">{t('tabular')}</div>
                <div className="v">{doc.shape.tabular ? 'yes' : 'no'}</div>
              </div>
              <div className="keylist">
                {doc.shape.keys.slice(0, 30).map((k) => (
                  <div className="keyrow" key={k.path} title={`${(k.coverage * 100).toFixed(0)}% · ${k.types.join('|')}`}>
                    <span className="mono tiny truncate">{k.path}</span>
                    <div className="grow" />
                    <span className="tiny faint mono">{k.types.join('|')}</span>
                    <span className="tiny faint">{(k.coverage * 100).toFixed(0)}%</span>
                  </div>
                ))}
              </div>
            </Section>
          </div>
        )}
      </div>
    </div>
  )
}

/** A tree pointer has to become a document anchor; a line tree cannot address. */
function ptrAnchor(doc: Document, pointer: string): Anchor {
  return doc.kind === 'jsonDoc'
    ? { kind: 'pointer', p: pointer }
    : { kind: 'line', n: 1, pointer }
}

// ------------------------------------------------------------------ lenses

function RawLens({ doc }: { doc: Document }) {
  const t = useT()
  const text = doc.kind === 'jsonDoc' ? (doc.text ?? '') : doc.rows.map((r) => r.raw).join('\n')
  const lines = text.split('\n')
  return (
    <div className="raw-pane">
      {doc.note && <div className="note-line">{t(doc.note)}</div>}
      <pre className="code wrap raw">
        {lines.map((l, i) => (
          <div className="rawrow" key={i}>
            <span className="rawln">{i + 1}</span>
            <span className="rawtext">{l}</span>
          </div>
        ))}
      </pre>
    </div>
  )
}

/** harvey task.json: the rubric is the point, so it gets a table of its own. */
function CriteriaLens({ doc, onEdit }: { doc: Document; onEdit: (a: Anchor, v: unknown, l: string) => void }) {
  const t = useT()
  const head = doc.doc as Record<string, unknown> | null
  if (!head) return <Empty title={t('not a document')} />
  const criteria = Array.isArray(head.criteria) ? (head.criteria as Record<string, unknown>[]) : []
  const [open, setOpen] = useState<number | null>(null)

  return (
    <div className="crit-pane">
      <div className="crit-head">
        <h2 className="crit-title">{String(head.title ?? doc.name)}</h2>
        <div className="row wrap" style={{ gap: 6, margin: '6px 0 10px' }}>
          {head.work_type ? <Badge kind="info">{String(head.work_type)}</Badge> : null}
          {Array.isArray(head.tags) &&
            (head.tags as string[]).map((tg) => <Badge key={tg}>{tg}</Badge>)}
          <Badge kind="violet">{t('{n} criteria', { n: criteria.length })}</Badge>
        </div>
        {typeof head.instructions === 'string' && (
          <pre className="code wrap instr">{head.instructions}</pre>
        )}
      </div>

      <div className="table-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 74 }}>{t('id')}</th>
              <th style={{ width: '34%' }}>{t('criterion')}</th>
              <th>{t('what the judge looks for')}</th>
              <th style={{ width: 90 }}>{t('files')}</th>
            </tr>
          </thead>
          <tbody>
            {criteria.map((c, i) => {
              const dels = Array.isArray(c.deliverables) ? (c.deliverables as string[]) : []
              return (
                <tr key={i} className={open === i ? 'on' : ''} onClick={() => setOpen(open === i ? null : i)}>
                  <td className="mono tiny">{String(c.id ?? i + 1)}</td>
                  <td className="strong">{String(c.title ?? '')}</td>
                  <td>
                    <div className={'crit-mc' + (open === i ? ' open' : '')}>
                      {String(c.match_criteria ?? '')}
                    </div>
                    {open === i && (
                      <button
                        className="btn sm"
                        style={{ marginTop: 8 }}
                        onClick={(e) => {
                          e.stopPropagation()
                          onEdit(
                            { kind: 'pointer', p: `/criteria/${i}/match_criteria` },
                            c.match_criteria,
                            `criteria[${i}].match_criteria`,
                          )
                        }}
                      >
                        <Icon name="pencil" size={11} /> {t('Edit this criterion')}
                      </button>
                    )}
                  </td>
                  <td className="tiny faint">{dels.length ? dels.join(', ') : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Eval jsonl: a summary line then per-item rows. The first row is the summary. */
function ItemsLens({ rows }: { rows: Row[] }) {
  const t = useT()
  const head = rows[0]?.value as Record<string, unknown> | undefined
  const items = rows
    .slice(1)
    .filter((r) => r.value && typeof r.value === 'object')
    .map((r): Rec => ({ ...(r.value as Record<string, unknown>), __line: r.line }))
  const [open, setOpen] = useState<number | null>(null)
  const [filter, setFilter] = useState<'all' | 'wrong' | 'right'>('all')

  const shown = items.filter((r) =>
    filter === 'all' ? true : filter === 'wrong' ? r.correct === false : r.correct === true,
  )

  return (
    <div className="items-pane">
      {head && (
        <div className="card tight" style={{ marginBottom: 10 }}>
          <div className="row wrap" style={{ gap: 18 }}>
            <Stat k="model" v={String(head.model ?? '—')} />
            {head.n != null && <Stat k="n" v={String(head.n)} />}
            {head.acc != null && <Stat k="acc" v={String(head.acc)} tone="accent" />}
            <div className="grow" />
            <div className="row" style={{ gap: 4 }}>
              {(['all', 'wrong', 'right'] as const).map((f) => (
                <button
                  key={f}
                  className={'chip' + (filter === f ? ' on' : '')}
                  onClick={() => setFilter(f)}
                >
                  {t(f)}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      <div className="table-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 52 }}>{t('#')}</th>
              <th style={{ width: '42%' }}>{t('question')}</th>
              <th style={{ width: 90 }}>{t('ref')}</th>
              <th style={{ width: 90 }}>{t('pred')}</th>
              <th style={{ width: 64 }}>{t('ok')}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={String(r.i ?? i)} className={open === i ? 'on' : ''} onClick={() => setOpen(open === i ? null : i)}>
                <td className="mono tiny">{String(r.i ?? i)}</td>
                <td>
                  <div className="qcell">{String(r.question ?? '')}</div>
                  {open === i && typeof r.gen === 'string' && (
                    <pre className="code wrap" style={{ marginTop: 8, maxHeight: 340 }}>
                      {r.gen}
                    </pre>
                  )}
                </td>
                <td className="mono">{String(r.ref ?? '')}</td>
                <td className={'mono ' + (r.correct ? 'ok-text' : 'bad-text')}>{String(r.pred ?? '')}</td>
                <td>{r.correct ? <Badge kind="ok">✓</Badge> : <Badge kind="bad">✗</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="tiny faint" style={{ padding: '8px 2px' }}>
        {t('{a} of {b} rows', { a: shown.length, b: items.length })}
      </div>
    </div>
  )
}

/** pass@k: the head carries the curve; each item expands into its G samples. */
function PassKLens({ rows }: { rows: Row[] }) {
  const t = useT()
  const head = rows[0]?.value as Record<string, unknown> | undefined
  const [open, setOpen] = useState<number | null>(null)

  const curve = useMemo(() => {
    if (!head) return null
    // The curve lives under E0 (or E0p); fall back to the top level.
    const src = (head.E0 ?? head.E0p ?? head) as Record<string, unknown>
    const pts: { k: number; v: number }[] = []
    for (const k of [1, 2, 4, 8, 16, 32, 64]) {
      const v = src[`pass_at_${k}`]
      if (typeof v === 'number') pts.push({ k, v })
    }
    const mean = src.mean_correct_of_G
    const lens = head.len_mean
    return { pts, mean: typeof mean === 'number' ? mean : null, len: typeof lens === 'number' ? lens : null }
  }, [head])

  const items = rows
    .slice(1)
    .filter((r) => r.value && typeof r.value === 'object')
    .map((r): Rec => ({ ...(r.value as Record<string, unknown>), __line: r.line }))

  return (
    <div className="passk-pane">
      {curve && curve.pts.length > 0 && (
        <div className="card tight" style={{ marginBottom: 10 }}>
          <div className="row" style={{ gap: 22, alignItems: 'flex-start' }}>
            <PassKCurve pts={curve.pts} />
            <div className="col" style={{ gap: 10, paddingTop: 4 }}>
              {curve.mean != null && <Stat k={t('mean correct of G')} v={curve.mean.toFixed(3)} tone="accent" />}
              {curve.len != null && <Stat k={t('mean output length')} v={curve.len.toFixed(0)} />}
              {head?.adapter ? <Stat k="adapter" v={baseName(String(head.adapter))} /> : null}
              {head?.temp != null && <Stat k="temp" v={String(head.temp)} />}
            </div>
          </div>
        </div>
      )}

      <div className="table-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 52 }}>{t('#')}</th>
              <th style={{ width: 92 }}>{t('ref')}</th>
              <th>{t('samples')}</th>
              <th style={{ width: 80 }}>{t('hit')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((r, i) => {
              const key = Object.keys((r.preds as Record<string, unknown>) ?? {})[0]
              const arr = ((r.preds as Record<string, unknown>)?.[key] as number[]) ?? []
              const ref = Number(r.ref)
              const hits = arr.filter((v) => v === ref).length
              const lens = (r.lens as number[]) ?? []
              return (
                <tr key={String(r.i ?? i)} className={open === i ? 'on' : ''} onClick={() => setOpen(open === i ? null : i)}>
                  <td className="mono tiny">{String(r.i ?? i)}</td>
                  <td className="mono">{String(r.ref ?? '')}</td>
                  <td>
                    <div className="cells">
                      {arr.map((v, j) => (
                        <span
                          key={j}
                          className={'cell' + (v === ref ? ' hit' : '')}
                          title={`sample ${j}: ${v}${lens[j] ? ` (${lens[j]} chars)` : ''}`}
                        />
                      ))}
                    </div>
                    {open === i && (
                      <div className="mono tiny faint" style={{ marginTop: 6, overflowWrap: 'anywhere' }}>
                        {arr.join(', ')}
                      </div>
                    )}
                  </td>
                  <td className="mono">
                    {hits}/{arr.length}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="tiny faint" style={{ padding: '8px 2px' }}>
        {t('{n} items; each cell is one of G samples', { n: items.length })}
      </div>
    </div>
  )
}

/** A small k-vs-pass@k line, drawn directly. No chart library for one polyline. */
function PassKCurve({ pts }: { pts: { k: number; v: number }[] }) {
  const w = 260
  const h = 92
  const pad = 20
  const maxK = Math.max(...pts.map((p) => p.k))
  const x = (k: number) => pad + (Math.log2(k) / Math.log2(maxK)) * (w - pad * 2)
  const y = (v: number) => h - pad - v * (h - pad * 2)
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.k).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')
  return (
    <svg width={w} height={h} className="curve">
      <line x1={pad} y1={h - pad} x2={w - pad} y2={h - pad} stroke="var(--line)" />
      <line x1={pad} y1={pad} x2={pad} y2={h - pad} stroke="var(--line)" />
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth={1.8} />
      {pts.map((p) => (
        <g key={p.k}>
          <circle cx={x(p.k)} cy={y(p.v)} r={2.6} fill="var(--accent)" />
          <text x={x(p.k)} y={h - 6} textAnchor="middle" className="curve-tick">
            {p.k}
          </text>
          <text x={x(p.k)} y={y(p.v) - 6} textAnchor="middle" className="curve-val">
            {p.v.toFixed(2)}
          </text>
        </g>
      ))}
    </svg>
  )
}

/** OpenAI / Anthropic payloads, and harvey transcripts, as a conversation. */
function ChatLens({ doc, rows }: { doc: Document; rows: Row[] }) {
  const t = useT()
  const head = (doc.kind === 'jsonDoc' ? doc.doc : rows[0]?.value) as Record<string, unknown> | null

  const messages = useMemo(() => {
    if (!head) return []
    // An OpenAI response wraps the message in choices[]; a request or an
    // Anthropic object has messages[] directly.
    if (Array.isArray(head.choices)) {
      return (head.choices as Record<string, unknown>[]).map((c) => ({
        role: String((c.message as Record<string, unknown>)?.role ?? 'assistant'),
        content: (c.message as Record<string, unknown>)?.content ?? c.text ?? '',
      }))
    }
    if (Array.isArray(head.messages)) {
      return (head.messages as Record<string, unknown>[]).map((m) => ({
        role: String(m.role ?? 'user'),
        content: m.content ?? '',
      }))
    }
    // A transcript: one record per line.
    return rows
      .filter((r) => r.value && typeof r.value === 'object')
      .map((r) => {
        const v = r.value as Record<string, unknown>
        const msg = (v.message as Record<string, unknown>) ?? v
        return { role: String(msg.role ?? v.type ?? 'user'), content: msg.content ?? v.text ?? '' }
      })
  }, [head, rows])

  if (messages.length === 0) return <Empty title={t('no messages found')} />
  return (
    <div className="chat-pane">
      {typeof head?.system === 'string' && (
        <div className="msg sys">
          <div className="msg-role">{t('system')}</div>
          <pre className="code wrap">{head.system}</pre>
        </div>
      )}
      {messages.map((m, i) => (
        <div className={'msg ' + m.role} key={i}>
          <div className="msg-role">{m.role}</div>
          {typeof m.content === 'string' ? (
            <pre className="code wrap">{m.content}</pre>
          ) : (
            <div className="blocks">
              {(Array.isArray(m.content) ? m.content : [m.content]).map((b, j) => {
                const blk = b as Record<string, unknown>
                const type = String(blk?.type ?? (typeof b === 'string' ? 'text' : 'json'))
                return (
                  <div className={'blk blk-' + type} key={j}>
                    <div className="blk-type">{type}</div>
                    <pre className="code wrap">
                      {type === 'text' || type === 'thinking'
                        ? String(blk.text ?? '')
                        : JSON.stringify(blk, null, 2)}
                    </pre>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------ pieces

function Editor({
  editing,
  onChange,
  onCancel,
  onStage,
}: {
  editing: { anchor: Anchor; value: string; label: string }
  onChange: (v: string) => void
  onCancel: () => void
  onStage: () => void
}) {
  const t = useT()
  const a = editing.anchor
  const where =
    a.kind === 'line' ? t('line {n}{p}', { n: a.n, p: a.pointer ? ' · ' + a.pointer : '' }) : a.p
  const valid = useMemo(() => {
    try {
      JSON.parse(editing.value)
      return true
    } catch {
      return false
    }
  }, [editing.value])
  return (
    <div className="editor">
      <div className="row" style={{ gap: 8, marginBottom: 8 }}>
        <Icon name="pencil" size={12} />
        <span className="small" style={{ fontWeight: 600 }}>
          {t('Edit')}
        </span>
        <div className="grow" />
        <span className="mono tiny faint truncate" title={where}>
          {where}
        </span>
      </div>
      <textarea
        className="textarea"
        rows={10}
        value={editing.value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
      {!valid && (
        <div className="hint" style={{ color: 'var(--warn)' }}>
          {t('not valid JSON - it will be saved as a plain string')}
        </div>
      )}
      <div className="row" style={{ gap: 6, marginTop: 8 }}>
        <button className="btn sm primary" onClick={onStage}>
          {t('Stage change')}
        </button>
        <button className="btn sm ghost" onClick={onCancel}>
          {t('Cancel')}
        </button>
      </div>
    </div>
  )
}

function Stat({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className="stat">
      <div className={'v sm ' + (tone ?? '')}>{v}</div>
      <div className="k">{k}</div>
    </div>
  )
}

/** The paths this machine actually keeps data in, so the view is not empty-first. */
function QuickPaths({ onPick }: { onPick: (p: string) => void }) {
  const t = useT()
  const [found, setFound] = useState<{ label: string; path: string }[]>([])

  useEffect(() => {
    // A few known-good files, checked by opening nothing: we only offer what
    // the user told us about in the repo layout.
    const guesses = [
      { label: 'harvey task.json (banking)', path: 'D:/llm_learn/miro_mind/harvey-labs/tasks/contracts/banking/account-control-agreement-first-draft/scenario-01/task.json' },
      { label: 'pass@k (a1)', path: 'D:/llm_learn/miro_mind/reasoning_lab/curriculum/passk/u8_a1_T08.jsonl' },
      { label: 'eval jsonl (grpo final)', path: 'D:/llm_learn/miro_mind/reasoning_lab/evals/grpo_final.jsonl' },
    ]
    setFound(guesses)
  }, [])

  if (found.length === 0) return null
  return (
    <div className="quick">
      <div className="tiny faint" style={{ marginBottom: 6 }}>
        {t('Or jump straight to a file this machine already has:')}
      </div>
      <div className="row wrap" style={{ gap: 6 }}>
        {found.map((f) => (
          <button key={f.path} className="chip" title={f.path} onClick={() => onPick(f.path)}>
            {f.label}
          </button>
        ))}
      </div>
    </div>
  )
}
