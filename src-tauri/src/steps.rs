//! Step builder: turns raw transcript records into the normalised timeline the
//! viewer renders.
//!
//! One record maps to one [`Step`]. We deliberately do not split an assistant
//! record into separate "thinking" / "tool call" steps: keeping them together is
//! what makes the timeline readable, because a tool call is only interpretable
//! next to the reasoning that produced it.

use crate::model::*;
use crate::transcript::*;
use serde_json::Value;
use std::collections::BTreeSet;

pub struct Collected {
    pub steps: Vec<Step>,
    pub files: Vec<String>,
    pub bash_commands: Vec<String>,
}

/// Build the timeline. `records` is the raw transcript in file order.
pub fn build_steps(records: &[Value]) -> Collected {
    let mut steps: Vec<Step> = Vec::new();
    let mut files: BTreeSet<String> = BTreeSet::new();
    let mut bash: Vec<String> = Vec::new();
    let mut t0: Option<chrono::DateTime<chrono::FixedOffset>> = None;

    for r in records {
        let ty = record_type(r);
        if ty != "assistant" && ty != "user" && ty != "system" {
            continue;
        }
        let msg = r.get("message").cloned().unwrap_or(Value::Null);
        let ts = r.get("timestamp").and_then(|x| x.as_str()).map(|x| x.to_string());

        let parsed = ts
            .as_ref()
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok());
        if t0.is_none() {
            t0 = parsed;
        }
        let t_sec = match (t0, parsed) {
            (Some(a), Some(b)) => Some((b - a).num_milliseconds() as f64 / 1000.0),
            _ => None,
        };

        let mut step = Step {
            index: steps.len(),
            role: match ty {
                "assistant" => Role::Assistant,
                "user" => Role::User,
                _ => Role::System,
            },
            ts,
            t_sec,
            text: None,
            thinking: None,
            tool_calls: Vec::new(),
            tool_results: Vec::new(),
            usage: None,
            is_sidechain: is_sidechain(r),
            note: None,
        };

        match ty {
            "assistant" => {
                let mut texts: Vec<String> = Vec::new();
                let mut thinks: Vec<String> = Vec::new();
                for b in blocks(&msg) {
                    match b.get("type").and_then(|x| x.as_str()).unwrap_or("") {
                        "text" => {
                            let t = b.get("text").and_then(|x| x.as_str()).unwrap_or("").trim();
                            if !t.is_empty() {
                                texts.push(t.to_string());
                            }
                        }
                        "thinking" | "redacted_thinking" => {
                            let t = b
                                .get("thinking")
                                .or_else(|| b.get("text"))
                                .and_then(|x| x.as_str())
                                .unwrap_or("")
                                .trim();
                            thinks.push(if t.is_empty() {
                                "[redacted thinking]".to_string()
                            } else {
                                t.to_string()
                            });
                        }
                        "tool_use" => {
                            let name = b
                                .get("name")
                                .and_then(|x| x.as_str())
                                .unwrap_or("?")
                                .to_string();
                            let args = b.get("input").cloned().unwrap_or(Value::Null);
                            let brief = tool_brief(&name, &args);
                            if let Some(p) = tool_path(&name, &args) {
                                files.insert(p);
                            }
                            if name == "Bash" {
                                if let Some(c) = args.get("command").and_then(|x| x.as_str()) {
                                    bash.push(c.to_string());
                                }
                            }
                            step.tool_calls.push(ToolCall {
                                id: b.get("id").and_then(|x| x.as_str()).map(|x| x.to_string()),
                                name,
                                args,
                                brief,
                            });
                        }
                        _ => {}
                    }
                }
                if !texts.is_empty() {
                    step.text = Some(texts.join("\n\n"));
                }
                if !thinks.is_empty() {
                    step.thinking = Some(thinks.join("\n\n"));
                }
                let usage_node = msg.get("usage").cloned().unwrap_or(Value::Null);
                if usage_node.is_object() {
                    let g = |k: &str| usage_node.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
                    let thinking = usage_node
                        .get("output_tokens_details")
                        .and_then(|d| d.get("thinking_tokens"))
                        .and_then(|x| x.as_u64())
                        .unwrap_or(0);
                    let input = g("input_tokens");
                    let cache_read = g("cache_read_input_tokens");
                    let cache_creation = g("cache_creation_input_tokens");
                    step.usage = Some(Usage {
                        input_tokens: input,
                        output_tokens: g("output_tokens"),
                        thinking_tokens: thinking,
                        cache_read_tokens: cache_read,
                        cache_creation_tokens: cache_creation,
                        context_tokens: input + cache_read + cache_creation,
                    });
                }
            }
            "user" => {
                let mut texts: Vec<String> = Vec::new();
                for b in blocks(&msg) {
                    match b.get("type").and_then(|x| x.as_str()).unwrap_or("") {
                        "tool_result" => {
                            let mut content = String::new();
                            match b.get("content") {
                                Some(Value::String(t)) => content.push_str(t),
                                Some(Value::Array(items)) => {
                                    for it in items {
                                        if let Some(t) = it.get("text").and_then(|x| x.as_str()) {
                                            if !content.is_empty() {
                                                content.push('\n');
                                            }
                                            content.push_str(t);
                                        }
                                    }
                                }
                                _ => {}
                            }
                            step.tool_results.push(ToolResult {
                                tool_use_id: b
                                    .get("tool_use_id")
                                    .and_then(|x| x.as_str())
                                    .map(|x| x.to_string()),
                                is_error: b.get("is_error").and_then(|x| x.as_bool()).unwrap_or(false),
                                content,
                                truncated: false,
                            });
                        }
                        "text" => {
                            let t = b.get("text").and_then(|x| x.as_str()).unwrap_or("").trim();
                            if !t.is_empty() {
                                texts.push(t.to_string());
                            }
                        }
                        _ => {}
                    }
                }
                if !texts.is_empty() {
                    step.text = Some(texts.join("\n\n"));
                }

                // A `user` record means one of three things: a person typing, the
                // harness feeding tool output back, or bookkeeping. The viewer
                // shows all of them but styles them differently.
                if !step.tool_results.is_empty() {
                    if step.text.is_none() {
                        step.note = Some("observation".to_string());
                    }
                } else if r.get("isMeta").and_then(|x| x.as_bool()).unwrap_or(false) {
                    step.note = Some("meta".to_string());
                } else {
                    step.note = Some(match origin_kind(r).as_deref() {
                        Some("human") | None => "human".to_string(),
                        Some(other) => other.to_string(),
                    });
                }
            }
            _ => {}
        }

        steps.push(step);
    }

    Collected {
        steps,
        files: files.into_iter().collect(),
        bash_commands: bash,
    }
}

