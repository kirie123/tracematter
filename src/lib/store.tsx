// Application state.
//
// Deliberately a single context rather than a state library: this app has one
// screen-worth of durable state (config, the scan, the open trace, the running
// job) and everything else is derived. Keeping it in one place makes the
// data-flow obvious and removes a dependency.

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react'
import * as api from './api'
import { useI18n } from './i18n'
import type {
  AppConfig, JobProgress, LabelRecord, ScanResult, SessionSummary, Trace, TurnSegment,
} from './types'

export interface Toast {
  id: number
  kind: 'info' | 'ok' | 'err'
  text: string
}

interface Ctx {
  config: AppConfig | null
  setConfig: (c: AppConfig) => void
  persistConfig: (patch: Partial<AppConfig>) => Promise<void>

  scan: ScanResult | null
  scanning: boolean
  rescan: (root?: string) => Promise<void>

  selected: Set<string>
  toggleSelected: (path: string) => void
  selectAll: (paths: string[]) => void
  clearSelected: () => void

  trace: Trace | null
  traceLoading: boolean
  openTrace: (s: SessionSummary) => Promise<void>
  closeTrace: () => void

  /** Turns harvested from the sessions picked on the Annotate screen. */
  pool: TurnSegment[]
  poolLoading: boolean
  buildPool: (paths: string[]) => Promise<void>
  clearPool: () => void

  job: JobProgress | null
  labels: LabelRecord[]
  watching: boolean
  startLabeling: (args: {
    segments: TurnSegment[]
    schemaId: string
    outputPath?: string | null
    systemExtra?: string
  }) => Promise<void>
  cancelLabeling: () => Promise<void>
  clearLabels: () => void
  loadJob: (id: string) => Promise<void>

  toasts: Toast[]
  toast: (text: string, kind?: Toast['kind']) => void
}

const AppCtx = createContext<Ctx | null>(null)

export function useApp(): Ctx {
  const c = useContext(AppCtx)
  if (!c) throw new Error('useApp must be used inside <AppProvider>')
  return c
}

let toastSeq = 0

