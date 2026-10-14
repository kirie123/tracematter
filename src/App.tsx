import { useCallback, useEffect, useState } from 'react'
import Analyst from './components/Analyst'
import { Icon, Spinner, Toasts } from './components/ui'
import Projects from './components/Projects'
import { LANGUAGES, useI18n } from './lib/i18n'
import { useApp } from './lib/store'
import type { AnalystAsk } from './lib/types'
import Annotate from './pages/Annotate'
import Data from './pages/Data'
import Review from './pages/Review'
import Sessions from './pages/Sessions'
import Settings from './pages/Settings'
import Trace from './pages/Trace'

type Theme = 'paper' | 'ink'

const THEME_KEY = 'tracematter.theme'
const DOCK_KEY = 'tracematter.dock'

/** The stored choice wins; otherwise follow the OS once, on first run. */
function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY)
    if (saved === 'paper' || saved === 'ink') return saved
  } catch {
    /* storage can be blocked inside a webview; the default is fine */
  }
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'ink' : 'paper'
}

/** The dock is a place you work, not a dialog: it is open unless you closed it. */
function initialDock(): boolean {
  try {
    return localStorage.getItem(DOCK_KEY) !== '0'
  } catch {
    return true
  }
}

export type View = 'sessions' | 'trace' | 'data' | 'annotate' | 'review' | 'settings'

/**
 * The rail. `hint` is the one-line explanation a hovering reader gets: the
 * label alone says what a view is called, not what opening it will do.
 */
const NAV: {
  id: View
  label: string
  hint: string
  icon: 'list' | 'activity' | 'database' | 'tag' | 'layers' | 'settings'
}[] = [
  {
    id: 'sessions',
    label: 'Sessions',
    hint: 'Every transcript in the folder, one row each: cost, errors, tokens. Sort to triage.',
    icon: 'list',
  },
  {
    id: 'trace',
    label: 'Trace',
    hint: 'Replay one session step by step: what it ran, what it changed, what failed.',
    icon: 'activity',
  },
  {
    id: 'data',
    label: 'Data',
    hint: 'Read and edit JSON, JSONL and parquet: eval results, pass@k, rubrics.',
    icon: 'database',
  },
  {
    id: 'annotate',
    label: 'Annotate',
    hint: 'Harvest turns from the sessions you pick and grade them against a rubric.',
    icon: 'tag',
  },
  {
    id: 'review',
    label: 'Review',
    hint: 'Filter what the model judged, then export the rows worth training on.',
    icon: 'layers',
  },
  {
    id: 'settings',
    label: 'Settings',
    hint: 'Folders, the model gateway, the agent, and the rubrics.',
    icon: 'settings',
  },
]

/** The digits that jump to a view, in NAV order. */
const VIEW_KEYS = ['1', '2', '3', '4', '5', '6']

