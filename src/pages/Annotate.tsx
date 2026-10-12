import { useEffect, useMemo, useRef, useState } from 'react'
import { save as saveDialog } from '@tauri-apps/plugin-dialog'
import { Badge, Card, Icon, Spinner } from '../components/ui'
import * as api from '../lib/api'
import { fmtDur, baseName } from '../lib/format'
import { useT } from '../lib/i18n'
import { useApp } from '../lib/store'
import type { TurnSegment } from '../lib/types'

type SortKey = 'id' | 'nTools' | 'nErrors' | 'nAsstChars' | 'durationSec'

interface Rules {
  minTools: number
  maxTools: number
  minChars: number
  errors: 'any' | 'none' | 'some'
  onlyInterrupted: boolean
  q: string
}

const DEFAULT_RULES: Rules = {
  minTools: 0,
  maxTools: 0,
  minChars: 0,
  errors: 'any',
  onlyInterrupted: false,
  q: '',
}

function applyRules(turns: TurnSegment[], r: Rules): TurnSegment[] {
  const needle = r.q.trim().toLowerCase()
  return turns.filter((t) => {
    if (r.minTools && t.nTools < r.minTools) return false
    if (r.maxTools && t.nTools > r.maxTools) return false
    if (r.minChars && t.nAsstChars < r.minChars) return false
    if (r.errors === 'none' && t.nErrors > 0) return false
    if (r.errors === 'some' && t.nErrors === 0) return false
    if (r.onlyInterrupted && t.nInterrupts === 0) return false
    if (needle) {
      const hay = (t.title || '') + ' ' + t.userRequest + ' ' + t.digest + ' ' + t.filesTouched.join(' ')
      if (!hay.toLowerCase().includes(needle)) return false
    }
    return true
  })
}

function PoolRow({ t: turn, on, toggle }: { t: TurnSegment; on: boolean; toggle: () => void }) {
  const t = useT()
  return (
    <div className={'tl-step' + (on ? ' active' : '')} onClick={toggle} style={{ cursor: 'pointer' }}>
      <div className="tl-gutter">
        <input type="checkbox" checked={on} onChange={toggle} onClick={(e) => e.stopPropagation()} />
      </div>
      <div className="tl-body">
        <div className="tl-head">
          <span className="tiny faint mono">{turn.id}</span>
          {turn.nErrors > 0 && <Badge kind="bad">{turn.nErrors}</Badge>}
          {turn.nInterrupts > 0 && <Badge kind="violet">{turn.nInterrupts}</Badge>}
          <span className="tiny faint mono" style={{ marginLeft: 'auto' }}>{t('{n} tools', { n: turn.nTools })}</span>
        </div>
        <div className="tl-text">{turn.title || turn.userRequest.slice(0, 140)}</div>
        {turn.filesTouched.length > 0 && (
          <div className="tiny faint mono truncate" style={{ marginTop: 3 }}>
            {turn.filesTouched.slice(0, 3).map((f) => baseName(f)).join(', ')}
            {turn.filesTouched.length > 3 ? ` +${turn.filesTouched.length - 3}` : ''}
          </div>
        )}
      </div>
    </div>
  )
}