/// Rolling workspace state: replays the transcript and records which files exist
/// and what they contain, so the UI can answer "what did the tree look like when
/// this step ran?" without needing a VCS checkout.
pub struct WorkspaceState {
    pub files: Vec<(String, String)>,
}

pub fn reconstruct_workspace(steps: &[Step], upto: usize) -> WorkspaceState {
    use std::collections::BTreeMap;
    let mut state: BTreeMap<String, String> = BTreeMap::new();

    for step in steps.iter().take(upto.min(steps.len())) {
        for call in &step.tool_calls {
            let path = match tool_path(&call.name, &call.args) {
                Some(p) => p,
                None => continue,
            };
            let args = &call.args;
            match call.name.as_str() {
                "Write" => {
                    let content = args
                        .get("content")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    state.insert(path, content);
                }
                "Edit" => {
                    let old = args.get("old_string").and_then(|x| x.as_str()).unwrap_or("");
                    let new = args.get("new_string").and_then(|x| x.as_str()).unwrap_or("");
                    let replace_all = args
                        .get("replace_all")
                        .and_then(|x| x.as_bool())
                        .unwrap_or(false);
                    if let Some(cur) = state.get_mut(&path) {
                        if !old.is_empty() && cur.contains(old) {
                            *cur = if replace_all {
                                cur.replace(old, new)
                            } else {
                                cur.replacen(old, new, 1)
                            };
                        }
                    } else {
                        state.insert(path.clone(), new.to_string());
                    }
                }
                "MultiEdit" => {
                    let edits = args
                        .get("edits")
                        .and_then(|x| x.as_array())
                        .cloned()
                        .unwrap_or_default();
                    let entry = state.entry(path.clone()).or_default();
                    for e in edits {
                        let old = e.get("old_string").and_then(|x| x.as_str()).unwrap_or("");
                        let new = e.get("new_string").and_then(|x| x.as_str()).unwrap_or("");
                        if !old.is_empty() && entry.contains(old) {
                            *entry = entry.replacen(old, new, 1);
                        }
                    }
                }
                // Reading does not create content, but registering the path lets
                // the tree show "known but never written in this session".
                "Read" => {
                    state.entry(path).or_default();
                }
                _ => {}
            }
        }
    }

    WorkspaceState {
        files: state.into_iter().collect(),
    }
}

/// How many times each file was edited, most-edited first. Repeated edits of one
/// file are the strongest cheap signal that the agent was thrashing.
pub fn edit_counts(steps: &[Step]) -> Vec<(String, usize)> {
    let mut counts: std::collections::BTreeMap<String, usize> = Default::default();
    for step in steps {
        for call in &step.tool_calls {
            if is_edit_tool(&call.name) {
                if let Some(p) = tool_path(&call.name, &call.args) {
                    *counts.entry(p).or_insert(0) += 1;
                }
            }
        }
    }
    let mut v: Vec<(String, usize)> = counts.into_iter().collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    v
}