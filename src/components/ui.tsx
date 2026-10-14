// Shared primitives. Small on purpose: this app is mostly tables and panes, so
// the vocabulary needs to be tiny or it stops paying for itself.

import type { ReactNode } from 'react'
import { tGlobal, useT } from '../lib/i18n'
import { useApp } from '../lib/store'

// ----------------------------------------------------------------------- icons
// Inline SVG so there is no icon-font dependency and every glyph inherits colour.

type IconName =
  | 'layers' | 'activity' | 'tag' | 'list' | 'settings' | 'search' | 'refresh'
  | 'folder' | 'play' | 'stop' | 'download' | 'check' | 'x' | 'alert' | 'chevron'
  | 'terminal' | 'file' | 'spinner' | 'copy' | 'arrow-left' | 'clock' | 'cpu'
  | 'plus' | 'pencil' | 'sun' | 'moon' | 'database'

const PATHS: Record<IconName, ReactNode> = {
  layers: <><path d="M12 3 3 7.5 12 12l9-4.5L12 3Z" /><path d="m3 12 9 4.5L21 12" /><path d="m3 16.5 9 4.5 9-4.5" /></>,
  activity: <path d="M3 12h4l3 8 4-16 3 8h4" />,
  tag: <><path d="M12.6 3H5a2 2 0 0 0-2 2v7.6a2 2 0 0 0 .6 1.4l7.4 7.4a2 2 0 0 0 2.8 0l7.6-7.6a2 2 0 0 0 0-2.8L14 3.6a2 2 0 0 0-1.4-.6Z" /><circle cx="7.5" cy="7.5" r="1.2" /></>,
  list: <><path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M3 6h.01" /><path d="M3 12h.01" /><path d="M3 18h.01" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-3-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.3 7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 2.9-1.2V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.2a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.6 1Z" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>,
  refresh: <><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v5h-5" /></>,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />,
  play: <path d="M6 4l14 8-14 8V4Z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="1.5" />,
  download: <><path d="M12 3v12" /><path d="m7 11 5 5 5-5" /><path d="M4 21h16" /></>,
  check: <path d="m4 12.5 5 5L20 6.5" />,
  x: <><path d="M6 6l12 12" /><path d="M18 6 6 18" /></>,
  alert: <><path d="M12 3 2 20h20L12 3Z" /><path d="M12 10v4" /><path d="M12 17h.01" /></>,
  database: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></>,
  chevron: <path d="m9 6 6 6-6 6" />,
  terminal: <><path d="m5 8 3 3-3 3" /><path d="M12 15h7" /><rect x="2" y="3" width="20" height="18" rx="2" /></>,
  file: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" /><path d="M14 3v5h5" /></>,
  spinner: <path d="M21 12a9 9 0 1 1-6.2-8.6" />,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></>,
  'arrow-left': <><path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></>,
  plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path d="M4.9 4.9l1.4 1.4" /><path d="M17.7 17.7l1.4 1.4" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="M6.3 17.7l-1.4 1.4" /><path d="M19.1 4.9l-1.4 1.4" /></>,
  moon: <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5Z" />,
  pencil: <><path d="M4 20h4L18 10l-4-4L4 16v4Z" /><path d="m14 6 4 4" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  cpu: <><rect x="5" y="5" width="14" height="14" rx="2" /><rect x="9" y="9" width="6" height="6" /><path d="M9 2v3" /><path d="M15 2v3" /><path d="M9 19v3" /><path d="M15 19v3" /><path d="M2 9h3" /><path d="M2 15h3" /><path d="M19 9h3" /><path d="M19 15h3" /></>,
}

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
      className={className} style={{ flex: 'none' }} aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  )
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spin"><Icon name="spinner" size={size} /></span>
}

// ------------------------------------------------------------------------ bits

export function Badge({ kind = '', children }: { kind?: '' | 'ok' | 'warn' | 'bad' | 'info' | 'violet'; children: ReactNode }) {
  return <span className={`badge ${kind}`}>{children}</span>
}

/** Colour a failure rate: quiet below 2%, amber to 8%, red above. */
export function rateKind(rate: number | null): '' | 'ok' | 'warn' | 'bad' {
  if (rate == null) return ''
  if (rate === 0) return 'ok'
  if (rate < 0.02) return ''
  if (rate < 0.08) return 'warn'
  return 'bad'
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="stat">
      <div className="v" style={tone ? { color: tone } : undefined}>{value}</div>
      <div className="k">{label}</div>
    </div>
  )
}