function SchemaPreview({ activeId, onChange }: { activeId: string; onChange: (id: string) => void }) {
  const t = useT()
  const { config } = useApp()
  const schemas = config?.schemas ?? []
  const cur = schemas.find((s) => s.id === activeId)
  return (
    <>
      <div className="field">
        <label>{t('Rubric')}</label>
        <select className="select" value={activeId} onChange={(e) => onChange(e.target.value)}>
          {schemas.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </div>
      {cur && (
        <>
          <p className="tiny faint" style={{ marginTop: -6, marginBottom: 10 }}>{cur.instructions.slice(0, 300)}</p>
          <div className="row wrap" style={{ gap: 6 }}>
            {cur.fields.map((f) => (
              <span key={f.name} className="badge" title={f.description}>
                {f.name}
                <span className="faint"> :{f.kind}</span>
              </span>
            ))}
          </div>
        </>
      )}
    </>
  )
}

export default function Annotate() {
  const t = useT()
  const app = useApp()
  const { scan, selected, pool, poolLoading, buildPool, clearPool, job, labels, startLabeling, cancelLabeling, clearLabels, config, toast } = app
  const [rules, setRules] = useState<Rules>(DEFAULT_RULES)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [schemaId, setSchemaId] = useState('')
  const [outputPath, setOutputPath] = useState('')
  const [extra, setExtra] = useState('')
  const [sort, setSort] = useState<SortKey>('id')
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (config && !schemaId) setSchemaId(config.activeSchemaId || config.schemas[0]?.id || '')
  }, [config, schemaId])

  useEffect(() => {
    if (outputPath === '' && config?.outputDir) {
      setOutputPath(config.outputDir.replace(/[\/]+$/, '') + '/tracematter-labels.jsonl')
    }
  }, [config, outputPath])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [labels.length])

  const filtered = useMemo(() => applyRules(pool, rules), [pool, rules])

  const sorted = useMemo(() => {
    const v = (t: TurnSegment) => (sort === 'id' ? t.id : (t[sort] as number) ?? 0)
    return [...filtered].sort((a, b) => {
      const x = v(a)
      const y = v(b)
      return typeof x === 'string' ? x.localeCompare(String(y)) : (x as number) - (y as number)
    })
  }, [filtered, sort])

  const chosen = useMemo(() => sorted.filter((t) => picked.has(t.id)), [sorted, picked])

  const toggle = (id: string) =>
    setPicked((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const pickAll = () => setPicked(new Set(sorted.map((t) => t.id)))
  const pickNone = () => setPicked(new Set())

  const run = async () => {
    const rows = chosen.length > 0 ? chosen : sorted
    if (rows.length === 0) {
      toast(t('nothing to label'), 'err')
      return
    }
    await startLabeling({ segments: rows, schemaId, outputPath: outputPath || null, systemExtra: extra })
  }

  const browseOut = async () => {
    try {
      const p = await saveDialog({ title: t('Where should labels go?'), defaultPath: 'tracematter-labels.jsonl' })
      if (typeof p === 'string') setOutputPath(p)
    } catch (e) {
      toast(api.humanError(e), 'err')
    }
  }

  const running = job?.status === 'running'
  const pct = job && job.total > 0 ? job.completed / job.total : 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {job && (
        <div className="jobbar">
          <Badge kind={job.status === 'done' ? 'ok' : job.status === 'failed' ? 'bad' : 'info'}>{job.status}</Badge>
          <span className="small mono">{job.completed}/{job.total}</span>
          {job.failed > 0 && <span className="small" style={{ color: 'var(--bad)' }}>{t('{n} failed', { n: job.failed })}</span>}
          <div className="progress-track">
            <div className="progress-fill" style={{ width: (pct * 100).toFixed(1) + '%' }} />
          </div>
          <span className="tiny faint">{fmtDur(job.startedAt ? (Date.now() - new Date(job.startedAt).getTime()) / 1000 : null)}</span>
          {running ? (
            <button className="btn danger sm" onClick={cancelLabeling}><Icon name="stop" size={12} /> {t('stop')}</button>
          ) : (
            <button className="btn ghost sm" onClick={clearLabels}>{t('clear')}</button>
          )}
        </div>
      )}

      <div className="split" style={{ flex: 1, minHeight: 0 }}>
        <div className="pane bordered" style={{ padding: 12 }}>
          <div className="row" style={{ marginBottom: 10, gap: 6 }}>
            <button
              className="btn sm"
              disabled={!scan || poolLoading}
              onClick={() => buildPool(Array.from(selected))}
            >
              {poolLoading ? <Spinner /> : <Icon name="download" size={13} />} {t('Harvest turns')}
            </button>
            <span className="tiny faint">{t('{n} sessions ticked', { n: selected.size })}</span>
          </div>
          <p className="tiny faint" style={{ marginTop: 0 }}>
            {t('Ticking sessions on the Sessions screen and harvesting here splits every one of them into per-turn segments, each with a head-and-tail digest.')}
          </p>

          <div className="sep" />

          <input
            className="input"
            style={{ marginBottom: 8, fontSize: 12.5 }}
            placeholder={t('Search turns')}
            value={rules.q}
            onChange={(e) => setRules({ ...rules, q: e.target.value })}
          />
          <div className="grid-2" style={{ marginBottom: 8 }}>
            <div>
              <label className="tiny faint">{t('min tools')}</label>
              <input className="input" type="number" value={rules.minTools} onChange={(e) => setRules({ ...rules, minTools: +e.target.value || 0 })} />
            </div>
            <div>
              <label className="tiny faint">{t('min answer chars')}</label>
              <input className="input" type="number" value={rules.minChars} onChange={(e) => setRules({ ...rules, minChars: +e.target.value || 0 })} />
            </div>
          </div>
          <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
            {(['any', 'some', 'none'] as const).map((m) => (
              <button key={m} className={'chip' + (rules.errors === m ? ' on' : '')} onClick={() => setRules({ ...rules, errors: m })}>
                {t('errors: ' + m)}
              </button>
            ))}
            <button
              className={'chip' + (rules.onlyInterrupted ? ' on' : '')}
              onClick={() => setRules({ ...rules, onlyInterrupted: !rules.onlyInterrupted })}
            >
              {t('interrupted')}
            </button>
          </div>

          <div className="row" style={{ marginBottom: 8, gap: 6 }}>
            <select className="select" style={{ maxWidth: 130, fontSize: 12 }} value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              <option value="id">{t('sort: id')}</option>
              <option value="nTools">{t('sort: tools')}</option>
              <option value="nErrors">{t('sort: errors')}</option>
              <option value="nAsstChars">{t('sort: length')}</option>
              <option value="durationSec">{t('sort: duration')}</option>
            </select>
            <button className="btn sm" onClick={pickAll}>{t('all')}</button>
            <button className="btn sm" onClick={pickNone}>{t('none')}</button>
            <span className="tiny faint">{t('{n} picked', { n: picked.size })}</span>
          </div>

          <div style={{ maxHeight: 'calc(100vh - 430px)', overflow: 'auto' }}>
            {sorted.map((t) => (
              <PoolRow key={t.id} t={t} on={picked.has(t.id)} toggle={() => toggle(t.id)} />
            ))}
            {pool.length === 0 && !poolLoading && (
              <div className="tiny faint" style={{ padding: 12 }}>{t('No turns harvested yet.')}</div>
            )}
            {pool.length > 0 && sorted.length === 0 && (
              <div className="tiny faint" style={{ padding: 12 }}>{t('No turns pass the current filters.')}</div>
            )}
          </div>
        </div>

        <div className="pane" style={{ padding: 16 }}>
          <div style={{ maxWidth: 720 }}>
            <Card title={t('Run')} sub={t('Each picked turn becomes one request. Rows are written to disk as they finish, so a crash costs you nothing already done.')}>
              <SchemaPreview activeId={schemaId} onChange={setSchemaId} />

              <div className="field">
                <label>{t('Output file')}</label>
                <div className="row">
                  <input className="input mono grow" value={outputPath} onChange={(e) => setOutputPath(e.target.value)} placeholder="labels.jsonl" />
                  <button className="btn" onClick={browseOut}>{t('Browse')}</button>
                </div>
                <div className="hint">{t('Every finished row is appended here immediately.')}</div>
              </div>

              <div className="field">
                <label>{t('Extra instructions (optional)')}</label>
                <textarea
                  className="textarea"
                  rows={3}
                  value={extra}
                  onChange={(e) => setExtra(e.target.value)}
                  placeholder={t('Anything to add to the rubric for this run only.')}
                />
              </div>

              <div className="row" style={{ gap: 10 }}>
                <button className="btn primary" disabled={running || !schemaId || sorted.length === 0} onClick={run}>
                  {running ? <Spinner /> : <Icon name="play" size={13} />}
                  {runLabel(t, chosen.length, sorted.length)}
                </button>
                {pool.length > 0 && chosen.length === 0 && (
                  <span className="tiny faint">{t('nothing picked, so the whole filtered set will run')}</span>
                )}
              </div>

              {config && (
                <div className="hint" style={{ marginTop: 10 }}>
                  {t('gateway')} <span className="mono">{config.gateway.baseUrl || t('(unset)')}</span> · {t('model')}{' '}
                  <span className="mono">{config.gateway.model}</span> · {t('{n} in flight', { n: config.gateway.concurrency })}
                </div>
              )}
            </Card>

            {(labels.length > 0 || job) && (
              <div style={{ marginTop: 14 }}>
                <Card
                  title={t('Live results')}
                  sub={job ? t('{a} done, {b} failed', { a: job.completed, b: job.failed }) : t('{n} rows', { n: labels.length })}
                  actions={<button className="btn ghost sm" onClick={clearPool}>{t('forget pool')}</button>}
                >
                  <div className="log" ref={logRef}>
                    {labels.slice(-200).map((r) => (
                      <div key={r.id}>
                        <span className={r.error ? 'l-err' : 'l-ok'}>{r.error ? 'x' : t('ok')}</span>{' '}
                        <span className="faint">{r.id}</span>{' '}
                        {r.error ? r.error : JSON.stringify(r.values).slice(0, 220)}
                      </div>
                    ))}
                    {labels.length === 0 && <span className="faint">{t('waiting for the first row')}</span>}
                  </div>
                </Card>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function runLabel(t: (k: string, v?: Record<string, string | number>) => string, picked: number, total: number): string {
  return picked > 0 ? t('Label {n} picked turns', { n: picked }) : t('Label all {n} filtered turns', { n: total })
}
