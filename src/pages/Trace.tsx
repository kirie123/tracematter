
import { useMemo, useState } from 'react'
import { Badge, CopyBtn, DiffView, Empty, Icon, Section, diffLines } from '../components/ui'
import { fmtClock, fmtCompact, fmtDur, splitPath } from '../lib/format'
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
    return s.toolCalls.map((t) => t.name + ' ' + t.brief).join(' | ').slice(0, 400)
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
      stepSnippet(s) + ' ' + s.toolCalls.map((t) => t.name + ' ' + t.brief).join(' ')
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
  const shown = useMemo(
    () => steps.map((s, i) => ({ s, i })).filter(({ s }) => matches(s, filter)),
    [steps, filter],
  )
  return (
    <div className="timeline">
      <div className="row" style={{ gap: 6, marginBottom: 8 }}>
        <input
          className="input"
          style={{ fontSize: 12.5 }}
          placeholder="Search steps"
          value={filter.q}
          onChange={(e) => setFilter({ ...filter, q: e.target.value })}
        />
      </div>
      <div className="tl-filters">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            className={'chip' + (filter.only === f.id ? ' on' : '')}
            onClick={() => setFilter({ ...filter, only: f.id })}
          >
            {f.label}
            {counts[f.id] ? <span className="faint"> {counts[f.id]}</span> : null}
          </button>
        ))}
      </div>
      <div className="tiny faint" style={{ padding: '0 2px 8px' }}>{shown.length} steps</div>
      {shown.map(({ s, i }) => {
        const err = hasError(s)
        return (
          <div
            key={s.index}
            className={
              'tl-step' +
              (i === active ? ' active' : '') +
              (err ? ' err' : '') +
              (s.role === 'user' && !s.toolResults.length ? ' user' : '')
            }
            onClick={() => onPick(i)}
          >
            <div className="tl-head">
              <span className="tl-idx">#{s.index}</span>
              <span className={'tl-role ' + s.role}>{stepLabel(s)}</span>
              {s.tSec != null && <span className="tiny faint mono" style={{ marginLeft: 'auto' }}>{fmtClock(s.tSec)}</span>}
            </div>
            <div className="tl-text">{stepSnippet(s) || <span className="faint">(no content)</span>}</div>
            <div className="tl-meta">
              {s.toolCalls.length > 0 && (
                <Badge kind="info">
                  {s.toolCalls.length} tool{s.toolCalls.length > 1 ? 's' : ''}
                </Badge>
              )}
              {err && <Badge kind="bad">error</Badge>}
              {s.thinking && <Badge kind="violet">reasoning</Badge>}
              {s.isSidechain && <Badge>subagent</Badge>}
              {s.usage && s.usage.contextTokens > 0 && (
                <span className="tiny faint mono">{fmtCompact(s.usage.contextTokens)} ctx</span>
              )}
            </div>
          </div>
        )
      })}
      {shown.length === 0 && <div className="empty" style={{ height: 160 }}>nothing matches this filter</div>}
    </div>
  )
}

function ToolCallCard({ tc, result, defaultOpen }: {
  tc: ToolCall
  result?: { isError: boolean; content: string; truncated: boolean }
  defaultOpen?: boolean
}) {
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

  return (
    <details className="tool-call" open={defaultOpen}>
      <summary>
        <span className="tool-name">{tc.name}</span>
        {path && <span className="tiny faint mono truncate">{splitPath(path).slice(-2).join('/')}</span>}
        {!diff && <span className="tiny faint truncate grow">{tc.brief}</span>}
        <span className="grow" />
        {result?.isError && <Badge kind="bad">failed</Badge>}
        {result && !result.isError && <Badge kind="ok">ok</Badge>}
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
        ) : (
          <pre className="code wrap">{argText}</pre>
        )}
        {result && (
          <div className={'result' + (result.isError ? ' err' : '')} style={{ marginTop: 10 }}>
            <div className="row" style={{ marginBottom: 5, gap: 8 }}>
              <span className="tiny" style={{ fontWeight: 650 }}>RESULT</span>
              {result.truncated && <span className="tiny faint">(truncated)</span>}
              <div className="grow" />
              <CopyBtn text={result.content} />
            </div>
            <pre className="code wrap" style={{ maxHeight: 300 }}>{result.content || '(empty)'}</pre>
          </div>
        )}
      </div>
    </details>
  )
}