export function Card({ title, sub, children, actions, tight }: {
  title?: ReactNode; sub?: ReactNode; children: ReactNode; actions?: ReactNode; tight?: boolean
}) {
  return (
    <div className={`card${tight ? ' tight' : ''}`}>
      {(title || actions) && (
        <div className="row" style={{ marginBottom: 10 }}>
          <div className="grow">
            {title && <h3 className="card-title">{title}</h3>}
            {sub && <p className="card-sub" style={{ marginBottom: 0 }}>{sub}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </div>
  )
}

export function Empty({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="empty">
      <div>
        <div className="big">{title}</div>
        {hint && <div>{hint}</div>}
      </div>
    </div>
  )
}

export function Section({ label, right, children }: { label: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="section">
      <div className="section-head">
        <span>{label}</span>
        <span className="line" />
        {right}
      </div>
      {children}
    </div>
  )
}

export function CopyBtn({ text, label }: { text: string; label?: string }) {
  const { toast } = useApp()
  const t = useT()
  return (
    <button
      className="btn ghost sm"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(
          () => toast(t('copied'), 'ok'),
          () => toast(t('clipboard blocked by the webview'), 'err'),
        )
      }}
    >
      <Icon name="copy" size={12} /> {label ?? t('Copy')}
    </button>
  )
}

export function Toasts() {
  const { toasts } = useApp()
  return (
    <>
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind === 'err' ? 'err' : t.kind === 'ok' ? 'ok' : ''}`}>
          {t.text}
        </div>
      ))}
    </>
  )
}

// ---------------------------------------------------------------------- diff

export interface DiffLine { kind: 'add' | 'del' | 'ctx' | 'hunk' | 'meta'; text: string; n?: number }

/**
 * Line diff by longest-common-subsequence.
 *
 * O(n*m) time and memory. Transcript edits are almost always small (a rewrite of
 * one function), and we cap the input lengths before calling, so the quadratic
 * worst case never materialises in practice.
 */
export function diffLines(a: string, b: string): DiffLine[] {
  const A = a.split('\n')
  const B = b.split('\n')
  const n = A.length
  const m = B.length

  // Trim the common prefix and suffix first — it is the cheap 95% of real edits.
  let pre = 0
  while (pre < n && pre < m && A[pre] === B[pre]) pre++
  let suf = 0
  while (suf < n - pre && suf < m - pre && A[n - 1 - suf] === B[m - 1 - suf]) suf++

  const na = A.slice(pre, n - suf)
  const nb = B.slice(pre, m - suf)

  const out: DiffLine[] = []
  if (pre > 0) {
    const key = pre === 1 ? '{n} unchanged line above' : '{n} unchanged lines above'
    out.push({ kind: 'meta', text: '  ' + tGlobal(key, { n: pre }) })
  }

  if (na.length === 0 && nb.length === 0) {
    out.push({ kind: 'meta', text: '  ' + tGlobal('no changes') })
  } else if (na.length === 0 || nb.length === 0) {
    na.forEach((t, i) => out.push({ kind: 'del', text: `- ${t}`, n: pre + i + 1 }))
    nb.forEach((t, i) => out.push({ kind: 'add', text: `+ ${t}`, n: pre + na.length + i + 1 }))
  } else {
    out.push({ kind: 'hunk', text: `@@ -${pre + 1},${na.length} +${pre + 1},${nb.length} @@` })

    // dp[i][j] = LCS length of na[i:] and nb[j:]
    const dp: Uint32Array[] = []
    for (let i = 0; i <= na.length; i++) dp.push(new Uint32Array(nb.length + 1))
    for (let i = na.length - 1; i >= 0; i--) {
      for (let j = nb.length - 1; j >= 0; j--) {
        dp[i][j] = na[i] === nb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < na.length && j < nb.length) {
      if (na[i] === nb[j]) {
        out.push({ kind: 'ctx', text: `  ${na[i]}`, n: pre + i + 1 })
        i++
        j++
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        out.push({ kind: 'del', text: `- ${na[i]}`, n: pre + i + 1 })
        i++
      } else {
        out.push({ kind: 'add', text: `+ ${nb[j]}`, n: pre + j + 1 })
        j++
      }
    }
    while (i < na.length) out.push({ kind: 'del', text: `- ${na[i]}`, n: pre + i++ + 1 })
    while (j < nb.length) out.push({ kind: 'add', text: `+ ${nb[j]}`, n: pre + j++ + 1 })
  }

  if (suf > 0) {
    const key = suf === 1 ? '{n} unchanged line below' : '{n} unchanged lines below'
    out.push({ kind: 'meta', text: '  ' + tGlobal(key, { n: suf }) })
  }
  return out
}

export function DiffView({ lines, max = 400 }: { lines: DiffLine[]; max?: number }) {
  const shown = lines.length > max ? lines.slice(0, max) : lines
  return (
    <>
      <div className="diff">
        {shown.map((l, k) => (
          <div key={k} className={`ln ${l.kind === 'add' ? 'add' : l.kind === 'del' ? 'del' : l.kind === 'hunk' ? 'hunk' : ''}`}>
            <span className="gutter">{l.n ?? ''}</span>
            <span className="txt">{l.text}</span>
          </div>
        ))}
      </div>
      {lines.length > max && (
        <div className="tiny faint" style={{ marginTop: 6 }}>
          {tGlobal('showing {a} of {b} diff lines', { a: max, b: lines.length })}
        </div>
      )}
    </>
  )
}