export function AppProvider({ children }: { children: ReactNode }) {
  const [config, setConfigState] = useState<AppConfig | null>(null)
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [scanning, setScanning] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [trace, setTrace] = useState<Trace | null>(null)
  const [traceLoading, setTraceLoading] = useState(false)
  const [pool, setPool] = useState<TurnSegment[]>([])
  const [poolLoading, setPoolLoading] = useState(false)
  const [job, setJob] = useState<JobProgress | null>(null)
  const [labels, setLabels] = useState<LabelRecord[]>([])
  const [watching, setWatching] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])
  const { t } = useI18n()

  // Latest config, readable from callbacks without re-creating them.
  const configRef = useRef<AppConfig | null>(null)
  configRef.current = config

  const toast = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = ++toastSeq
    setToasts((t) => [...t, { id, kind, text }])
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'err' ? 9000 : 4200)
  }, [])

  // -------------------------------------------------------------- bootstrap
  useEffect(() => {
    api
      .loadConfig()
      .then((c) => {
        setConfigState(c)
        if (c.workspaceRoot) {
          void rescanWith(c.workspaceRoot)
        }
      })
      .catch((e) => toast(api.humanError(e), 'err'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ------------------------------------------------------------ job events
  useEffect(() => {
    let un1: (() => void) | undefined
    let un2: (() => void) | undefined
    let alive = true
    void (async () => {
      const [a, b] = await Promise.all([
        api.onJobProgress((p) => setJob(p)),
        api.onJobRecord((r) => setLabels((prev) => [...prev, r])),
      ])
      if (!alive) {
        a()
        b()
        return
      }
      un1 = a
      un2 = b
      setWatching(true)
    })()
    return () => {
      alive = false
      un1?.()
      un2?.()
    }
  }, [])

  // ------------------------------------------------------------- callbacks
  const persistConfig = useCallback(
    async (patch: Partial<AppConfig>) => {
      const cur = configRef.current
      if (!cur) return
      const next = { ...cur, ...patch }
      setConfigState(next)
      try {
        const saved = await api.saveConfig(next)
        setConfigState(saved)
      } catch (e) {
        toast(api.humanError(e), 'err')
      }
    },
    [toast],
  )

  const rescanWith = useCallback(
    async (root: string) => {
      setScanning(true)
      try {
        const res = await api.scanSessions(root)
        setScan(res)
        if (res.filesFailed > 0) {
          toast(t('{a} of {b} files could not be read', { a: res.filesFailed, b: res.filesSeen }), 'err')
        }
      } catch (e) {
        toast(api.humanError(e), 'err')
      } finally {
        setScanning(false)
      }
    },
    [toast, t],
  )

  const rescan = useCallback(
    async (root?: string) => {
      const target = root ?? configRef.current?.workspaceRoot
      if (!target) {
        toast(t('Pick a workspace folder first'), 'err')
        return
      }
      await rescanWith(target)
    },
    [rescanWith, toast, t],
  )

  const toggleSelected = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const selectAll = useCallback((paths: string[]) => setSelected(new Set(paths)), [])
  const clearSelected = useCallback(() => setSelected(new Set()), [])

  const openTrace = useCallback(
    async (s: SessionSummary) => {
      setTraceLoading(true)
      try {
        const t = await api.loadTrace(s.path, s.id, configRef.current?.digest)
        setTrace(t)
      } catch (e) {
        toast(api.humanError(e), 'err')
      } finally {
        setTraceLoading(false)
      }
    },
    [toast],
  )

  const closeTrace = useCallback(() => setTrace(null), [])

  /// Harvest turns from every selected session. Done in the UI process rather
  /// than Rust because the segments are already fully materialised per trace.
  const buildPool = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) {
        toast(t('Select at least one session first'), 'err')
        return
      }
      setPoolLoading(true)
      setPool([])
      const acc: TurnSegment[] = []
      try {
        const digest = configRef.current?.digest
        for (const p of paths) {
          try {
            const t = await api.loadTrace(p, null, digest)
            acc.push(...t.turns)
          } catch (e) {
            toast(`${p.split(/[/\\]/).pop()}: ${api.humanError(e)}`, 'err')
          }
        }
        acc.sort((a, b) => a.id.localeCompare(b.id))
        setPool(acc)
        toast(t('{a} turns from {b} sessions', { a: acc.length, b: paths.length }), 'ok')
      } finally {
        setPoolLoading(false)
      }
    },
    [toast, t],
  )

  const clearPool = useCallback(() => setPool([]), [])

  const startLabeling = useCallback(
    async (args: { segments: TurnSegment[]; schemaId: string; outputPath?: string | null; systemExtra?: string }) => {
      const cfg = configRef.current
      if (!cfg) return
      const schema = cfg.schemas.find((s) => s.id === args.schemaId)
      if (!schema) {
        toast(t('Unknown rubric'), 'err')
        return
      }
      if (!cfg.gateway.baseUrl.trim()) {
        toast(t('Set a gateway base URL in Settings first'), 'err')
        return
      }
      setLabels([])
      try {
        const id = await api.startJob({
          segments: args.segments,
          schema,
          gateway: cfg.gateway,
          systemExtra: args.systemExtra,
          outputPath: args.outputPath ?? null,
        })
        setJob({
          jobId: id, status: 'running', total: args.segments.length,
          completed: 0, failed: 0, running: args.segments.length, message: 'queued',
        })
        toast(t('job {id} started · {n} rows', { id: id.slice(0, 8), n: args.segments.length }), 'ok')
      } catch (e) {
        toast(api.humanError(e), 'err')
      }
    },
    [toast, t],
  )

  const cancelLabeling = useCallback(async () => {
    if (!job) return
    try {
      await api.cancelJob(job.jobId)
      toast(t('cancelling…'))
    } catch (e) {
      toast(api.humanError(e), 'err')
    }
  }, [job, toast, t])

  const clearLabels = useCallback(() => {
    setLabels([])
    setJob(null)
  }, [])

  const loadJob = useCallback(
    async (id: string) => {
      try {
        const [p, rs] = await Promise.all([api.jobStatus(id), api.jobResults(id)])
        if (!p) {
          toast(t('that job is no longer in memory — import its JSONL instead'), 'err')
          return
        }
        setJob(p)
        setLabels(rs)
        toast(t('loaded {n} rows from job {id}', { n: rs.length, id: id.slice(0, 8) }), 'ok')
      } catch (e) {
        toast(api.humanError(e), 'err')
      }
    },
    [toast, t],
  )

  const value = useMemo<Ctx>(
    () => ({
      config, setConfig: setConfigState, persistConfig,
      scan, scanning, rescan,
      selected, toggleSelected, selectAll, clearSelected,
      trace, traceLoading, openTrace, closeTrace,
      pool, poolLoading, buildPool, clearPool,
      job, labels, watching, startLabeling, cancelLabeling, clearLabels, loadJob,
      toasts, toast,
    }),
    [
      config, persistConfig, scan, scanning, rescan, selected, toggleSelected, selectAll,
      clearSelected, trace, traceLoading, openTrace, closeTrace, pool, poolLoading,
      buildPool, clearPool, job, labels, watching, startLabeling, cancelLabeling,
      clearLabels, loadJob, toasts, toast,
    ],
  )

  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>
}

/** Summaries of the currently selected sessions, in table order. */
export function selectedSessions(scan: ScanResult | null, selected: Set<string>): SessionSummary[] {
  if (!scan) return []
  return scan.sessions.filter((s) => selected.has(s.path))
}