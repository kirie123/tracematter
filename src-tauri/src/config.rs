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
    /// Which preset (see `providers`) filled these boxes. Informational only:
    /// the endpoint is whatever `base_url` says, preset or not.
    #[serde(default)]
    pub preset: String,
    /// OpenAI-compatible base URL, e.g. `https://host/v1`.
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    /// Model ids used before, most recent first. Feeds the picker so moving
    /// between two models does not mean retyping an id.
    #[serde(default)]
    pub models: Vec<String>,
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
            preset: "deepseek".to_string(),
            base_url: "https://api.deepseek.com/v1".to_string(),
            api_key: String::new(),
            model: "deepseek-flash".to_string(),
            models: Vec::new(),
            temperature: 0.0,
            max_tokens: 1500,
            concurrency: 4,
            timeout_secs: 120,
            max_retries: 2,
            extra_headers: Vec::new(),
        }
    }
}

/// A folder the user has added to the sidebar.
///
/// The path is the identity: two rows pointing at the same directory are the
/// same project, so adding a folder twice is a no-op rather than a duplicate.
/// The name is editable and purely cosmetic.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub name: String,
    pub path: String,
    /// Pin one reader profile for this folder; `None` detects per file.
    #[serde(default)]
    pub profile: Option<String>,
}

impl Project {
    /// The folder's own name, for a project that has never been renamed.
    pub fn name_for(path: &str) -> String {
        let trimmed = path.trim_end_matches(['/', '\\']);
        let last = trimmed.rsplit(['/', '\\']).next().unwrap_or(trimmed);
        if last.is_empty() {
            trimmed.to_string()
        } else {
            last.to_string()
        }
    }

    /// Same project when two paths differ only in case or in which separator
    /// they use. Windows hands out both spellings freely.
    pub fn same_path(a: &str, b: &str) -> bool {
        a.replace('\\', "/").trim_end_matches('/').to_lowercase()
            == b.replace('\\', "/").trim_end_matches('/').to_lowercase()
    }

    pub fn new(path: &str) -> Self {
        Self {
            name: Self::name_for(path),
            path: path.to_string(),
            profile: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    /// The *active* project's folder — the one the Sessions view lists.
    ///
    /// Kept as its own field so configs written before projects existed keep
    /// working, and reconciled with the list on load so the sidebar can never
    /// disagree with the table.
    pub workspace_root: Option<String>,
    /// Folders the user has added, in the order they were added.
    #[serde(default)]
    pub projects: Vec<Project>,
    /// Where exports land by default.
    pub output_dir: Option<String>,
    pub gateway: GatewayConfig,
    /// The agent panel's settings. `alias` reads a config written by the
    /// previous build, which stored this under `analyst`.
    #[serde(default, alias = "analyst")]
    pub agent: crate::agent::AgentConfig,
    pub schemas: Vec<LabelSchema>,
    pub active_schema_id: String,
    pub digest: crate::segments::DigestOptions,
}

impl Default for AppConfig {
    fn default() -> Self {
        let schemas = builtin_schemas();
        Self {
            workspace_root: None,
            projects: Vec::new(),
            output_dir: None,
            gateway: GatewayConfig::default(),
            agent: crate::agent::AgentConfig::default(),
            active_schema_id: schemas[0].id.clone(),
            schemas,
            digest: Default::default(),
        }
    }
}

impl AppConfig {
    /// Make `projects` and `workspace_root` agree.
    ///
    /// Three cases matter: a config written before the sidebar existed (one
    /// folder, no list), a list whose active row was removed, and a list edited
    /// by hand. All three end with an active path that is in the list, or with
    /// neither.
    pub fn reconcile_projects(&mut self) {
        // A single-folder config becomes a one-row list.
        if self.projects.is_empty() {
            if let Some(root) = self.workspace_root.clone() {
                self.projects.push(Project::new(&root));
            }
        }
        // An active path that is not in the list falls back to the first row.
        let active_known = self
            .workspace_root
            .as_deref()
            .map(|r| self.projects.iter().any(|p| Project::same_path(&p.path, r)))
            .unwrap_or(false);
        if !active_known {
            self.workspace_root = self.projects.first().map(|p| p.path.clone());
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
    cfg.reconcile_projects();
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

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(root: Option<&str>, projects: Vec<Project>) -> AppConfig {
        AppConfig {
            workspace_root: root.map(|s| s.to_string()),
            projects,
            ..Default::default()
        }
    }

    #[test]
    fn a_single_folder_config_becomes_a_one_row_list() {
        let mut c = cfg(Some("C:/work/agent-logs"), Vec::new());
        c.reconcile_projects();
        assert_eq!(c.projects.len(), 1);
        assert_eq!(c.projects[0].name, "agent-logs");
        assert_eq!(c.workspace_root.as_deref(), Some("C:/work/agent-logs"));
    }

    #[test]
    fn removing_the_active_row_falls_back_to_the_first_remaining_one() {
        let mut c = cfg(
            Some("C:/gone"),
            vec![Project::new("C:/a"), Project::new("C:/b")],
        );
        c.reconcile_projects();
        assert_eq!(c.workspace_root.as_deref(), Some("C:/a"));
        assert_eq!(c.projects.len(), 2);
    }

    #[test]
    fn a_path_that_differs_only_in_case_or_separator_is_the_same_project() {
        let mut c = cfg(Some(r"c:\Work\Logs"), vec![Project::new("C:/work/logs")]);
        c.reconcile_projects();
        assert_eq!(c.projects.len(), 1, "the same folder must not be listed twice");
        assert_eq!(c.workspace_root.as_deref(), Some(r"c:\Work\Logs"));
    }

    #[test]
    fn no_folders_at_all_stays_empty() {
        let mut c = cfg(None, Vec::new());
        c.reconcile_projects();
        assert!(c.projects.is_empty());
        assert!(c.workspace_root.is_none());
    }

    #[test]
    fn a_folders_name_is_its_last_segment() {
        assert_eq!(Project::name_for("C:/a/b"), "b");
        assert_eq!(Project::name_for("C:/a/b/"), "b");
        assert_eq!(Project::name_for(r"C:\a\b"), "b");
        assert_eq!(Project::name_for("b"), "b");
        assert_eq!(Project::name_for("C:/"), "C:");
    }
}