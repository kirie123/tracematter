
import { useMemo, useState } from 'react'
import { Badge, CopyBtn, DiffView, Empty, Icon, Section, diffLines } from '../components/ui'
import { fmtClock, fmtCompact, fmtDur, splitPath } from '../lib/format'
import { useT } from '../lib/i18n'
import { useApp } from '../lib/store'
import type { Step, ToolCall } from '../lib/types'

type Tab = 'step' | 'workspace' | 'terminal' | 'turns'

/** Shape of a turn as the backend packs it into a trace. */
interface TurnRow {
  id: string
  index: number
  startStep: number
  title?: string | null
  userRequest: string
  digest: string
  nTools: number
  nErrors: number
  nInterrupts: number
  nAsstChars: number
}

const stepLabel = (s: Step) =>
  s.role === 'user' ? 'USER' : s.role === 'assistant' ? 'ASSISTANT' : 'SYSTEM'

/** One-line preview of a step, used by the timeline. */
const stepSnippet = (s: Step): string => {
  if (s.note) return s.note
  if (s.text) return s.text.replace(/\s+/g, ' ').trim().slice(0, 400)
  if (s.toolCalls.length) {
    return s.toolCalls.map((t) => t.brief).join(' | ').slice(0, 400)
  }
  if (s.toolResults.length) {
    return s.toolResults
      .map((r) => (r.isError ? 'ERROR ' : '') + r.content.replace(/\s+/g, ' '))
      .join(' | ')
      .slice(0, 400)
  }
  return ''
}

const hasError = (s: Step) => s.toolResults.some((r) => r.isError)

const EDIT_NAMES = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'str_replace_editor']
const isEdit = (name: string) => EDIT_NAMES.includes(name)

/** Tools whose `command` argument deserves to be written out in full. */
const SHELL_NAMES = ['Bash', 'bash', 'shell', 'sh', 'run_command', 'execute_bash']

/** File path named by a tool call, if it names one. */
export function callPath(tc: ToolCall): string | null {
  const a = tc.args as Record<string, unknown> | null
  if (!a || typeof a !== 'object') return null
  for (const k of ['file_path', 'path', 'notebook_path', 'target_file', 'absolute_path']) {
    const v = a[k]
    if (typeof v === 'string' && v) return v
  }
  return null
}

/** The parts of an edit or shell call that are worth rendering. */
export function callBody(tc: ToolCall) {
  const a = (tc.args || {}) as Record<string, unknown>
  const str = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : undefined)
  return {
    old: str('old_string') ?? str('old_str'),
    new: str('new_string') ?? str('new_str'),
    content: str('content') ?? str('file_text'),
    cmd: str('command') ?? str('cmd'),
  }
}

interface Filter {
  q: string
  only: 'all' | 'user' | 'tools' | 'errors' | 'edits' | 'thinking'
}

const FILTERS: { id: Filter['only']; label: string }[] = [
  { id: 'all', label: 'everything' },
  { id: 'user', label: 'human' },
  { id: 'tools', label: 'tool use' },
  { id: 'edits', label: 'edits' },
  { id: 'errors', label: 'errors' },
  { id: 'thinking', label: 'reasoning' },
]

function matches(s: Step, f: Filter): boolean {
  const q = f.q.trim().toLowerCase()
  if (q) {
    const hay = (
      stepSnippet(s) + ' ' + s.toolCalls.map((t) => t.brief).join(' ')
    ).toLowerCase()
    if (!hay.includes(q)) return false
  }
  switch (f.only) {
    case 'all': return true
    case 'user': return s.role === 'user' && !s.toolResults.length
    case 'tools': return s.toolCalls.length > 0
    case 'errors': return hasError(s)
    case 'edits': return s.toolCalls.some((t) => isEdit(t.name))
    case 'thinking': return !!s.thinking
  }
}