export default function App() {
  const { scan, selected, trace, labels, job, scanning } = useApp()
  const [view, setView] = useState<View>('sessions')
  const { t, lang, setLang } = useI18n()

  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [dock, setDock] = useState(initialDock)
  const [ask, setAsk] = useState<AnalystAsk | null>(null)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {
      /* ignore */
    }
  }, [theme])

  useEffect(() => {
    try {
      localStorage.setItem(DOCK_KEY, dock ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [dock])

  /** Open the dock with a question already sitting in the composer. */
  const askAnalyst = useCallback((text: string) => {
    setAsk({ text, key: Date.now() })
    setDock(true)
  }, [])

  const clearAsk = useCallback(() => setAsk(null), [])

  // Shortcuts, the way a workbench should have them: a digit picks a view,
  // Ctrl+J toggles the dock, Escape closes it. Escape stays out of the way
  // while a field has focus — the composer clears its own draft first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const typing =
        !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      if (e.key === 'Escape') {
        if (dock && !typing) setDock(false)
        return
      }
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
      const i = VIEW_KEYS.indexOf(e.key)
      if (i >= 0) {
        const id = NAV[i].id
        if (id === 'trace' && !trace) return
        e.preventDefault()
        setView(id)
        return
      }
      if (e.key === 'j' || e.key === 'J' || e.key === '`') {
        e.preventDefault()
        setDock((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dock, trace])

  // Jump to the trace view the moment a session is opened.
  useEffect(() => {
    if (trace) setView((v) => (v === 'sessions' ? 'trace' : v))
  }, [trace])

  const counts: Record<View, string> = {
    sessions: scan ? String(scan.sessions.length) : '',
    trace: trace ? String(trace.steps.length) : '',
    data: '',
    annotate: '',
    review: labels.length ? String(labels.length) : '',
    settings: '',
  }

  const titles: Record<View, string> = {
    sessions: t('Sessions'),
    trace: trace ? trace.summary.title || trace.summary.id.slice(0, 8) : t('Trace'),
    data: t('Data'),
    annotate: t('Annotate'),
    review: t('Review'),
    settings: t('Settings'),
  }

  return (
    <div className="app">
      <aside className="rail">
        <div className="brand">
          <div className="brand-mark">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 17c3.5 0 5-10 9-10s5.5 10 9 10" />
            </svg>
          </div>
          <div>
            <div className="brand-name">TraceMatter</div>
            <div className="brand-sub">{t('agent trajectory workbench')}</div>
          </div>
        </div>

        {NAV.map((n, i) => {
          // A view that cannot open yet is not `disabled`: a disabled control
          // in a browser refuses to show its tooltip, and "why is this greyed
          // out" is exactly what a reader needs answered.
          const blocked = n.id === 'trace' && !trace
          return (
            <button
              key={n.id}
              className={'nav-item' + (view === n.id ? ' active' : '') + (blocked ? ' blocked' : '')}
              aria-disabled={blocked}
              onClick={() => {
                if (!blocked) setView(n.id)
              }}
              data-tip={
                blocked
                  ? t('Open a session from Sessions first — then this replays it.')
                  : t(n.hint) + '  ·  Ctrl+' + VIEW_KEYS[i]
              }
            >
              <Icon name={n.icon} size={15} />
              <span>{t(n.label)}</span>
              {n.id === 'annotate' && job && job.status === 'running' ? (
                <span className="count"><Spinner size={11} /></span>
              ) : counts[n.id] ? (
                <span className="count">{counts[n.id]}</span>
              ) : null}
            </button>
          )
        })}

        <Projects />

        <div className="rail-foot">
          <div className="tiny">
            {scan ? (
              <>
                {t('{a} sessions, {b} files', { a: scan.sessions.length, b: scan.filesSeen })}
                {scan.filesFailed > 0 && (
                  <span style={{ color: 'var(--bad)' }}> · {t('{n} unreadable', { n: scan.filesFailed })}</span>
                )}
              </>
            ) : (
              t('no workspace yet')
            )}
          </div>
          {selected.size > 0 && (
            <div className="tiny" style={{ marginTop: 4, color: 'var(--accent)' }}>
              {t('{n} selected', { n: selected.size })}
            </div>
          )}
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          {view === 'trace' && trace && (
            <button
              className="btn ghost sm"
              onClick={() => setView('sessions')}
              data-tip={t('Back to the session list')}
            >
              <Icon name="arrow-left" size={14} />
            </button>
          )}
          {view === 'trace' && <span className="tag">{t('Trace')}</span>}
          <h1 className="truncate">{titles[view]}</h1>
          <div className="spacer" />
          <button
            className="chip tip-down"
            onClick={() => setTheme(theme === 'paper' ? 'ink' : 'paper')}
            data-tip={
              theme === 'paper'
                ? t('Switch to the dark theme')
                : t('Switch to the light theme')
            }
          >
            <Icon name={theme === 'paper' ? 'moon' : 'sun'} size={12} /> {t(theme === 'paper' ? 'Ink' : 'Paper')}
          </button>
          <div className="row" style={{ gap: 4 }}>
            {LANGUAGES.map((l) => (
              <button
                key={l.id}
                className={'chip tip-down' + (lang === l.id ? ' on' : '')}
                onClick={() => setLang(l.id)}
                data-tip={t('Show the interface in {l}', { l: l.label })}
              >
                {l.label}
              </button>
            ))}
          </div>
          {scanning && (
            <span className="faint small row" style={{ gap: 6 }}><Spinner /> {t('scanning')}</span>
          )}
          {job && job.status === 'running' && (
            <button
              className="btn sm tip-down"
              onClick={() => setView('annotate')}
              data-tip={t('A labelling job is running — open the bench to watch it')}
            >
              <Spinner size={12} /> {t('{a}/{b} labeled', { a: job.completed, b: job.total })}
            </button>
          )}
          {/* The panel toggle sits hard against the panel's edge, so the control
              and the thing it controls read as one. */}
          <button
            className={'chip dock-toggle' + (dock ? ' on' : '')}
            onClick={() => setDock((v) => !v)}
            title={t('Toggle the Analyst panel') + ' · Ctrl+J'}
          >
            <Icon name="cpu" size={12} /> {t('Analyst')}
          </button>
        </header>

        {view === 'sessions' && <Sessions onAsk={askAnalyst} />}
        {view === 'trace' && <Trace onAsk={askAnalyst} />}
        {view === 'data' && <Data onAsk={askAnalyst} />}
        {view === 'annotate' && <Annotate />}
        {view === 'review' && <Review />}
        {view === 'settings' && <Settings />}
      </main>

      {dock && (
        <Analyst onClose={() => setDock(false)} ask={ask} onAskHandled={clearAsk} />
      )}

      <Toasts />
    </div>
  )
}