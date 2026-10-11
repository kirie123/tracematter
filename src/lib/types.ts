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

export interface GatewayConfig {
  baseUrl: string
  apiKey: string
  model: string
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

export interface AppConfig {
  workspaceRoot?: string | null
  outputDir?: string | null
  gateway: GatewayConfig
  schemas: LabelSchema[]
  activeSchemaId: string
  digest: DigestOptions
}