function Timeline({ steps, active, onPick, filter, setFilter, counts }: {
  steps: Step[]
  active: number
  onPick: (i: number) => void
  filter: Filter
  setFilter: (f: Filter) => void
  counts: Record<string, number>
}) {
  const t = useT()
  const shown = useMemo(
    () => steps.map((s, i) => ({ s, i })).filter(({ s }) => matches(s, filter)),
    [steps, filter],
  )
  return (
    <div className="tl-pane">
      {/* The controls live above the spine, not inside it. The spine is drawn
          on `.timeline`, which holds only steps, so the filter row cannot have
          a rule running down through it. */}
      <div className="tl-filter">
        <input
          className="input"
          style={{ fontSize: 12.5 }}
          placeholder={t('Search steps')}
          value={filter.q}
          onChange={(e) => setFilter({ ...filter, q: e.target.value })}
        />
        <div className="tl-filters">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              className={'chip' + (filter.only === f.id ? ' on' : '')}
              onClick={() => setFilter({ ...filter, only: f.id })}
            >
              {t(f.label)}
              {counts[f.id] ? <span className="faint"> {counts[f.id]}</span> : null}
            </button>
          ))}
        </div>
        <div className="tiny faint">{t('{n} steps', { n: shown.length })}</div>
      </div>

      <div className="tl-list">
        <div className="timeline">
          {shown.map(({ s, i }) => {
        const err = hasError(s)
        return (
          <div
            key={s.index}
            className={
              'tl-step' +
              (i === active ? ' active' : '') +
              (err ? ' err' : '') +
              (s.role === 'user' && !s.toolResults.length ? ' role-user' : '') +
              (s.role === 'assistant' ? ' role-assistant' : '')
            }
            onClick={() => onPick(i)}
          >
            <div className="tl-gutter">#{s.index}</div>
            <div className="tl-body">
            <div className="tl-head">
              <span className={'tl-role ' + s.role}>{t(stepLabel(s))}</span>
              {s.tSec != null && <span className="tiny faint mono" style={{ marginLeft: 'auto' }}>{fmtClock(s.tSec)}</span>}
            </div>
            <div className="tl-text">{(s.note ? t(s.note) : stepSnippet(s)) || <span className="faint">{t('(no content)')}</span>}</div>
            <div className="tl-meta">
              {s.toolCalls.length > 0 && (
                <Badge kind="info">
                  {t(s.toolCalls.length === 1 ? '{n} tool' : '{n} tools', { n: s.toolCalls.length })}
                </Badge>
              )}
              {err && <Badge kind="bad">{t('error')}</Badge>}
              {s.thinking && <Badge kind="violet">{t('reasoning')}</Badge>}
              {!!s.images && (
                <Badge kind="warn">
                  {t(s.images === 1 ? '{n} image' : '{n} images', { n: s.images })}
                </Badge>
              )}
              {s.isSidechain && <Badge>{t('subagent')}</Badge>}
              {s.usage && s.usage.contextTokens > 0 && (
                <span className="tiny faint mono">{t('{n} ctx', { n: fmtCompact(s.usage.contextTokens) })}</span>
              )}
              </div>
            </div>
          </div>
        )
          })}
          {shown.length === 0 && (
            <div className="empty" style={{ height: 160 }}>{t('nothing matches this filter')}</div>
          )}
        </div>
      </div>
    </div>
  )
}

