// Mirrors src-tauri/src/model.rs. Keep the two in step: the Rust side is the
// source of truth, and every field here is serialised with camelCase.

export type Role = 'user' | 'assistant' | 'system'

export interface CostInfo {
  totalUsd?: number | null
  apiDurationMs?: number | null
  toolDurationMs?: number | null
  totalDurationMs?: number | null
  linesAdded?: number | null
  linesRemoved?: number | null
}

export interface SessionSummary {
  id: string
  file: string
  path: string
  title?: string | null
  model?: string | null
  models: string[]
  firstTs?: string | null
  lastTs?: string | null
  durationSec?: number | null
  nRecords: number
  nAssistantMsgs: number
  nThinkingBlocks: number
  inputTokens: number
  outputTokens: number
  thinkingTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  maxContextTokens: number
  toolCalls: Record<string, number>
  nToolCalls: number
  toolResults: number
  toolErrors: number
  editCalls: number
  editFailed: number
  userHuman: number
  interrupts: number
  slashCmds: number
  compactions: number
  sidechainMsgs: number
  repeatBash: number
  nFilesTouched: number
  cost?: CostInfo | null
  error?: string | null
}

export interface ToolCall {
  id?: string | null
  name: string
  args: unknown
  brief: string
}

export interface ToolResult {
  toolUseId?: string | null
  isError: boolean
  content: string
  truncated: boolean
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  thinkingTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  contextTokens: number
}

export interface Step {
  index: number
  role: Role
  ts?: string | null
  tSec?: number | null
  text?: string | null
  thinking?: string | null
  images?: number
  toolCalls: ToolCall[]
  toolResults: ToolResult[]
  usage?: Usage | null
  isSidechain: boolean
  note?: string | null
}

export interface TurnSegment {
  id: string
  session: string
  index: number
  startStep: number
  endStep: number
  title?: string | null
  userRequest: string
  digest: string
  nTools: number
  nErrors: number
  nInterrupts: number
  nThinking: number
  nAsstChars: number
  toolsUsed: Record<string, number>
  filesTouched: string[]
  firstTs?: string | null
  durationSec?: number | null
}

export interface Trace {
  summary: SessionSummary
  steps: Step[]
  turns: TurnSegment[]
  files: string[]
  bashCommands: string[]
  badLines: number
}

export interface ScanResult {
  root: string
  sessions: SessionSummary[]
  filesSeen: number
  filesFailed: number
  elapsedMs: number
}

export type FieldKind = 'enum' | 'int' | 'float' | 'bool' | 'text'

export interface LabelField {
  name: string
  kind: FieldKind
  description: string
  options: string[]
  min?: number | null
  max?: number | null
  required: boolean
}

