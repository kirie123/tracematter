// The Analyst dock: a conversation with a model that can read what the app reads.
//
// The panel owns no data path of its own. It forwards a question to the agent
// and renders the events that come back; the agent answers by calling read-only
// tools the backend implements. So this file is one reducer over one event
// stream, plus the rendering of the rows that reducer produces.
//
// The transcript is shaped like the work it describes. Prose and reasoning
// arrive as text, actions arrive as tool calls, and a turn is usually a little
// thinking wrapped around a few calls — so thinking and tool rows fold into a
// single work row that stays open while the turn runs and folds away when it
// ends. Afterwards the answer is what you read, and the process is one click
// behind it.

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  agentReset, analystSend, analystStatus, humanError,
  onAnalystEvent, onAnalystLog,
} from '../lib/api'
import { useI18n } from '../lib/i18n'
import { useApp } from '../lib/store'
import type { AgentStatus, AnalystAsk } from '../lib/types'
import { Markdown } from './Markdown'
import { fmtCompact } from '../lib/format'
import { Icon, Spinner } from './ui'

// ------------------------------------------------------------------ the rows

type ToolStatus = 'running' | 'done' | 'error'

interface Usage {
  input: number
  output: number
  cost: number
}

type Row =
  | { kind: 'user'; id: number; at: number; text: string }
  | { kind: 'assistant'; id: number; text: string; streaming: boolean; usage?: Usage; secs?: number }
  | { kind: 'thinking'; id: number; text: string; live: boolean }
  | {
      kind: 'tool'
      id: number
      callId: string
      name: string
      args: string
      status: ToolStatus
      partial: string
      result: string
      t0: number
      t1: number
    }
  | { kind: 'note'; id: number; text: string; bad: boolean }

/** A run of thinking + tool rows, rendered as one foldable row. */
interface Work {
  kind: 'work'
  id: number
  rows: Row[]
}

type Item = Row | Work

let counter = 0
const nextId = () => ++counter

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Tool results and message content are either a string or a list of parts. */
function textOf(v: unknown): string {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) {
    return v.map((p) => (p && typeof (p as any).text === 'string' ? (p as any).text : '')).join('')
  }
  if (v && typeof v === 'object' && typeof (v as any).text === 'string') return (v as any).text
  return ''
}