function ToolCallCard({ tc, result, defaultOpen }: {
  tc: ToolCall
  result?: { isError: boolean; content: string; truncated: boolean }
  defaultOpen?: boolean
}) {
  const t = useT()
  const body = callBody(tc)
  const path = callPath(tc)
  const isEditCall = isEdit(tc.name)

  // An edit shows a real diff; anything else shows its raw arguments.
  const diff = useMemo(() => {
    if (!isEditCall) return null
    if (body.old != null && body.new != null) return diffLines(body.old, body.new)
    if (body.content != null) return diffLines('', body.content)
    return null
  }, [isEditCall, body.old, body.new, body.content])

  const argText = useMemo(() => {
    try {
      return JSON.stringify(tc.args, null, 2)
    } catch {
      return String(tc.args)
    }
  }, [tc.args])

  // A shell call gets its command written out in full. `tc.brief` is clipped at
  // 110 characters for the timeline row, and reading a step is exactly when the
  // rest of the command matters — so the detail pane must not reuse it.
  const shell = SHELL_NAMES.includes(tc.name)
  const command = shell ? body.cmd : undefined

  return (
    <details className="tool-call" open={defaultOpen}>
      <summary>
        <span className="tool-name">{tc.name}</span>
        {path && <span className="tiny faint mono truncate">{splitPath(path).slice(-2).join('/')}</span>}
        {!diff && <span className="tiny faint truncate grow">{tc.brief}</span>}
        <span className="grow" />
        {result?.isError && <Badge kind="bad">{t('failed')}</Badge>}
        {result && !result.isError && <Badge kind="ok">{t('ok')}</Badge>}
      </summary>
      <div className="body">
        {diff ? (
          <>
            {path && (
              <div className="row" style={{ marginBottom: 8, gap: 8 }}>
                <Icon name="file" size={13} />
                <span className="tiny mono dim truncate">{path}</span>
                <div className="grow" />
                <CopyBtn text={path} />
              </div>
            )}
            <DiffView lines={diff} />
          </>
        ) : command != null ? (
          <div className="shell-block">
            <div className="row" style={{ marginBottom: 5, gap: 8 }}>
              <span className="tiny" style={{ fontWeight: 650 }}>{t('COMMAND')}</span>
              <span className="tiny faint">{t('{n} chars', { n: command.length })}</span>
              <div className="grow" />
              <CopyBtn text={command} />
            </div>
            <pre className="code wrap">{command}</pre>
          </div>
        ) : (
          <pre className="code wrap">{argText}</pre>
        )}
        {result && (
          <div className={'result' + (result.isError ? ' err' : '')} style={{ marginTop: 10 }}>
            <div className="row" style={{ marginBottom: 5, gap: 8 }}>
              <span className="tiny" style={{ fontWeight: 650 }}>{t('RESULT')}</span>
              {result.truncated && <span className="tiny faint">{t('(truncated)')}</span>}
              <div className="grow" />
              <CopyBtn text={result.content} />
            </div>
            <pre className="code wrap" style={{ maxHeight: 300 }}>{result.content || t('(empty)')}</pre>
          </div>
        )}
      </div>
    </details>
  )
}

