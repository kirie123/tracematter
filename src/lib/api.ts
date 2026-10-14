// The only place that talks to the Rust side. Everything else in the app calls
// these functions, so the IPC surface stays greppable and typed.

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type {
  AgentStatus,
  ProviderPreset,
  AppConfig, DigestOptions, Document, FolderCount, GatewayConfig, JobProgress, LabelField,
  LabelRecord, LabelSchema, ParquetColumn, ParquetPage, Row, SaveResult, ScanResult, SetArgs,
  Trace, TurnSegment,
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

/** The preset table, so the chips come from one place instead of being copied here. */
export const providerPresets = (): Promise<ProviderPreset[]> => invoke('provider_presets')

/** Ask the gateway what it serves. Throws with a readable message when it cannot say. */
export const listModels = (cfg: GatewayConfig): Promise<string[]> =>
  invoke('list_models', { cfg })

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

// ---------------------------------------------------------------------- data

/** Open a file: kind, family, shape, and the first page of rows. */
export const dataOpen = (path: string, limit = 0): Promise<Document> =>
  invoke('data_open', { path, limit })

/** One line, uncut. How a cell fetches what the first page left out. */
export const dataRow = (path: string, line: number): Promise<Row> =>
  invoke('data_row', { path, line })

/** A fresh sibling path for an edited copy. Never one that exists. */
export const dataFork = (path: string): Promise<string> => invoke('data_fork', { path })

/** Write an edit to the copy. `dryRun` renders the bytes without touching anything. */
export const dataSet = (args: SetArgs): Promise<SaveResult> => invoke('data_set', { args })

/** Write the source in place, after a timestamped backup. */
export const dataOverwrite = (args: SetArgs): Promise<SaveResult> =>
  invoke('data_overwrite', { args })

/** What an edit would change, as text. Shown before the first save. */
export const dataDiff = (args: SetArgs): Promise<string> => invoke('data_diff', { args })

// -------------------------------------------------------------------- parquet

/** Columns and row count, from the footer. */
export const parquetSchema = (
  path: string,
): Promise<[ParquetColumn[], number, number]> => invoke('parquet_schema', { path })

/** A window of rows, with long cells clipped and named. */
export const parquetPage = (path: string, offset: number, limit: number): Promise<ParquetPage> =>
  invoke('parquet_page', { path, offset, limit })

/** One cell in full, after the page clipped it. */
export const parquetCell = (path: string, row: number, column: string): Promise<unknown> =>
  invoke('parquet_cell', { path, row, column })

/** Every parquet file in a folder as one logical table. */
export const parquetIndex = (path: string): Promise<[number, [string, number][]]> =>
  invoke('parquet_index', { path })

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

// -------------------------------------------------------------------- analyst

export const EV_ANALYST = 'agent:event'
export const EV_ANALYST_LOG = 'agent:log'

export const analystStatus = (): Promise<AgentStatus> => invoke('agent_status')
export const analystStop = (id = 'default'): Promise<void> => invoke('agent_stop', { id })
export const analystSend = (id: string, message: string, context?: string): Promise<void> =>
  invoke('agent_send', { id, message, context: context ?? null })

/** Forget the conversation; the next question starts a fresh context. */
export const agentReset = (id = 'default'): Promise<void> => invoke('agent_reset', { id })

/** One JSON object per line, exactly as the agent emitted it. */
/**
 * One agent event.
 *
 * Tauri hands this over already parsed when the backend emits a JSON object,
 * and as a string when it emits one. Both are accepted, because silently
 * dropping the other shape is exactly the bug this signature exists to stop:
 * a `JSON.parse` on an object throws, and a listener that returns on a parse
 * failure swallows every event the run will ever produce.
 */
export const onAnalystEvent = (fn: (ev: unknown) => void): Promise<UnlistenFn> =>
  listen<unknown>(EV_ANALYST, (e) => fn(e.payload))

/** The agent's own progress notes, kept for the panel's log drawer. */
export const onAnalystLog = (fn: (line: string) => void): Promise<UnlistenFn> =>
  listen<string>(EV_ANALYST_LOG, (e) => fn(e.payload))