function StepDetail({ step, onJump }: { step: Step; onJump: (i: number) => void }) {
  const results = new Map(step.toolResults.map((r) => [r.toolUseId || '', r]))
  return (
    <div className="detail">
      <div className="detail-head">
        <Badge kind={step.role === 'user' ? 'violet' : 'info'}>{stepLabel(step)}</Badge>
        <span className="mono small dim">step #{step.index}</span>
        {step.tSec != null && (
          <span className="small faint row" style={{ gap: 4 }}>
            <Icon name="clock" size={12} /> {fmtClock(step.tSec)}
          </span>
        )}
        {step.isSidechain && <Badge>subagent</Badge>}
        <div className="grow" />
        <button className="btn ghost sm" disabled={step.index <= 0} onClick={() => onJump(step.index - 1)}>prev</button>
        <button className="btn ghost sm" onClick={() => onJump(step.index + 1)}>next</button>
      </div>

      {step.note && (
        <div className="result" style={{ borderLeftColor: 'var(--violet)' }}>
          <pre className="code wrap" style={{ background: 'none', border: 0, padding: 0 }}>{step.note}</pre>
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
        <Section label="reasoning" right={<CopyBtn text={step.thinking} />}>
          <pre className="code wrap" style={{ maxHeight: 420 }}>{step.thinking}</pre>
        </Section>
      )}

      {step.text && (
        <Section label="message" right={<CopyBtn text={step.text} />}>
          <pre className="code wrap">{step.text}</pre>
        </Section>
      )}

      {step.toolCalls.length > 0 && (
        <Section label={'tool calls (' + step.toolCalls.length + ')'}>
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
        <Section label={'tool results (' + step.toolResults.length + ')'}>
          {step.toolResults.map((r, k) => (
            <div key={k} className={'result' + (r.isError ? ' err' : '')}>
              <div className="row" style={{ marginBottom: 5 }}>
                <span className="tiny" style={{ fontWeight: 650 }}>{r.isError ? 'ERROR' : 'OK'}</span>
                <div className="grow" />
                <CopyBtn text={r.content} />
              </div>
              <pre className="code wrap" style={{ maxHeight: 320 }}>{r.content || '(empty)'}</pre>
            </div>
          ))}
        </Section>
      )}
    </div>
  )
}

function Stat2({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div className="mono small">{v}</div>
      <div className="tiny faint">{k}</div>
    </div>
  )
}

function TerminalPanel({ cmds, onJump }: { cmds: { cmd: string; step: number; isError: boolean }[]; onJump: (i: number) => void }) {
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
          placeholder="Filter shell commands"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button className={'chip' + (onlyErr ? ' on' : '')} onClick={() => setOnlyErr((v) => !v)}>failed only</button>
        <span className="tiny faint">{cmds.length} commands, {distinct} distinct</span>
      </div>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 52 }}>Step</th>
              <th>Command</th>
              <th style={{ width: 70 }} className="right">Result</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((c, k) => (
              <tr key={k} onClick={() => onJump(c.step)} style={{ cursor: 'pointer' }}>
                <td className="mono tiny faint">#{c.step}</td>
                <td className="mono" style={{ wordBreak: 'break-word' }}>{c.cmd}</td>
                <td className="right">
                  {c.isError ? <Badge kind="bad">fail</Badge> : <Badge kind="ok">ok</Badge>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && <Empty title="No shell commands" hint="This session never ran a shell tool." />}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------- page

function WorkspacePanel({ trace }: { trace: { files: string[]; steps: Step[] } }) {
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
          placeholder="Filter files"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="tiny faint" style={{ marginBottom: 6 }}>{files.length} files touched</div>
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
          <div className="tiny faint">no files were touched in this session</div>
        )}
      </div>
      <div className="pane" style={{ padding: 16 }}>
        {pick ? (
          <>
            <div className="row" style={{ marginBottom: 10, gap: 8 }}>
              <span className="mono small dim truncate grow">{pick}</span>
              <CopyBtn text={contents.get(pick) ?? ''} label="Copy file" />
            </div>
            {contents.has(pick) ? (
              <pre className="code">{contents.get(pick) || '(empty file)'}</pre>
            ) : (
              <div className="faint small">
                This file was read but never written, so its contents are not in the transcript.
              </div>
            )}
          </>
        ) : (
          <Empty
            title="Pick a file"
            hint="The pane shows the file as the agent left it, rebuilt from every edit in the session."
          />
        )}
      </div>
    </div>
  )
}