function StepDetail({ step, onJump }: { step: Step; onJump: (i: number) => void }) {
  const t = useT()
  const results = new Map(step.toolResults.map((r) => [r.toolUseId || '', r]))
  return (
    <div className="detail">
      <div className="detail-head">
        <Badge kind={step.role === 'user' ? 'violet' : 'info'}>{t(stepLabel(step))}</Badge>
        <span className="mono small dim">{t('step #{n}', { n: step.index })}</span>
        {step.tSec != null && (
          <span className="small faint row" style={{ gap: 4 }}>
            <Icon name="clock" size={12} /> {fmtClock(step.tSec)}
          </span>
        )}
        {step.isSidechain && <Badge>{t('subagent')}</Badge>}
        <div className="grow" />
        <button className="btn ghost sm" disabled={step.index <= 0} onClick={() => onJump(step.index - 1)}>{t('prev')}</button>
        <button className="btn ghost sm" onClick={() => onJump(step.index + 1)}>{t('next')}</button>
      </div>

      {step.note && (
        <div className="result" style={{ borderLeftColor: 'var(--violet)' }}>
          <pre className="code wrap" style={{ background: 'none', border: 0, padding: 0 }}>{t(step.note)}</pre>
        </div>
      )}

      {step.usage && (
        <div className="row wrap" style={{ gap: 16, marginBottom: 14 }}>
          <Stat2 k="context" v={fmtCompact(step.usage.contextTokens)} />
          <Stat2 k="input" v={fmtCompact(step.usage.inputTokens)} />
          <Stat2 k="output" v={fmtCompact(step.usage.outputTokens)} />
          {step.usage.thinkingTokens > 0 && <Stat2 k="thinking" v={fmtCompact(step.usage.thinkingTokens)} />}
          {step.usage.cacheReadTokens > 0 && <Stat2 k="cache read" v={fmtCompact(step.usage.cacheReadTokens)} />}
          {step.usage.cacheCreationTokens > 0 && <Stat2 k="cache write" v={fmtCompact(step.usage.cacheCreationTokens)} />}
        </div>
      )}

      {step.thinking && (
        <Section label={t('reasoning')} right={<CopyBtn text={step.thinking} />}>
          <pre className="code wrap" style={{ maxHeight: 420 }}>{step.thinking}</pre>
        </Section>
      )}

      {step.text && (
        <Section label={t('message')} right={<CopyBtn text={step.text} />}>
          <pre className="code wrap">{step.text}</pre>
        </Section>
      )}

      {step.toolCalls.length > 0 && (
        <Section label={t('tool calls ({n})', { n: step.toolCalls.length })}>
          {step.toolCalls.map((tc) => (
            <ToolCallCard
              key={tc.id || tc.name}
              tc={tc}
              result={tc.id ? results.get(tc.id) : undefined}
              defaultOpen={step.toolCalls.length <= 2}
            />
          ))}
        </Section>
      )}

      {step.toolResults.length > 0 && step.toolCalls.length === 0 && (
        <Section label={t('tool results ({n})', { n: step.toolResults.length })}>
          {step.toolResults.map((r, k) => (
            <div key={k} className={'result' + (r.isError ? ' err' : '')}>
              <div className="row" style={{ marginBottom: 5 }}>
                <span className="tiny" style={{ fontWeight: 650 }}>{t(r.isError ? 'ERROR' : 'OK')}</span>
                <div className="grow" />
                <CopyBtn text={r.content} />
              </div>
              <pre className="code wrap" style={{ maxHeight: 320 }}>{r.content || t('(empty)')}</pre>
            </div>
          ))}
        </Section>
      )}
    </div>
  )
}

function Stat2({ k, v }: { k: string; v: string }) {
  const t = useT()
  return (
    <div>
      <div className="mono small">{v}</div>
      <div className="tiny faint">{t(k)}</div>
    </div>
  )
}

