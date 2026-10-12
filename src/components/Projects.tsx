// The project list: which folders of transcripts this app is pointed at.
//
// One row is one folder. Clicking a row switches the whole app over to it, the
// way the Sessions table, the annotate pool and the export defaults all follow
// the active project. Adding a folder is one click away from three places: the
// + here, a folder picker, or the well-known locations the backend probes.

import { useEffect, useRef, useState } from 'react'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import * as api from '../lib/api'
import { fmtInt, shortPath } from '../lib/format'
import { useT } from '../lib/i18n'
import { samePath } from '../lib/projects'
import { useApp } from '../lib/store'
import { Icon, Spinner } from './ui'

export default function Projects() {
  const {
    projects, activeProject, counts, addProject, removeProject, renameProject, activateProject,
  } = useApp()
  const [menu, setMenu] = useState(false)
  const [found, setFound] = useState<api.RootCandidate[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const t = useT()

  // A click anywhere else closes the popover. Cheaper than a modal, and it
  // keeps the + from needing a second click to dismiss.
  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setMenu(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [menu])

  const openMenu = async () => {
    if (menu) {
      setMenu(false)
      return
    }
    setMenu(true)
    if (found === null) {
      try {
        const all = await api.defaultRoots()
        setFound(all.filter((c) => c.exists && c.nJsonl > 0))
      } catch {
        setFound([])
      }
    }
  }

  const browse = async () => {
    setMenu(false)
    const picked = await openDialog({ directory: true, multiple: false })
    if (typeof picked !== 'string') return
    setBusy(true)
    try {
      await addProject(picked)
    } finally {
      setBusy(false)
    }
  }

  const startRename = (path: string, name: string) => {
    setEditing(path)
    setDraft(name)
  }

  const commitRename = async (path: string) => {
    const name = draft
    setEditing(null)
    if (name.trim()) await renameProject(path, name)
  }

  const pick = async (path: string) => {
    setMenu(false)
    setBusy(true)
    try {
      await addProject(path)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rail-sec" ref={box}>
      <div className="rail-sec-head">
        <span>{t('Projects')}</span>
        <button
          className="rail-add"
          onClick={() => void openMenu()}
          title={t('Add a folder of transcripts')}
        >
          {busy ? <Spinner size={12} /> : <Icon name="plus" size={14} />}
        </button>
      </div>

      {projects.length === 0 ? (
        <div className="rail-hint">
          {t('No folders yet. Add the directory your agent writes transcripts into.')}
        </div>
      ) : (
        <div className="proj-list">
          {projects.map((p) => {
            const active = !!activeProject && samePath(activeProject.path, p.path)
            const c = counts[p.path]
            const gone = c ? !c.exists : false
            return (
              <div key={p.path} className={'proj' + (active ? ' on' : '')}>
                {editing === p.path ? (
                  <input
                    className="input proj-rename"
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => void commitRename(p.path)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void commitRename(p.path)
                      if (e.key === 'Escape') setEditing(null)
                    }}
                  />
                ) : (
                  <>
                    <button className="proj-main" onClick={() => void activateProject(p.path)} title={p.path}>
                      <Icon name="folder" size={13} />
                      <span className="truncate">{p.name}</span>
                      {p.profile && <span className="pin">{p.profile}</span>}
                    </button>
                    <span className="proj-count">
                      {gone ? (
                        <span className="miss" title={t('that folder is gone')}>
                          <Icon name="alert" size={12} />
                        </span>
                      ) : c ? (
                        <span title={`${fmtInt(c.transcripts)} ${shortPath(p.path, 60)}`}>
                          {fmtInt(c.transcripts)}
                        </span>
                      ) : (
                        ''
                      )}
                    </span>
                    <span className="proj-acts">
                      <button
                        className="ikon"
                        title={t('Rename')}
                        onClick={() => startRename(p.path, p.name)}
                      >
                        <Icon name="pencil" size={12} />
                      </button>
                      <button
                        className="ikon"
                        title={t('Remove from the list')}
                        onClick={() => void removeProject(p.path)}
                      >
                        <Icon name="x" size={12} />
                      </button>
                    </span>
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}

      {menu && (
        <div className="pop">
          <button className="pop-item" onClick={() => void browse()}>
            <Icon name="folder" size={13} />
            <span className="grow">{t('Choose a folder…')}</span>
          </button>
          {found && found.length > 0 && (
            <>
              <div className="pop-head">{t('Transcript folders found on this machine')}</div>
              {found.map((f) => (
                <button
                  key={f.path}
                  className="pop-item"
                  onClick={() => void pick(f.path)}
                  title={f.path}
                >
                  <span className="grow truncate">{f.label}</span>
                  <span className="faint mono">{f.nJsonl}</span>
                </button>
              ))}
            </>
          )}
          {found && found.length === 0 && (
            <div className="pop-note">{t('Nothing else found — pick a folder with the button above.')}</div>
          )}
        </div>
      )}
    </div>
  )
}