export interface LabelSchema {
  id: string
  name: string
  instructions: string
  fields: LabelField[]
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface LabelRecord {
  id: string
  session: string
  turn: number
  title?: string | null
  nTools: number
  nErrors: number
  nInterrupts: number
  values: Record<string, unknown>
  error?: string | null
  model?: string | null
  latencyMs?: number | null
  promptTokens?: number | null
  completionTokens?: number | null
  finishedAt?: string | null
}

export interface JobProgress {
  jobId: string
  status: JobStatus
  total: number
  completed: number
  failed: number
  running: number
  message?: string | null
  startedAt?: string | null
  finishedAt?: string | null
}

/** A starting point for the model connection: endpoint, default model, where to get a key. */
export interface ProviderPreset {
  id: string
  label: string
  baseUrl: string
  defaultModel: string
  models: string[]
  keyUrl: string | null
  needsKey: boolean
  local: boolean
  note: string
}

export interface GatewayConfig {
  /** Which preset filled these boxes. Informational: the endpoint is whatever baseUrl says. */
  preset: string
  baseUrl: string
  apiKey: string
  model: string
  /** Model ids used before, most recent first. */
  models: string[]
  temperature: number
  maxTokens: number
  concurrency: number
  timeoutSecs: number
  maxRetries: number
  extraHeaders: [string, string][]
}

export interface DigestOptions {
  maxUserHead: number
  maxUserTail: number
  maxAsstHead: number
  maxAsstTail: number
  maxTools: number
  maxFiles: number
}

/** A folder of transcripts. The path is the identity; the name is cosmetic. */
export interface Project {
  name: string
  path: string
  /** Pins one reader profile for this folder; null detects per file. */
  profile?: string | null
}

/** One folder's standing in the project list. */
export interface FolderCount {
  path: string
  exists: boolean
  transcripts: number
}

export interface AppConfig {
  /** The active project's folder: the one the Sessions view lists. */
  workspaceRoot?: string | null
  /** Every folder the user has added, in the order they were added. */
  projects: Project[]
  outputDir?: string | null
  gateway: GatewayConfig
  /** The agent panel's settings. */
  agent: AgentConfig
  schemas: LabelSchema[]
  activeSchemaId: string
  digest: DigestOptions
}

// --------------------------------------------------------------------- agent

/** The agent panel's settings. No binary, and no write tools to gate. */
export interface AgentConfig {
  /** Steps of one transcript the reader tool may pull into a call. */
  maxSteps: number
  /** Tool round-trips per question. */
  maxRounds: number
  /** Ceiling on tokens per reply. */
  maxTokens: number
  /** Appended to the system prompt. */
  systemExtra: string
}

/** What the panel knows about the agent. */
export interface AgentStatus {
  running: boolean
  model: string
  endpoint: string
  /** False when no gateway is configured — the panel's one precondition. */
  ready: boolean
  rounds: number
  spendTokens: number
  error: string | null
}

/** A question handed from another view to the Analyst panel. */
export interface AnalystAsk {
  text: string
  /** A counter, so the panel can tell one handoff from the next. */
  key: number
}

/** One line from the kernel, already parsed. The shape depends on `type`. */
export interface AnalystEvent {
  type: string
  [key: string]: unknown
}

// ---------------------------------------------------------------------- data

export type DocKind = 'jsonl' | 'jsonDoc'

/** What a file looks like it is. Detection is a scored guess with a stated reason. */
export type Family =
  | 'unknown'
  | 'harveyTask'
  | 'harveyRun'
  | 'harveyScores'
  | 'evalSummary'
  | 'evalItems'
  | 'passK'
  | 'grpoCompletions'
  | 'trainerCurve'
  | 'openAiChat'
  | 'openAiChatRequest'
  | 'anthropicMessages'
  | 'claudeCode'

/** One line, with its number and its bytes. A line that does not parse is still a row. */
export interface Row {
  /** 1-based, counting every physical line including blanks. The edit anchor. */
  line: number
  /** The exact bytes of the line, without its terminator. */
  raw: string
  value: unknown | null
  error: string | null
}

export interface KeyStat {
  path: string
  types: string[]
  coverage: number
  sample: unknown
}

export interface Shape {
  keys: KeyStat[]
  sampled: number
  /** The sample is homogeneous enough that a table is the honest rendering. */
  tabular: boolean
}

/** A checksum over the file bytes, captured at open. A save against a stale one is refused. */
export interface Guard {
  len: number
  sum: number
}

export interface Document {
  path: string
  name: string
  dir: string
  kind: DocKind
  family: Family
  /** Why the family was chosen, so a wrong guess is visible. */
  probe: string[]
  bytes: number
  mtimeMs: number
  guardLen: number
  guardSum: number
  totalLines: number
  rows: Row[]
  /** Lines that failed to parse, across the whole file. */
  bad: number
  shape: Shape
  doc: unknown | null
  text: string | null
  note: string | null
}

/** Where a value lives. Covers a JSONL row and a whole-document JSON file alike. */
export type Anchor =
  | { kind: 'line'; n: number; pointer?: string | null }
  | { kind: 'pointer'; p: string }

/** One change: where, and what to put there. */
export interface Edit {
  anchor: Anchor
  value: unknown
}

export interface SetArgs {
  path: string
  /** The write target. Only ever produced by `dataFork`. */
  target: string
  /** Every change to apply, in one write. */
  edits: Edit[]
  guard: Guard
  dryRun?: boolean
  force?: boolean
}

export interface SaveResult {
  wrote: boolean
  target: string
  source: string
  bytes: number
  backup: string | null
  preview: string | null
  changedLines: number[]
}

// ------------------------------------------------------------------- parquet

export interface ParquetColumn {
  name: string
  kind: string
}

export interface ParquetPage {
  path: string
  columns: ParquetColumn[]
  totalRows: number
  rowGroups: number
  offset: number
  rows: Record<string, unknown>[]
  /** Columns whose values were shortened for this page. */
  clipped: string[]
}
