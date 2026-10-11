//! Domain model shared by the parser, the metrics pass, the labelling engine and
//! the frontend. Everything here serialises with camelCase so the TypeScript
//! side can mirror it one-for-one.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// Cost + output accounting the harness reports at the end of a session.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostInfo {
    pub total_usd: Option<f64>,
    pub api_duration_ms: Option<f64>,
    pub tool_duration_ms: Option<f64>,
    pub total_duration_ms: Option<f64>,
    pub lines_added: Option<i64>,
    pub lines_removed: Option<i64>,
}

/// Everything we can know about a session without materialising its steps.
/// This is what the sessions table renders, so it must stay cheap to compute.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub file: String,
    /// Absolute path on disk, so the UI can open a trace without re-scanning.
    pub path: String,
    pub title: Option<String>,
    pub model: Option<String>,
    pub models: Vec<String>,

    pub first_ts: Option<String>,
    pub last_ts: Option<String>,
    pub duration_sec: Option<f64>,

    pub n_records: u64,
    pub n_assistant_msgs: u64,
    pub n_thinking_blocks: u64,

    pub input_tokens: u64,
    pub output_tokens: u64,
    pub thinking_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    /// Peak prompt size (fresh input + cache read + cache write) seen in the run.
    pub max_context_tokens: u64,

    pub tool_calls: BTreeMap<String, u64>,
    pub n_tool_calls: u64,
    pub tool_results: u64,
    pub tool_errors: u64,

    pub edit_calls: u64,
    pub edit_failed: u64,

    pub user_human: u64,
    pub interrupts: u64,
    pub slash_cmds: u64,
    pub compactions: u64,
    pub sidechain_msgs: u64,
    pub repeat_bash: u64,
    pub n_files_touched: u64,

    pub cost: Option<CostInfo>,
    /// Populated when the file could not be parsed at all.
    pub error: Option<String>,
}

impl SessionSummary {
    /// Share of tool results that came back as errors. `None` when the session
    /// never ran a tool, which keeps the UI from printing a misleading 0%.
    pub fn error_rate(&self) -> Option<f64> {
        if self.tool_results == 0 {
            None
        } else {
            Some(self.tool_errors as f64 / self.tool_results as f64)
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: Option<String>,
    pub name: String,
    /// Raw tool input, kept structured so the UI can render per-tool views.
    pub args: Value,
    /// One-line rendering used in digests and compact lists.
    pub brief: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub tool_use_id: Option<String>,
    pub is_error: bool,
    pub content: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub thinking_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    /// input + cache read + cache write: the real size of the prompt.
    pub context_tokens: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
    System,
}

/// One record from the transcript, normalised. A single assistant record can
/// carry text, thinking and several tool calls at once, so we keep them together
/// rather than exploding into artificial sub-steps.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub index: usize,
    pub role: Role,
    pub ts: Option<String>,
    /// Seconds since the first timestamped record in the session.
    pub t_sec: Option<f64>,
    pub text: Option<String>,
    pub thinking: Option<String>,
    pub tool_calls: Vec<ToolCall>,
    pub tool_results: Vec<ToolResult>,
    pub usage: Option<Usage>,
    pub is_sidechain: bool,
    /// Why this record is not part of the main thread (meta, command wrapper…).
    pub note: Option<String>,
}

impl Step {
    pub fn has_error(&self) -> bool {
        self.tool_results.iter().any(|r| r.is_error)
    }
}

/// A turn = everything the agent did between two human messages. Turns are the
/// unit we label, because quality is only meaningful relative to a request.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnSegment {
    pub id: String,
    pub session: String,
    pub index: usize,
    pub start_step: usize,
    pub end_step: usize,
    pub title: Option<String>,
    pub user_request: String,
    /// Lossy, self-describing excerpt used as the model input.
    pub digest: String,
    pub n_tools: usize,
    pub n_errors: usize,
    pub n_interrupts: usize,
    pub n_thinking: usize,
    pub n_asst_chars: usize,
    pub tools_used: BTreeMap<String, usize>,
    pub files_touched: Vec<String>,
    pub first_ts: Option<String>,
    pub duration_sec: Option<f64>,
}

/// A fully parsed session: summary + steps + derived turns.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trace {
    pub summary: SessionSummary,
    pub steps: Vec<Step>,
    pub turns: Vec<TurnSegment>,
    pub files: Vec<String>,
    pub bash_commands: Vec<String>,
    /// Unparsable lines, reported instead of silently dropped.
    pub bad_lines: u64,
}

// ---------------------------------------------------------------------------
// Labelling
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FieldKind {
    Enum,
    Int,
    Float,
    Bool,
    Text,
}

/// A single field of a labelling rubric. The set of fields *is* the schema the
/// model is forced to answer with.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelField {
    pub name: String,
    pub kind: FieldKind,
    pub description: String,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
    #[serde(default = "default_true")]
    pub required: bool,
}

fn default_true() -> bool {
    true
}

/// A named labelling rubric: instructions + fields. Stored as JSON so users can
/// share and version them alongside their datasets.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelSchema {
    pub id: String,
    pub name: String,
    pub instructions: String,
    pub fields: Vec<LabelField>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Queued,
    Running,
    Done,
    Failed,
    Cancelled,
}

/// One labelled turn. `values` holds the model answer keyed by field name;
/// `error` holds the failure reason when the call never produced one.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelRecord {
    pub id: String,
    pub session: String,
    pub turn: usize,
    pub title: Option<String>,
    pub n_tools: usize,
    pub n_errors: usize,
    pub n_interrupts: usize,
    pub values: BTreeMap<String, Value>,
    pub error: Option<String>,
    pub model: Option<String>,
    pub latency_ms: Option<f64>,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub finished_at: Option<String>,
}

/// Progress event payload pushed to the frontend while a batch runs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    pub job_id: String,
    pub status: JobStatus,
    pub total: usize,
    pub completed: usize,
    pub failed: usize,
    pub running: usize,
    /// Most recent line worth showing in the activity log.
    pub message: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

/// Result of scanning a directory for sessions.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub root: String,
    pub sessions: Vec<SessionSummary>,
    pub files_seen: usize,
    pub files_failed: usize,
    pub elapsed_ms: f64,
}