function TerminalPanel({ cmds, onJump }: { cmds: { cmd: string; step: number; isError: boolean }[]; onJump: (i: number) => void }) {
  const t = useT()
  const [q, setQ] = useState('')
  const [onlyErr, setOnlyErr] = useState(false)
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return cmds.filter(
      (c) => (!onlyErr || c.isError) && (!needle || c.cmd.toLowerCase().includes(needle)),
    )
  }, [cmds, q, onlyErr])
  const distinct = useMemo(() => new Set(cmds.map((c) => c.cmd)).size, [cmds])
  return (
    <div className="detail">
      <div className="row wrap" style={{ marginBottom: 12, gap: 8 }}>
        <input
          className="input"
          style={{ maxWidth: 320 }}
          placeholder={t('Filter shell commands')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button className={'chip' + (onlyErr ? ' on' : '')} onClick={() => setOnlyErr((v) => !v)}>{t('failed only')}</button>
        <span className="tiny faint">{t('{n} commands, {d} distinct', { n: cmds.length, d: distinct })}</span>
      </div>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 52 }}>{t('Step')}</th>
              <th>{t('Command')}</th>
              <th style={{ width: 70 }} className="right">{t('Result')}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((c, k) => (
              <tr key={k} onClick={() => onJump(c.step)} style={{ cursor: 'pointer' }}>
                <td className="mono tiny faint">#{c.step}</td>
                <td className="mono" style={{ wordBreak: 'break-word' }}>{c.cmd}</td>
                <td className="right">
                  {c.isError ? <Badge kind="bad">{t('fail')}</Badge> : <Badge kind="ok">{t('ok')}</Badge>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && <Empty title={t('No shell commands')} hint={t('This session never ran a shell tool.')} />}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------- page

function WorkspacePanel({ trace }: { trace: { files: string[]; steps: Step[] } }) {
  const t = useT()
  const [pick, setPick] = useState<string | null>(null)
  const [q, setQ] = useState('')

  // Latest version of each file, rebuilt by replaying every write and edit in
  // order. Reads do not materialise content, so files that were only ever read
  // stay out of this map.
  const contents = useMemo(() => {
    const m = new Map<string, string>()
    for (const s of trace.steps) {
      for (const tc of s.toolCalls) {
        const p = callPath(tc)
        if (!p) continue
        const b = callBody(tc)
        if (tc.name === 'Write' && b.content != null) {
          m.set(p, b.content)
        } else if ((tc.name === 'Edit' || tc.name === 'MultiEdit') && b.old && b.new) {
          const cur = m.get(p) ?? ''
          if (b.new !== b.old) m.set(p, cur.split(b.old).join(b.new))
        }
      }
    }
    return m
  }, [trace.steps])

  // A rebuild stands on real content only when the session wrote the file.
  // Edits alone never materialise a base, so those files take the note below.
  const written = useMemo(() => {
    const w = new Set<string>()
    for (const s of trace.steps) {
      for (const tc of s.toolCalls) {
        const p = callPath(tc)
        if (p && tc.name === 'Write' && callBody(tc).content != null) w.add(p)
      }
    }
    return w
  }, [trace.steps])

  const files = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const all = Array.from(new Set([...trace.files, ...contents.keys()])).sort()
    return needle ? all.filter((f) => f.toLowerCase().includes(needle)) : all
  }, [trace.files, contents, q])

  return (
    <div className="split">
      <div className="pane bordered" style={{ padding: 12 }}>
        <input
          className="input"
          style={{ marginBottom: 10, fontSize: 12.5 }}
          placeholder={t('Filter files')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="tiny faint" style={{ marginBottom: 6 }}>
          {files.length === 1 ? t('{n} file touched', { n: files.length }) : t('{n} files touched', { n: files.length })}
        </div>
        <div className="file-tree">
          {files.map((f) => (
            <div
              key={f}
              className={'file-node' + (pick === f ? ' active' : '')}
              onClick={() => setPick(f)}
              title={f}
            >
              <Icon name="file" size={12} />
              <span className="truncate">{splitPath(f).slice(-2).join('/')}</span>
            </div>
          ))}
        </div>
        {files.length === 0 && (
          <div className="tiny faint">{t('no files were touched in this session')}</div>
        )}
      </div>
      <div className="pane" style={{ padding: 16 }}>
        {pick ? (
          <>
            <div className="row" style={{ marginBottom: 10, gap: 8 }}>
              <span className="mono small dim truncate grow">{pick}</span>
              <CopyBtn text={contents.get(pick) ?? ''} label={t('Copy file')} />
            </div>
            {written.has(pick) ? (
              <pre className="code">{contents.get(pick) || t('(empty file)')}</pre>
            ) : (
              <div className="faint small">
                {t('This file was read but never written, so its contents are not in the transcript.')}
              </div>
            )}
          </>
        ) : (
          <Empty
            title={t('Pick a file')}
            hint={t('The pane shows the file as the agent left it, rebuilt from every edit in the session.')}
          />
        )}
      </div>
    </div>
  )
}

function TurnsPanel({ turns, onJump }: { turns: TurnRow[]; onJump: (i: number) => void }) {
  const t = useT()
  const [open, setOpen] = useState<string | null>(turns.length ? turns[0].id : null)
  const [onlyBad, setOnlyBad] = useState(false)
  const shown = useMemo(
    () => turns.filter((turn) => !onlyBad || turn.nErrors > 0 || turn.nInterrupts > 0),
    [turns, onlyBad],
  )
  return (
    <div className="detail">
      <div className="row wrap" style={{ marginBottom: 12, gap: 8 }}>
        <button
          className={'chip' + (onlyBad ? ' on' : '')}
          onClick={() => setOnlyBad((v) => !v)}
        >
          {t('turns with errors')}
        </button>
        <span className="tiny faint">
          {turns.length === 1 ? t('{n} turn', { n: turns.length }) : t('{n} turns', { n: turns.length })}
        </span>
        <div className="grow" />
        <span className="tiny faint">{t('These digests are exactly what the annotator sees.')}</span>
      </div>
      {shown.map((turn) => (
        <details
          key={turn.id}
          className="tool-call"
          open={open === turn.id}
          onToggle={(e) => {
            if ((e.currentTarget as HTMLDetailsElement).open) setOpen(turn.id)
          }}
        >
          <summary>
            <span className="mono tiny faint">t{turn.index}</span>
            <span className="grow truncate" style={{ fontWeight: 550 }}>
              {turn.title || turn.userRequest.slice(0, 70)}
            </span>
            {turn.nErrors > 0 && <Badge kind="bad">{t('{n} err', { n: turn.nErrors })}</Badge>}
            {turn.nInterrupts > 0 && <Badge kind="violet">{t('{n} intr', { n: turn.nInterrupts })}</Badge>}
            <Badge kind="info">{t('{n} tools', { n: turn.nTools })}</Badge>
            <span className="tiny faint mono">{t('{n} ch', { n: fmtCompact(turn.nAsstChars) })}</span>
          </summary>
          <div className="body">
            <div className="row" style={{ marginBottom: 8, gap: 8 }}>
              <button className="btn sm" onClick={() => onJump(turn.startStep)}>
                {t('jump to step {n}', { n: turn.startStep })}
              </button>
              <div className="grow" />
              <CopyBtn text={turn.digest} label={t('Copy digest')} />
            </div>
            <pre className="code wrap" style={{ maxHeight: 520 }}>{turn.digest}</pre>
          </div>
        </details>
      ))}
      {shown.length === 0 && (
        <Empty title={t('No turns')} hint={t('This transcript has no human messages to segment on.')} />
      )}
    </div>
  )
}

export default function Trace({ onAsk }: { onAsk?: (text: string) => void }) {
  const t = useT()
  const { trace, traceLoading } = useApp()
  const [active, setActive] = useState(0)
  const [tab, setTab] = useState<Tab>('step')
  const [filter, setFilter] = useState<Filter>({ q: '', only: 'all' })

  const steps = trace?.steps ?? []

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: steps.length }
    c.user = 0
    c.tools = 0
    c.errors = 0
    c.edits = 0
    c.thinking = 0
    for (const s of steps) {
      if (s.role === 'user' && !s.toolResults.length) c.user++
      if (s.toolCalls.length) c.tools++
      if (hasError(s)) c.errors++
      if (s.toolCalls.some((t) => isEdit(t.name))) c.edits++
      if (s.thinking) c.thinking++
    }
    return c
  }, [steps])

  // Shell history, pairing each Bash call with whatever result came back for it.
  const cmds = useMemo(() => {
    const out: { cmd: string; step: number; isError: boolean }[] = []
    for (const s of steps) {
      for (const tc of s.toolCalls) {
        const isShell = tc.name === 'Bash' || tc.name === 'bash' || tc.name === 'shell'
        if (!isShell) continue
        const b = callBody(tc)
        const r = s.toolResults.find((x) => x.toolUseId && x.toolUseId === tc.id)
        out.push({ cmd: b.cmd || tc.brief, step: s.index, isError: !!r?.isError })
      }
    }
    return out
  }, [steps])

  // Jumping to a step must also clear an active filter, or the target is invisible.
  const jump = (i: number) => {
    const clamped = Math.max(0, Math.min(steps.length - 1, i))
    setFilter((f) => (matches(steps[clamped], f) ? f : { ...f, q: '', only: 'all' }))
    setActive(clamped)
    setTab('step')
  }

  if (!trace) {
    return <Empty title={t(traceLoading ? 'Loading trace' : 'No trace open')} hint={t('Open a session from the Sessions screen.')} />
  }

  const sum = trace.summary
  const cur = steps[active]

  /** What the header hands the Analyst: the whole run, in one question. */
  const askText = () =>
    t('Read {path} and walk me through this session: what the agent did, where it failed, and what it changed.', { path: sum.path })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="jobbar" style={{ padding: '8px 14px', gap: 18 }}>
        <div className="row" style={{ gap: 18 }}>
          <MiniStat k="steps" v={String(steps.length)} />
          <MiniStat k="turns" v={String(trace.turns.length)} />
          <MiniStat k="tools" v={String(sum.nToolCalls)} />
          <MiniStat k="errors" v={String(sum.toolErrors)} tone={sum.toolErrors ? 'var(--bad)' : undefined} />
          <MiniStat k="edits" v={`${sum.editCalls - sum.editFailed}/${sum.editCalls}`} />
          <MiniStat k="interrupts" v={String(sum.interrupts)} tone={sum.interrupts ? 'var(--violet)' : undefined} />
          <MiniStat k="ctx max" v={fmtCompact(sum.maxContextTokens)} />
          <MiniStat k="duration" v={fmtDur(sum.durationSec)} />
          {sum.cost?.totalUsd != null && <MiniStat k="cost" v={'$' + sum.cost.totalUsd.toFixed(2)} />}
          {trace.badLines > 0 && <MiniStat k="bad lines" v={String(trace.badLines)} tone="var(--warn)" />}
          <div className="spacer" />
          {onAsk && (
            <button
              className="chip"
              title={t('Ask the Analyst about this session')}
              onClick={() => onAsk(askText())}
            >
              <Icon name="cpu" size={12} /> {t('Ask the Analyst')}
            </button>
          )}
        </div>
      </div>

      <div className="tabs">
        {(['step', 'workspace', 'terminal', 'turns'] as Tab[]).map((id) => (
          <button key={id} className={'tab' + (tab === id ? ' active' : '')} onClick={() => setTab(id)}>
            {id === 'step' ? t('Step detail') : id === 'terminal' ? t('Terminal ({n})', { n: cmds.length }) : id === 'turns' ? t('Turns ({n})', { n: trace.turns.length }) : t('Workspace ({n})', { n: trace.files.length })}
          </button>
        ))}
      </div>

      {tab === 'step' && (
        <div className="trace-layout" style={{ flex: 1, minHeight: 0 }}>
          <Timeline
            steps={steps}
            active={active}
            onPick={(i) => setActive(i)}
            filter={filter}
            setFilter={setFilter}
            counts={counts}
          />
          {cur ? (
            <StepDetail step={cur} onJump={jump} />
          ) : (
            <Empty title={t('Nothing selected')} />
          )}
        </div>
      )}

      {tab === 'workspace' && <WorkspacePanel trace={trace} />}
      {tab === 'terminal' && <TerminalPanel cmds={cmds} onJump={jump} />}
      {tab === 'turns' && <TurnsPanel turns={trace.turns} onJump={jump} />}
    </div>
  )
}

function MiniStat({ k, v, tone }: { k: string; v: string; tone?: string }) {
  const t = useT()
  return (
    <div>
      <div className="mono small" style={{ color: tone, fontWeight: 600 }}>{v}</div>
      <div className="tiny faint">{t(k)}</div>
    </div>
  )
}
