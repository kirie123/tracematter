//! Persisted application settings and the built-in labelling rubrics.
//!
//! Settings live in a single JSON file under the OS config directory so a user
//! can version or share them. Rubrics are data, not code: the same engine drives
//! every rubric, so adding a new labelling task is a matter of adding fields.

use crate::model::{FieldKind, LabelField, LabelSchema};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayConfig {
    /// OpenAI-compatible base URL, e.g. `https://host/v1`.
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub temperature: f64,
    pub max_tokens: u32,
    /// How many requests to keep in flight. Gateways rate-limit, so this stays
    /// explicit rather than "as many as possible".
    pub concurrency: usize,
    pub timeout_secs: u64,
    pub max_retries: u32,
    /// Extra headers, for gateways behind an organisation proxy.
    #[serde(default)]
    pub extra_headers: Vec<(String, String)>,
}

impl Default for GatewayConfig {
    fn default() -> Self {
        Self {
            base_url: "http://localhost:8000/v1".to_string(),
            api_key: String::new(),
            model: "gpt-4o-mini".to_string(),
            temperature: 0.0,
            max_tokens: 1500,
            concurrency: 4,
            timeout_secs: 120,
            max_retries: 2,
            extra_headers: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    /// Last directory scanned for transcripts.
    pub workspace_root: Option<String>,
    /// Where exports land by default.
    pub output_dir: Option<String>,
    pub gateway: GatewayConfig,
    pub schemas: Vec<LabelSchema>,
    pub active_schema_id: String,
    pub digest: crate::segments::DigestOptions,
}

impl Default for AppConfig {
    fn default() -> Self {
        let schemas = builtin_schemas();
        Self {
            workspace_root: None,
            output_dir: None,
            gateway: GatewayConfig::default(),
            active_schema_id: schemas[0].id.clone(),
            schemas,
            digest: Default::default(),
        }
    }
}

pub fn config_path() -> PathBuf {
    let dir = dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("tracematter");
    dir.join("config.json")
}

pub fn load() -> AppConfig {
    let path = config_path();
    let mut cfg: AppConfig = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();

    // Keep the built-in rubrics available even after a user edits their config,
    // and never let a stale `active_schema_id` point at nothing.
    for s in builtin_schemas() {
        if !cfg.schemas.iter().any(|x| x.id == s.id && x.name == s.name && x.instructions != s.instructions) {
            if let Some(existing) = cfg.schemas.iter_mut().find(|x| x.id == s.id) {
                if existing.fields.is_empty() {
                    *existing = s;
                }
            } else {
                cfg.schemas.push(s);
            }
        }
    }
    if !cfg.schemas.iter().any(|s| s.id == cfg.active_schema_id) {
        if let Some(first) = cfg.schemas.first() {
            cfg.active_schema_id = first.id.clone();
        }
    }
    cfg
}

pub fn save(cfg: &AppConfig) -> Result<()> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let text = serde_json::to_string_pretty(cfg)?;
    std::fs::write(&path, text).with_context(|| format!("write {}", path.display()))?;
    Ok(())
}

fn field(name: &str, kind: FieldKind, description: &str) -> LabelField {
    LabelField {
        name: name.to_string(),
        kind,
        description: description.to_string(),
        options: Vec::new(),
        min: None,
        max: None,
        required: true,
    }
}

fn enum_field(name: &str, description: &str, options: &[&str]) -> LabelField {
    let mut f = field(name, FieldKind::Enum, description);
    f.options = options.iter().map(|s| s.to_string()).collect();
    f
}

fn int_field(name: &str, description: &str, min: f64, max: f64) -> LabelField {
    let mut f = field(name, FieldKind::Int, description);
    f.min = Some(min);
    f.max = Some(max);
    f
}

/// Turn quality: the rubric this tool was built around. It asks for the four
/// things that actually decide whether a turn belongs in a training set —
/// what kind of work it was, whether it finished, how much it thrashed, and
/// whether it is worth imitating — plus a citable reason.
pub fn turn_quality_schema() -> LabelSchema {
    let mut confidence = field("confidence", FieldKind::Float, "How certain the judgement is, 0 to 1.");
    confidence.min = Some(0.0);
    confidence.max = Some(1.0);

    LabelSchema {
        id: "turn-quality".to_string(),
        name: "Turn quality (SFT curation)".to_string(),
        instructions: "You are auditing one turn of an autonomous coding agent so we can decide \
whether its trajectories are worth turning into supervised fine-tuning data.\n\n\
Judge on evidence in the digest, never on style. Signals that matter:\n\
- verified success (tests, builds, commands returning cleanly) vs unverified claims\n\
- thrashing: the same file re-edited repeatedly, the same failing command retried, long detours, the human interrupting\n\
- scope discipline: did the agent do what was asked, or drift and over-engineer?\n\
- unfinished threads: TODOs left behind, \"I will now...\" with no next action, work blocked on user input\n\n\
Return strict JSON matching the schema."
            .to_string(),
        fields: vec![
            enum_field(
                "task_type",
                "What kind of work the agent was doing this turn.",
                &["code_edit", "debug", "research", "planning", "ops", "question", "mixed"],
            ),
            enum_field(
                "outcome",
                "completed = request fully satisfied; partial = real progress but unfinished; \
blocked = hit a wall or needs the human; abandoned = dropped without resolution.",
                &["completed", "partial", "blocked", "abandoned"],
            ),
            int_field(
                "struggle",
                "0 = clean single pass; 1 = minor backtrack; 2 = clear thrashing (repeated failed \
commands, re-edits of the same file); 3 = badly lost.",
                0.0,
                3.0,
            ),
            field(
                "sft_worthy",
                FieldKind::Bool,
                "True only if the turn is a clean, correct, non-redundant demonstration worth imitating.",
            ),
            confidence,
            field(
                "reason",
                FieldKind::Text,
                "One sentence citing concrete evidence from the digest.",
            ),
        ],
    }
}

/// Conversation review: the rubric for judging assistant *replies* rather than
/// agent work. Useful when the transcripts come from a chat product.
pub fn reply_quality_schema() -> LabelSchema {
    let mut confidence = field("confidence", FieldKind::Float, "How certain the judgement is, 0 to 1.");
    confidence.min = Some(0.0);
    confidence.max = Some(1.0);
    let mut usefulness = int_field("usefulness", "How well the reply served the request, 1 to 5.", 1.0, 5.0);
    usefulness.required = true;

    LabelSchema {
        id: "reply-quality".to_string(),
        name: "Reply quality (conversation review)".to_string(),
        instructions: "You are reviewing one assistant reply for a training-data pipeline.\n\n\
Judge the reply against the user's actual request. Reward: answering what was asked, \
concrete over generic, admitting uncertainty, correct formatting. Penalise: \
hallucinated specifics, padding, ignoring parts of the request, sycophancy.\n\n\
Return strict JSON matching the schema."
            .to_string(),
        fields: vec![
            enum_field(
                "intent",
                "What the user was after.",
                &["information", "how_to", "code", "troubleshooting", "decision", "smalltalk"],
            ),
            field("answered", FieldKind::Bool, "Did the reply actually answer the request?"),
            usefulness,
            field(
                "hallucination_risk",
                FieldKind::Bool,
                "True if the reply asserts specifics that the digest does not support.",
            ),
            confidence,
            field("reason", FieldKind::Text, "One sentence citing concrete evidence."),
        ],
    }
}

/// Task compliance: the rubric for graders — did the run satisfy an explicit
/// checklist? Habits from rubric-based evaluation, but pointed at transcripts.
pub fn task_compliance_schema() -> LabelSchema {
    let mut conf = field("confidence", FieldKind::Float, "How certain the judgement is, 0 to 1.");
    conf.min = Some(0.0);
    conf.max = Some(1.0);
    LabelSchema {
        id: "task-compliance".to_string(),
        name: "Task compliance (checklist grading)".to_string(),
        instructions: "Decide whether this agent turn satisfies the stated request, and produce a \
short checklist of the concrete requirements you can verify from the digest.\n\n\
Only mark a requirement satisfied when the digest shows the evidence. Anything you \
cannot verify counts as unverified, not as satisfied.\n\n\
Return strict JSON matching the schema."
            .to_string(),
        fields: vec![
            field("requirements_met", FieldKind::Text, "Newline-separated list of requirements that were verifiably met."),
            field("requirements_missed", FieldKind::Text, "Newline-separated list of requirements that were missed or unverifiable."),
            enum_field("verdict", "Overall verdict.", &["pass", "partial", "fail"]),
            conf,
            field("evidence", FieldKind::Text, "The single strongest piece of evidence in the digest."),
        ],
    }
}

pub fn builtin_schemas() -> Vec<LabelSchema> {
    vec![
        turn_quality_schema(),
        reply_quality_schema(),
        task_compliance_schema(),
    ]
}