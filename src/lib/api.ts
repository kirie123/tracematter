// The only place that talks to the Rust side. Everything else in the app calls
// these functions, so the IPC surface stays greppable and typed.

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type {
  AppConfig, DigestOptions, FolderCount, GatewayConfig, JobProgress, LabelField,
  LabelRecord, LabelSchema, ScanResult, Trace, TurnSegment,
} from './types'

export const EV_PROGRESS = 'job://progress'
export const EV_RECORD = 'job://record'

// ------------------------------------------------------------------ settings

export const loadConfig = (): Promise<AppConfig> => invoke('load_config')
export const saveConfig = (cfg: AppConfig): Promise<AppConfig> => invoke('save_config', { cfg })
export const configLocation = (): Promise<string> => invoke('config_location')

// ------------------------------------------------------------------ profiles

export interface ProfileInfo {
  id: string
  name: string
  description: string
  /** How many record rules the profile declares. */
  rules: number
  builtin: boolean
  /** A user file of the same id sits in the profiles folder and shadows it. */
  override: boolean
}

export interface ProfileGuess {
  id: string
  name: string
  score: number
}

/** Every profile the reader knows about: the built-ins plus any user files. */
export const listProfiles = (): Promise<ProfileInfo[]> => invoke('list_profiles')

/** What one file looks like it is, best guess first. */
export const detectProfile = (path: string): Promise<ProfileGuess[]> =>
  invoke('detect_profile', { path })

/** Where a hand-written profile has to go to be picked up. */
export const profilesDir = (): Promise<string> => invoke('profiles_dir')

// ------------------------------------------------------------------- reading

export const scanSessions = (root: string, concurrency = 8, profile?: string | null): Promise<ScanResult> =>
  invoke('scan_sessions', { args: { root, concurrency, profile: profile || null } })

/** Transcript count per folder, for the project list. Walks directories, parses nothing. */
export const countTranscripts = (paths: string[]): Promise<FolderCount[]> =>
  invoke('count_transcripts', { paths })

export const loadTrace = (
  path: string,
  sessionId?: string | null,
  digest?: DigestOptions,
): Promise<Trace> =>
  invoke('load_trace', { args: { path, sessionId: sessionId ?? null, digest: digest ?? null } })

export const workspaceAt = (path: string, sessionId?: string | null): Promise<[string, string][]> =>
  invoke('workspace_at', { args: { path, sessionId: sessionId ?? null, digest: null } })

export const editLeaderboard = (paths: string[]): Promise<[string, number][]> =>
  invoke('edit_leaderboard', { paths })

// ------------------------------------------------------------------- gateway

export const probeGateway = (cfg: GatewayConfig): Promise<[boolean, string]> =>
  invoke('probe_gateway', { cfg })

// ---------------------------------------------------------------------- jobs

export interface StartJobArgs {
  segments: TurnSegment[]
  schema: LabelSchema
  gateway: GatewayConfig
  systemExtra?: string
  outputPath?: string | null
}

export const startJob = (args: StartJobArgs): Promise<string> =>
  invoke('start_job', {
    args: {
      segments: args.segments,
      schema: args.schema,
      gateway: args.gateway,
      systemExtra: args.systemExtra ?? '',
      outputPath: args.outputPath ?? null,
    },
  })

export const jobStatus = (id: string): Promise<JobProgress | null> => invoke('job_status', { id })
export const listJobs = (): Promise<JobProgress[]> => invoke('list_jobs')
export const cancelJob = (id: string): Promise<boolean> => invoke('cancel_job', { id })
export const jobResults = (id: string): Promise<LabelRecord[]> => invoke('job_results', { id })
export const forgetJob = (id: string): Promise<void> => invoke('forget_job', { id })

export const exportResults = (
  records: LabelRecord[],
  path: string,
  fields: LabelField[],
): Promise<number> => invoke('export_results', { records, path, fields })

export const readJsonl = (path: string, limit = 0): Promise<unknown[]> =>
  invoke('read_jsonl', { path, limit })

// ------------------------------------------------------------------- events

export const onJobProgress = (fn: (p: JobProgress) => void): Promise<UnlistenFn> =>
  listen<JobProgress>(EV_PROGRESS, (e) => fn(e.payload))

export const onJobRecord = (fn: (r: LabelRecord) => void): Promise<UnlistenFn> =>
  listen<LabelRecord>(EV_RECORD, (e) => fn(e.payload))

// ------------------------------------------------------------------ helpers

/** Turn any thrown value into something worth showing a user. */
export function humanError(e: unknown): string {
  if (typeof e === 'string') return e
  if (e instanceof Error) return e.message
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}
export interface RootCandidate {
  label: string
  path: string
  exists: boolean
  nJsonl: number
}

/** Well-known locations transcripts tend to live in, probed by the backend. */
export const defaultRoots = (): Promise<RootCandidate[]> => invoke('default_roots')
