import { useEffect, useState } from 'react'
import { Icon, Spinner, Toasts } from './components/ui'
import Projects from './components/Projects'
import { LANGUAGES, useI18n } from './lib/i18n'
import { useApp } from './lib/store'
import Annotate from './pages/Annotate'
import Review from './pages/Review'
import Sessions from './pages/Sessions'
import Settings from './pages/Settings'
import Trace from './pages/Trace'

type Theme = 'paper' | 'ink'

const THEME_KEY = 'tracematter.theme'

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

export type View = 'sessions' | 'trace' | 'annotate' | 'review' | 'settings'

/** The label doubles as the dictionary key. */
const NAV: { id: View; label: string; icon: 'list' | 'activity' | 'tag' | 'layers' | 'settings' }[] = [
  { id: 'sessions', label: 'Sessions', icon: 'list' },
  { id: 'trace', label: 'Trace', icon: 'activity' },
  { id: 'annotate', label: 'Annotate', icon: 'tag' },
  { id: 'review', label: 'Review', icon: 'layers' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
]

export default function App() {
  const { scan, selected, trace, labels, job, scanning } = useApp()
  const [view, setView] = useState<View>('sessions')
  const { t, lang, setLang } = useI18n()

  const [theme, setTheme] = useState<Theme>(initialTheme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {
      /* ignore */
    }
  }, [theme])

  // Jump to the trace view the moment a session is opened.
  useEffect(() => {
    if (trace) setView((v) => (v === 'sessions' ? 'trace' : v))
  }, [trace])

  const counts: Record<View, string> = {
    sessions: scan ? String(scan.sessions.length) : '',
    trace: trace ? String(trace.steps.length) : '',
    annotate: '',
    review: labels.length ? String(labels.length) : '',
    settings: '',
  }

  const titles: Record<View, string> = {
    sessions: t('Sessions'),
    trace: trace ? trace.summary.title || trace.summary.id.slice(0, 8) : t('Trace'),
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

        {NAV.map((n) => (
          <button
            key={n.id}
            className={'nav-item' + (view === n.id ? ' active' : '')}
            onClick={() => setView(n.id)}
            disabled={n.id === 'trace' && !trace}
          >
            <Icon name={n.icon} size={15} />
            <span>{t(n.label)}</span>
            {n.id === 'annotate' && job && job.status === 'running' ? (
              <span className="count"><Spinner size={11} /></span>
            ) : counts[n.id] ? (
              <span className="count">{counts[n.id]}</span>
            ) : null}
          </button>
        ))}

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
            <button className="btn ghost sm" onClick={() => setView('sessions')} title={t('Back to sessions')}>
              <Icon name="arrow-left" size={14} />
            </button>
          )}
          {view === 'trace' && <span className="tag">{t('Trace')}</span>}
          <h1 className="truncate">{titles[view]}</h1>
          <div className="spacer" />
          <button
            className="chip"
            onClick={() => setTheme(theme === 'paper' ? 'ink' : 'paper')}
            title={t(theme === 'paper' ? 'Switch to the ink theme' : 'Switch to the paper theme')}
          >
            <Icon name={theme === 'paper' ? 'moon' : 'sun'} size={12} /> {t(theme === 'paper' ? 'Ink' : 'Paper')}
          </button>
          <div className="row" style={{ gap: 4 }} title={t('Language')}>
            {LANGUAGES.map((l) => (
              <button
                key={l.id}
                className={'chip' + (lang === l.id ? ' on' : '')}
                onClick={() => setLang(l.id)}
              >
                {l.label}
              </button>
            ))}
          </div>
          {scanning && (
            <span className="faint small row" style={{ gap: 6 }}><Spinner /> {t('scanning')}</span>
          )}
          {job && job.status === 'running' && (
            <button className="btn sm" onClick={() => setView('annotate')}>
              <Spinner size={12} /> {t('{a}/{b} labeled', { a: job.completed, b: job.total })}
            </button>
          )}
        </header>

        {view === 'sessions' && <Sessions />}
        {view === 'trace' && <Trace />}
        {view === 'annotate' && <Annotate />}
        {view === 'review' && <Review />}
        {view === 'settings' && <Settings />}
      </main>

      <Toasts />
    </div>
  )
}