function TurnsPanel({ turns, onJump }: { turns: TurnRow[]; onJump: (i: number) => void }) {
  const [open, setOpen] = useState<string | null>(turns.length ? turns[0].id : null)
  const [onlyBad, setOnlyBad] = useState(false)
  const shown = useMemo(
    () => turns.filter((t) => !onlyBad || t.nErrors > 0 || t.nInterrupts > 0),
    [turns, onlyBad],
  )
  return (
    <div className="detail">
      <div className="row wrap" style={{ marginBottom: 12, gap: 8 }}>
        <button
          className={'chip' + (onlyBad ? ' on' : '')}
          onClick={() => setOnlyBad((v) => !v)}
        >
          turns with errors
        </button>
        <span className="tiny faint">{turns.length} turns</span>
        <div className="grow" />
        <span className="tiny faint">These digests are exactly what the annotator sees.</span>
      </div>
      {shown.map((t) => (
        <details
          key={t.id}
          className="tool-call"
          open={open === t.id}
          onToggle={(e) => {
            if ((e.currentTarget as HTMLDetailsElement).open) setOpen(t.id)
          }}
        >
          <summary>
            <span className="mono tiny faint">t{t.index}</span>
            <span className="grow truncate" style={{ fontWeight: 550 }}>
              {t.title || t.userRequest.slice(0, 70)}
            </span>
            {t.nErrors > 0 && <Badge kind="bad">{t.nErrors} err</Badge>}
            {t.nInterrupts > 0 && <Badge kind="violet">{t.nInterrupts} intr</Badge>}
            <Badge kind="info">{t.nTools} tools</Badge>
            <span className="tiny faint mono">{fmtCompact(t.nAsstChars)} ch</span>
          </summary>
          <div className="body">
            <div className="row" style={{ marginBottom: 8, gap: 8 }}>
              <button className="btn sm" onClick={() => onJump(t.startStep)}>
                jump to step {t.startStep}
              </button>
              <div className="grow" />
              <CopyBtn text={t.digest} label="Copy digest" />
            </div>
            <pre className="code wrap" style={{ maxHeight: 520 }}>{t.digest}</pre>
          </div>
        </details>
      ))}
      {shown.length === 0 && (
        <Empty title="No turns" hint="This transcript has no human messages to segment on." />
      )}
    </div>
  )
}

export default function Trace() {
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
    return <Empty title={traceLoading ? 'Loading trace' : 'No trace open'} hint="Open a session from the Sessions screen." />
  }

  const sum = trace.summary
  const cur = steps[active]

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
        </div>
      </div>

      <div className="tabs">
        {(['step', 'workspace', 'terminal', 'turns'] as Tab[]).map((t) => (
          <button key={t} className={'tab' + (tab === t ? ' active' : '')} onClick={() => setTab(t)}>
            {t === 'step' ? 'Step detail' : t === 'terminal' ? 'Terminal (' + cmds.length + ')' : t === 'turns' ? 'Turns (' + trace.turns.length + ')' : 'Workspace (' + trace.files.length + ')'}
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
            <Empty title="Nothing selected" />
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
  return (
    <div>
      <div className="mono small" style={{ color: tone, fontWeight: 600 }}>{v}</div>
      <div className="tiny faint">{k}</div>
    </div>
  )
}