function argText(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

/** Patch a single row, leaving every other row reference alone. */
function patch(rows: Row[], i: number, f: (r: Row) => Row): Row[] {
  const next = rows.slice()
  next[i] = f(next[i])
  return next
}

function findLast(rows: Row[], pred: (r: Row) => boolean): number {
  for (let i = rows.length - 1; i >= 0; i--) if (pred(rows[i])) return i
  return -1
}

function findCall(rows: Row[], callId: string): number {
  return rows.findIndex((r) => r.kind === 'tool' && r.callId === callId)
}

/** The turn is over: nothing is streaming, nothing is running. */
function settle(rows: Row[], now: number): Row[] {
  return rows.map((r) => {
    if (r.kind === 'assistant' && r.streaming) return { ...r, streaming: false }
    if (r.kind === 'thinking' && r.live) return { ...r, live: false }
    if (r.kind === 'tool' && r.status === 'running') return { ...r, status: 'done', t1: r.t1 || now }
    return r
  })
}

/** One `message_update`, folded into the row it belongs to. */
function applyDelta(rows: Row[], a: any): Row[] {
  const type = a && typeof a.type === 'string' ? a.type : ''
  const isEnd = type === 'text_end' || type === 'thinking_end'
  const isText = type === 'text_delta' || type === 'text_end'
  const isThink = type === 'thinking_delta' || type === 'thinking_end'
  if (!isText && !isThink) return rows

  const body = isEnd ? textOf(a.content) : String(a.delta ?? '')
  if (!body) {
    // An empty end still closes the block it ends.
    if (!isEnd) return rows
  }

  const kind = isText ? 'assistant' : 'thinking'
  const i = findLast(rows, (r) => r.kind === kind)
  const last = i >= 0 ? rows[i] : null

  if (last && ((kind === 'assistant' && (last as any).streaming) || (kind === 'thinking' && (last as any).live))) {
    return patch(rows, i, (r) => {
      const text = (r as any).text as string
      const merged = isEnd ? (body || text) : text + body
      return kind === 'assistant'
        ? ({ ...r, text: merged, streaming: !isEnd } as Row)
        : ({ ...r, text: merged, live: !isEnd } as Row)
    })
  }

  if (!body) return rows
  return kind === 'assistant'
    ? [...rows, { kind: 'assistant', id: nextId(), text: body, streaming: !isEnd }]
    : [...rows, { kind: 'thinking', id: nextId(), text: body, live: !isEnd }]
}

/** Fold one agent event into the transcript. Pure, so a re-render cannot lie
 *  about what actually arrived. */
function applyEvent(rows: Row[], ev: any, now: number): Row[] {
  switch (ev.type) {
    case 'message_update':
      return applyDelta(rows, ev.assistantMessageEvent)

    case 'tool_execution_start': {
      const callId = String(ev.toolCallId ?? '')
      if (!callId) return rows
      const i = findCall(rows, callId)
      const name = String(ev.toolName ?? 'tool')
      const args = argText(ev.args)
      if (i >= 0) {
        return patch(rows, i, (r) => ({ ...(r as any), name, args: args || (r as any).args, status: 'running', t0: now }))
      }
      return [
        ...rows,
        { kind: 'tool', id: nextId(), callId, name, args, status: 'running', partial: '', result: '', t0: now, t1: 0 },
      ]
    }

    case 'tool_execution_update': {
      const i = findCall(rows, String(ev.toolCallId ?? ''))
      if (i < 0) return rows
      const partial = textOf(ev.partialResult ?? ev.partial ?? '')
      if (!partial) return rows
      return patch(rows, i, (r) => ({ ...(r as any), partial }))
    }

    case 'tool_execution_end': {
      const i = findCall(rows, String(ev.toolCallId ?? ''))
      if (i < 0) return rows
      const result = textOf(ev.result) || (ev.result ? argText(ev.result) : '')
      const status: ToolStatus = ev.isError ? 'error' : 'done'
      return patch(rows, i, (r) => ({ ...(r as any), result: result || (r as any).result, status, t1: now }))
    }

    case 'turn_end': {
      const u = ev.message?.usage
      const usage: Usage | undefined =
        u && typeof u === 'object'
          ? { input: num(u.input) + num(u.cacheRead), output: num(u.output), cost: num(u.cost?.total) }
          : undefined
      const uAt = findLast(rows, (r) => r.kind === 'user')
      const secs = uAt >= 0 ? Math.max(0, (now - (rows[uAt] as any).at) / 1000) : undefined
      const i = findLast(rows, (r) => r.kind === 'assistant')

      let next = rows
      if (i >= 0) {
        next = patch(rows, i, (r) => ({
          ...(r as any),
          streaming: false,
          usage: usage ?? (r as any).usage,
          secs: secs ?? (r as any).secs,
        }))
      }
      return next.map((r) => {
        if (r.kind === 'thinking' && r.live) return { ...r, live: false }
        if (r.kind === 'assistant' && r.streaming) return { ...r, streaming: false }
        return r
      })
    }

    case 'agent_end':
    case 'agent_settled':
      return settle(rows, now)

    // A failure the run wants the reader to see. Without this case an error
    // from the backend arrived and vanished, leaving the panel looking idle.
    case 'note':
      return [
        ...rows,
        { kind: 'note', id: nextId(), text: String(ev.text ?? ''), bad: !!ev.bad },
      ]

    default:
      return rows
  }
}

/** Fold runs of thinking + tool rows into one work row. A lone thinking row is
 *  left alone: a header for a single line of prose is noise. */
function groupRows(rows: Row[]): Item[] {
  const out: Item[] = []
  let buf: Row[] = []
  const flush = () => {
    if (!buf.length) return
    if (buf.length === 1 && buf[0].kind === 'thinking') out.push(buf[0])
    else out.push({ kind: 'work', id: buf[0].id, rows: buf })
    buf = []
  }
  for (const r of rows) {
    if (r.kind === 'thinking' || r.kind === 'tool') buf.push(r)
    else {
      flush()
      out.push(r)
    }
  }
  flush()
  return out
}

// --------------------------------------------------------------- formatting

function dur(ms: number): string {
  if (ms < 1000) return Math.max(1, Math.round(ms)) + 'ms'
  const s = ms / 1000
  if (s < 10) return s.toFixed(1) + 's'
  if (s < 60) return Math.round(s) + 's'
  return Math.floor(s / 60) + 'm' + String(Math.round(s % 60)).padStart(2, '0')
}

function count(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'k'
  return (n / 1_000_000).toFixed(1) + 'M'
}

/** The one argument worth showing next to a tool name. */
const LABEL_KEYS = ['path', 'file', 'sessionId', 'session', 'query', 'q', 'pattern', 'id', 'name']

function rowLabel(args: string): string {
  let obj: Record<string, unknown> | null = null
  try {
    const parsed = JSON.parse(args)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>
  } catch {
    /* arguments are not always json */
  }
  if (obj) {
    for (const k of LABEL_KEYS) {
      const v = obj[k]
      if (typeof v === 'string' && v) return v
    }
    for (const v of Object.values(obj)) if (typeof v === 'string' && v) return v
    if (!Object.keys(obj).length) return ''
  }
  return (args || '').split('\n')[0].slice(0, 90)
}

/** Trim an argument blob to the lines a reader can use. */
function argPreview(args: string): string {
  if (!args) return ''
  try {
    const parsed = JSON.parse(args)
    const flat = JSON.stringify(parsed)
    return flat.length > 160 ? flat.slice(0, 160) + '…' : flat
  } catch {
    return args.length > 160 ? args.slice(0, 160) + '…' : args
  }
}

// ------------------------------------------------------------------- pieces

const HEAD_LINES = 14
const TAIL_LINES = 6

function ToolOutput({ text, bad, live }: { text: string; bad: boolean; live: boolean }) {
  const { t } = useI18n()
  const [all, setAll] = useState(false)
  const lines = text.split('\n')
  const cut = lines.length > HEAD_LINES + TAIL_LINES + 4
  const shown =
    !cut || all
      ? lines
      : [
          ...lines.slice(0, HEAD_LINES),
          '',
          '… ' + t('{n} lines folded', { n: lines.length - HEAD_LINES - TAIL_LINES }) + ' …',
          '',
          ...lines.slice(-TAIL_LINES),
        ]
  const ref = useRef<HTMLPreElement | null>(null)

  // A running command keeps its newest line in view.
  useEffect(() => {
    const el = ref.current
    if (el && live) el.parentElement?.scrollTo({ top: el.parentElement.scrollHeight })
  }, [text, live])

  return (
    <div className={'tool-out' + (bad ? ' bad' : '')}>
      <pre ref={ref}>{shown.join('\n')}</pre>
      {cut && (
        <button className="dock-chip" onClick={() => setAll((v) => !v)}>
          {all ? t('Show less') : t('Show all {n} lines', { n: lines.length })}
        </button>
      )}
    </div>
  )
}

function ToolRow({ row }: { row: Extract<Row, { kind: 'tool' }> }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const live = row.status === 'running'
  const label = rowLabel(row.args)
  const out = row.result || row.partial
  const ms = (row.t1 || Date.now()) - row.t0

  return (
    <div className={'tool' + (row.status === 'error' ? ' bad' : '') + (live ? ' live' : '')}>
      <button className="tool-head" onClick={() => setOpen((v) => !v)}>
        <span className="tool-mark">
          {live ? <Spinner size={11} /> : <Icon name={row.status === 'error' ? 'x' : 'check'} size={11} />}
        </span>
        <span className="tool-name mono">{row.name}</span>
        {label && <span className="tool-label mono truncate">{label}</span>}
        <span className="spacer" />
        {!live && <span className="tiny faint mono">{dur(ms)}</span>}
        <Icon name="chevron" size={11} className={'chev' + (open ? ' open' : '')} />
      </button>
      {open && (
        <div className="tool-body">
          {row.args && (
            <>
              <div className="tool-cap microlabel">{t('Arguments')}</div>
              <pre className="tool-args mono">{row.args.length > 2000 ? argPreview(row.args) : row.args}</pre>
            </>
          )}
          <div className="tool-cap microlabel">{t('Output')}</div>
          {out ? (
            <ToolOutput text={out} bad={row.status === 'error'} live={live} />
          ) : (
            <div className="tiny faint">{live ? t('running…') : t('No output')}</div>
          )}
        </div>
      )}
    </div>
  )
}

function ThinkRow({ row }: { row: Extract<Row, { kind: 'thinking' }> }) {
  const { t } = useI18n()
  // Same rule as a work group: open while the model is still thinking, folded
  // once the turn ends, unless the reader opened or closed it by hand.
  const [touched, setTouched] = useState<boolean | null>(null)
  const open = touched ?? row.live

  return (
    <div className={'think' + (row.live ? ' live' : '')}>
      <button className="think-head" onClick={() => setTouched(!open)}>
        <Icon name="chevron" size={11} className={'chev' + (open ? ' open' : '')} />
        <span className="think-title">{t('Thought ({n} chars)', { n: row.text.length })}</span>
        {row.live && <Spinner size={11} />}
      </button>
      {open && (
        <div className="think-body">
          <Markdown text={row.text} />
        </div>
      )}
    </div>
  )
}

function WorkRow({ item, open, onToggle }: { item: Work; open: boolean; onToggle: () => void }) {
  const { t } = useI18n()
  const tools = item.rows.filter((r) => r.kind === 'tool') as Extract<Row, { kind: 'tool' }>[]
  const thinking = item.rows.some((r) => r.kind === 'thinking')
  const live = tools.some((r) => r.status === 'running') || item.rows.some((r) => r.kind === 'thinking' && r.live)

  const names: string[] = []
  for (const r of tools) if (!names.includes(r.name)) names.push(r.name)
  const chips = names.slice(0, 3)
  const more = names.length - chips.length

  const title = live
    ? tools.length
      ? t('Working · step {n}', { n: tools.length })
      : t('Thinking…')
    : thinking
      ? t('Thought and ran {n} steps', { n: item.rows.length })
      : t('Ran {n} tools', { n: tools.length })

  const last = item.rows[item.rows.length - 1]
  const preview =
    last && last.kind === 'tool'
      ? last.name + (rowLabel(last.args) ? ' ' + rowLabel(last.args) : '')
      : ''

  return (
    <div className={'work' + (live ? ' live' : '')}>
      <button className="work-head" onClick={onToggle}>
        <span className={'work-mark' + (live ? ' live' : '')}>
          {live ? <Spinner size={11} /> : <Icon name="check" size={11} />}
        </span>
        <span className="work-title">{title}</span>
        {chips.map((n) => (
          <span key={n} className="work-chip mono">
            {n}
          </span>
        ))}
        {more > 0 && <span className="work-chip mono">+{more}</span>}
        <span className="spacer" />
        <Icon name="chevron" size={11} className={'chev' + (open ? ' open' : '')} />
      </button>
      {!open && preview && <div className="work-last mono truncate">{preview}</div>}
      {open && (
        <div className="work-body">
          {item.rows.map((r) =>
            r.kind === 'tool' ? (
              <ToolRow key={r.id} row={r} />
            ) : r.kind === 'thinking' ? (
              <ThinkRow key={r.id} row={r} />
            ) : null,
          )}
        </div>
      )}
    </div>
  )
}

function UsageLine({ u, secs }: { u?: Usage; secs?: number }) {
  const { t } = useI18n()
  const bits: string[] = []
  if (u) bits.push(t('{n} in', { n: count(u.input) }), t('{n} out', { n: count(u.output) }))
  if (u && u.cost > 0) bits.push('$' + (u.cost < 0.01 ? u.cost.toFixed(4) : u.cost.toFixed(3)))
  if (secs) bits.push(dur(secs * 1000))
  if (!bits.length) return null
  return <div className="msg-meta mono tiny faint">{bits.join('  ·  ')}</div>
}

// ------------------------------------------------------------------- the dock

const WIDTH_KEY = 'tracematter.dock'
const MIN_W = 340
const MAX_W = 780

function initialWidth(): number {
  try {
    const v = Number(window.localStorage.getItem(WIDTH_KEY))
    if (v >= MIN_W && v <= MAX_W) return v
  } catch {
    /* storage may be unavailable */
  }
  return 470
}

const EXAMPLES = [
  'Which sessions failed, and why?',
  'Summarise the slowest session.',
  'Where does this trace spend its time?',
]

export default function Analyst({
  onClose,
  ask,
  onAskHandled,
}: {
  onClose: () => void
  /** A question another view handed over, if any. */
  ask?: AnalystAsk | null
  onAskHandled?: () => void
}) {
  const { t } = useI18n()
  const { activeProject } = useApp()
  const [status, setStatus] = useState<AgentStatus | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [showLog, setShowLog] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const [folds, setFolds] = useState<Record<number, boolean>>({})
  const [width, setWidth] = useState(initialWidth)
  const [jump, setJump] = useState(false)

  const scroller = useRef<HTMLDivElement | null>(null)
  const input = useRef<HTMLTextAreaElement | null>(null)
  const grip = useRef(false)
  const stick = useRef(true)
  const wantFocus = useRef(false)

  const refresh = useCallback(() => {
    analystStatus().then(setStatus).catch((e) => setErr(humanError(e)))
  }, [])

  useEffect(() => {
    let live = true
    const offs: (() => void)[] = []

    onAnalystEvent((payload) => {
      // Tauri delivers a JSON object as an object. A listener that parsed
      // unconditionally would throw here and — because the catch returns —
      // swallow every event of the turn, which reads as "sending does nothing".
      const ev: any =
        typeof payload === 'string'
          ? (() => {
              try {
                return JSON.parse(payload)
              } catch {
                return null
              }
            })()
          : payload
      if (!ev || typeof ev !== 'object') return
      const now = Date.now()
      setRows((r) => applyEvent(r, ev, now))
      if (ev.type === 'agent_start') setBusy(true)
      if (ev.type === 'agent_settled' || ev.type === 'agent_end') {
        setBusy(false)
        analystStatus().then(setStatus).catch(() => undefined)
      }
    }).then((u) => (live ? offs.push(u) : u()))

    onAnalystLog((line) => setLog((l) => [...l.slice(-200), line])).then((u) =>
      live ? offs.push(u) : u(),
    )

    analystStatus().then(setStatus).catch((e) => setErr(humanError(e)))
    return () => {
      live = false
      offs.forEach((f) => f())
    }
  }, [])

  // Newest row stays in view, the way a terminal does it — but only while the
  // reader is already at the bottom. Scrolling up is a request to stay there.
  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [rows, busy])

  // The composer grows with the question, up to a point.
  useEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(132, el.scrollHeight) + 'px'
  }, [draft])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    const far = el.scrollHeight - el.scrollTop - el.clientHeight
    stick.current = far < 60
    setJump(far > 140)
  }

  const toBottom = () => {
    const el = scroller.current
    if (!el) return
    stick.current = true
    setJump(false)
    el.scrollTop = el.scrollHeight
  }

  /** Start over: drop the conversation so the next question is a fresh context. */
  const reset = async () => {
    try {
      await agentReset()
      setRows([])
      setFolds({})
      refresh()
    } catch (e) {
      setErr(humanError(e))
    }
  }

  const send = async () => {
    const text = draft.trim()
    if (!text || !status?.ready || busy) return
    setDraft('')
    setErr(null)
    setBusy(true)
    stick.current = true
    setRows((r) => [...r, { kind: 'user', id: nextId(), at: Date.now(), text }])
    try {
      await analystSend('default', text)
    } catch (e) {
      setErr(humanError(e))
      setBusy(false)
    }
  }

  // ---- a question handed over from another view

  /** Put a question in the composer, and see that there is something to answer it. */
  const handoff = (text: string) => {
    setDraft(text)
    wantFocus.current = true
    input.current?.focus()
  }

  // Clicking "ask about this" in another view should land somewhere useful:
  // the question in the composer, the kernel warming up behind it.
  useEffect(() => {
    if (!ask) return
    handoff(ask.text)
    onAskHandled?.()
  }, [ask])

  // The composer is only unusable before the status arrives; once it does, a
  // handoff from another view takes the caret.
  useEffect(() => {
    if (!wantFocus.current || !status) return
    wantFocus.current = false
    input.current?.focus()
  }, [status])

  // ---- drag the left edge to size the panel
  const onGripDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    grip.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
    document.body.classList.add('col-resize')
  }
  const onGripMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!grip.current) return
    setWidth(Math.max(MIN_W, Math.min(MAX_W, window.innerWidth - e.clientX)))
  }
  const onGripUp = () => {
    if (!grip.current) return
    grip.current = false
    document.body.classList.remove('col-resize')
    try {
      window.localStorage.setItem(WIDTH_KEY, String(width))
    } catch {
      /* ignore */
    }
  }

  /** Ready means a gateway is configured. There is no process to start. */
  const running = !!status?.ready
  const items = useMemo(() => groupRows(rows), [rows])
  const tail = rows[rows.length - 1]
  const quiet =
    !tail ||
    !(
      (tail.kind === 'assistant' && tail.streaming) ||
      (tail.kind === 'thinking' && tail.live) ||
      (tail.kind === 'tool' && tail.status === 'running')
    )
  const missing = status && !status.ready
    ? t('No gateway is configured. Set its base URL under Settings.')
    : null

  return (
    <aside className="dock" style={{ width }}>
      <div
        className="dock-grip"
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripUp}
        onPointerCancel={onGripUp}
        title={t('Drag to resize')}
      />
      <header className="dock-head">
        <span className="dock-title">
          <Icon name="cpu" size={13} /> {t('Analyst')}
        </span>
        <span className={'dot' + (busy ? ' live' : '')} />
        <span className="tiny mono truncate">
          {running ? status?.model : t('no gateway')}
          {status && status.spendTokens > 0 ? ` · ${fmtCompact(status.spendTokens)} tok` : ''}
        </span>
        <div className="spacer" />
        <button className="dock-ico" onClick={refresh} title={t('Refresh the status')}>
          <Icon name="refresh" size={12} />
        </button>
        <button
          className="dock-ico"
          onClick={() => void reset()}
          disabled={!rows.length || busy}
          title={t('Start a fresh conversation')}
        >
          <Icon name="x" size={12} />
        </button>
        <button className="dock-ico" onClick={onClose} title={t('Close the panel')}>
          <Icon name="chevron" size={12} className="flip-x" />
        </button>
      </header>

      {missing && <div className="dock-warn">{missing}</div>}
      {err && (
        <div className="dock-warn bad">
          <Icon name="alert" size={12} />
          <span className="mono tiny">{err}</span>
        </div>
      )}

      <div className="chat-wrap">
        <div className="chat" ref={scroller} onScroll={onScroll}>
          <div className="chat-in">
            {!rows.length && (
              <div className="chat-empty">
                <p className="lede">
                  {activeProject
                    ? t('Ask about the transcripts in {name}. The Analyst reads what the app reads, nothing more.', { name: activeProject.name })
                    : t('Ask about the transcripts in the active folder. The Analyst reads what the app reads, nothing more.')}
                </p>
                <p className="tiny faint">
                  {t('It can list sessions, read one trace, and search across them. It cannot write.')}
                </p>
                <div className="chat-examples">
                  {EXAMPLES.map((q) => (
                    <button
                      key={q}
                      className="dock-chip"
                      onClick={() => handoff(t(q))}
                    >
                      {t(q)}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {items.map((item) => {
              if (item.kind === 'work') {
                const live = item.rows.some((r) =>
                  r.kind === 'tool' ? r.status === 'running' : r.kind === 'thinking' ? r.live : false,
                )
                const open = folds[item.id] ?? live
                return (
                  <WorkRow
                    key={'w' + item.id}
                    item={item}
                    open={open}
                    onToggle={() => setFolds((f) => ({ ...f, [item.id]: !open }))}
                  />
                )
              }
              if (item.kind === 'user') {
                return (
                  <div className="msg-user" key={item.id}>
                    <div className="bubble">{item.text}</div>
                  </div>
                )
              }
              if (item.kind === 'thinking') return <ThinkRow key={item.id} row={item} />
              if (item.kind === 'tool') return <ToolRow key={item.id} row={item} />
              if (item.kind === 'assistant') {
                return (
                  <div className={'msg-ai' + (item.streaming ? ' streaming' : '')} key={item.id}>
                    <Markdown text={item.text} />
                    {(item.usage || item.secs) && <UsageLine u={item.usage} secs={item.secs} />}
                  </div>
                )
              }
              return (
                <div className={'note' + (item.bad ? ' bad' : '')} key={item.id}>
                  {t(item.text)}
                </div>
              )
            })}

            {busy && quiet && (
              <div className="chat-typing">
                <span className="dots">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="tiny faint">{t('working')}</span>
              </div>
            )}
          </div>
        </div>
        {jump && (
          <button className="chat-jump" onClick={toBottom} title={t('Jump to the newest')}>
            <Icon name="chevron" size={13} className="down" />
          </button>
        )}
      </div>

      {showLog && (
        <div className="dock-log">
          {log.length ? (
            log.map((line, i) => <div key={i}>{line}</div>)
          ) : (
            <div className="faint">{t('empty')}</div>
          )}
        </div>
      )}

      <div className="composer">
        <textarea
          ref={input}
          className="composer-in"
          rows={1}
          value={draft}
          spellCheck={false}
          disabled={!running || busy}
          placeholder={running ? t('Ask about this data…') : t('Set a gateway in Settings to ask something.')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; the IME owns Enter while a candidate window is open.
            if (e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent as any).isComposing) {
              e.preventDefault()
              void send()
            }
            // Escape drops a half-written question before it closes the panel,
            // the way a search field does. The window handler skips fields, so
            // this is the only place a key press closes it from the inside.
            if (e.key === 'Escape' && !(e.nativeEvent as any).isComposing) {
              e.preventDefault()
              if (draft) setDraft('')
              else onClose()
            }
          }}
        />
        <div className="composer-bar">
          <button className="dock-chip" onClick={() => setShowLog((v) => !v)}>
            {showLog ? t('Hide log') : t('Show log')}
          </button>
          <span className="tiny faint truncate">
            {running ? t('Enter to send · Shift+Enter for a new line') : t('No gateway is configured.')}
          </span>
          <div className="spacer" />
          <button
            className="send"
            disabled={!running || busy || !draft.trim()}
            onClick={() => void send()}
            title={t('Send')}
          >
            {busy ? <Spinner size={13} /> : <Icon name="arrow-left" size={13} className="flip-x" />}
          </button>
        </div>
      </div>
    </aside>
  )
}