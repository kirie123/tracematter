//! Transcript reader.
//!
//! Agent harnesses stream a session to disk as newline-delimited JSON, where
//! every line is one event (an assistant message, a tool result, a title, a
//! cost report, …). The exact event vocabulary differs per harness, so parsing
//! is isolated here: the rest of the app only ever sees [`Step`]s.
//!
//! This module owns the *Claude Code* dialect. Adding another harness means
//! adding a sibling module that produces the same [`Trace`] shape.

use crate::model::*;
use anyhow::{Context, Result};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

/// Tools that mutate the workspace. Used for "did this turn actually change
/// anything?" style filters, which are far more useful than raw call counts.
pub const EDIT_TOOLS: [&str; 5] = ["Edit", "MultiEdit", "Write", "NotebookEdit", "str_replace_editor"];

pub fn is_edit_tool(name: &str) -> bool {
    EDIT_TOOLS.contains(&name)
}

/// Read a transcript file into raw JSON values. Unparsable lines are counted
/// rather than dropped silently, because a truncated tail is a real signal that
/// the session was killed mid-write.
pub fn read_records(path: &Path) -> Result<(Vec<Value>, u64)> {
    let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let reader = BufReader::with_capacity(1 << 20, file);
    let mut out = Vec::new();
    let mut bad = 0u64;
    for line in reader.lines() {
        let line = line?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(trimmed) {
            Ok(v) => out.push(v),
            Err(_) => bad += 1,
        }
    }
    Ok((out, bad))
}

fn s(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(|x| x.to_string())
}

fn u(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(|x| x.as_u64()).unwrap_or(0)
}

fn f(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(|x| x.as_f64())
}

/// Content blocks of a message, ignoring string-content messages which carry no
/// structured blocks.
pub fn blocks(msg: &Value) -> Vec<&Value> {
    match msg.get("content") {
        Some(Value::Array(items)) => items.iter().filter(|b| b.is_object()).collect(),
        _ => Vec::new(),
    }
}

/// Flat text of a message, whatever shape its content takes.
pub fn message_text(msg: &Value) -> String {
    match msg.get("content") {
        Some(Value::String(t)) => t.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

pub fn record_type(v: &Value) -> &str {
    v.get("type").and_then(|t| t.as_str()).unwrap_or("")
}

pub fn is_sidechain(v: &Value) -> bool {
    v.get("isSidechain").and_then(|b| b.as_bool()).unwrap_or(false)
}

pub fn origin_kind(v: &Value) -> Option<String> {
    v.get("origin")
        .and_then(|o| o.get("kind"))
        .and_then(|k| k.as_str())
        .map(|k| k.to_string())
}

/// A short, human-readable rendering of a tool call. Kept in Rust so that
/// digests, the timeline and the terminal panel all describe a call identically.
pub fn tool_brief(name: &str, args: &Value) -> String {
    let arg = |k: &str| args.get(k).and_then(|x| x.as_str()).unwrap_or("");
    let clip = |t: &str, n: usize| -> String {
        let t = t.replace('\n', " ");
        if t.chars().count() <= n {
            t
        } else {
            t.chars().take(n).collect::<String>() + "…"
        }
    };
    match name {
        "Bash" => format!("Bash: {}", clip(arg("command"), 110)),
        "Read" | "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => {
            let p = arg("file_path");
            let p = if p.is_empty() { arg("notebook_path") } else { p };
            let base = Path::new(p)
                .file_name()
                .map(|x| x.to_string_lossy().to_string())
                .unwrap_or_else(|| p.to_string());
            format!("{name}: {base}")
        }
        "Grep" => format!("Grep: {}", clip(arg("pattern"), 60)),
        "Glob" => format!("Glob: {}", clip(arg("pattern"), 60)),
        "Agent" | "Task" => format!("{name}: {}", clip(arg("description"), 60)),
        "WebFetch" => format!("WebFetch: {}", clip(arg("url"), 70)),
        "WebSearch" => format!("WebSearch: {}", clip(arg("query"), 70)),
        "TodoWrite" => "TodoWrite".to_string(),
        _ => name.to_string(),
    }
}

/// Paths a tool call touched, if any.
pub fn tool_path(name: &str, args: &Value) -> Option<String> {
    let keys: &[&str] = match name {
        "Write" | "Edit" | "MultiEdit" | "Read" | "NotebookEdit" => {
            &["file_path", "notebook_path", "path"]
        }
        _ => &["file_path", "path"],
    };
    for k in keys {
        if let Some(v) = args.get(*k).and_then(|x| x.as_str()) {
            if name == "Read" || is_edit_tool(name) {
                return Some(v.to_string());
            }
        }
    }
    None
}

/// Scan a directory for candidate transcript files, newest first.
pub fn list_transcripts(root: &Path) -> Result<Vec<PathBuf>> {
    let mut found = Vec::new();
    if root.is_file() {
        found.push(root.to_path_buf());
        return Ok(found);
    }
    for entry in std::fs::read_dir(root).with_context(|| format!("read_dir {}", root.display()))? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            // One level of nesting covers the common `<project>/<session>.jsonl`
            // and `<root>/<agent>/<run>.jsonl` layouts without unbounded walks.
            if let Ok(inner) = std::fs::read_dir(&path) {
                for e2 in inner.flatten() {
                    let p2 = e2.path();
                    if p2.is_file() && has_transcript_ext(&p2) {
                        found.push(p2);
                    }
                }
            }
            continue;
        }
        if has_transcript_ext(&path) {
            found.push(path);
        }
    }
    found.sort();
    Ok(found)
}

fn has_transcript_ext(p: &Path) -> bool {
    matches!(
        p.extension().and_then(|e| e.to_str()).unwrap_or(""),
        "jsonl" | "json"
    )
}

/// Cheap pass over a transcript: everything the sessions table needs, without
/// building steps. This runs for every file on every scan, so it stays O(n) in
/// records and does no allocation beyond the summary itself.
pub fn summarize(records: &[Value], id: String, file: String, path: String) -> SessionSummary {
    let mut m = SessionSummary {
        id,
        file,
        path,
        ..Default::default()
    };
    m.n_records = records.len() as u64;

    let mut models: BTreeMap<String, u64> = BTreeMap::new();
    let mut files_touched: BTreeSet<String> = BTreeSet::new();
    let mut bash_cmds: Vec<String> = Vec::new();
    let mut edit_ids: HashSet<String> = HashSet::new();
    let mut ts_min: Option<String> = None;
    let mut ts_max: Option<String> = None;

    for r in records {
        if let Some(ts) = s(r, "timestamp") {
            if ts_min.as_deref().map(|x| ts.as_str() < x).unwrap_or(true) {
                ts_min = Some(ts.clone());
            }
            if ts_max.as_deref().map(|x| ts.as_str() > x).unwrap_or(true) {
                ts_max = Some(ts);
            }
        }
        let ty = record_type(r);

        if ty == "ai-title" {
            if let Some(t) = s(r, "aiTitle") {
                m.title = Some(t);
            }
        }
        if is_sidechain(r) && (ty == "user" || ty == "assistant") {
            m.sidechain_msgs += 1;
        }

        match ty {
            "assistant" if !is_sidechain(r) => {
                let msg = r.get("message").cloned().unwrap_or(Value::Null);
                if let Some(model) = s(&msg, "model") {
                    if model != "<synthetic>" {
                        *models.entry(model).or_insert(0) += 1;
                        m.n_assistant_msgs += 1;
                    }
                }
                let usage = msg.get("usage").cloned().unwrap_or(Value::Null);
                let it = u(&usage, "input_tokens");
                let ot = u(&usage, "output_tokens");
                let cr = u(&usage, "cache_read_input_tokens");
                let cc = u(&usage, "cache_creation_input_tokens");
                m.input_tokens += it;
                m.output_tokens += ot;
                m.cache_read_tokens += cr;
                m.cache_creation_tokens += cc;
                if let Some(th) = usage
                    .get("output_tokens_details")
                    .and_then(|d| d.get("thinking_tokens"))
                    .and_then(|x| x.as_u64())
                {
                    m.thinking_tokens += th;
                }
                m.max_context_tokens = m.max_context_tokens.max(it + cr + cc);

                for b in blocks(&msg) {
                    match b.get("type").and_then(|x| x.as_str()).unwrap_or("") {
                        "thinking" => m.n_thinking_blocks += 1,
                        "tool_use" => {
                            let name = b
                                .get("name")
                                .and_then(|x| x.as_str())
                                .unwrap_or("?")
                                .to_string();
                            *m.tool_calls.entry(name.clone()).or_insert(0) += 1;
                            let args = b.get("input").cloned().unwrap_or(Value::Null);
                            if is_edit_tool(&name) {
                                if let Some(id) = b.get("id").and_then(|x| x.as_str()) {
                                    edit_ids.insert(id.to_string());
                                }
                            }
                            if name == "Bash" {
                                let cmd = args
                                    .get("command")
                                    .and_then(|x| x.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                bash_cmds.push(cmd.chars().take(300).collect());
                            }
                            if let Some(p) = tool_path(&name, &args) {
                                files_touched.insert(p);
                            }
                        }
                        _ => {}
                    }
                }
            }
            "user" if !is_sidechain(r) => {
                let msg = r.get("message").cloned().unwrap_or(Value::Null);
                for b in blocks(&msg) {
                    match b.get("type").and_then(|x| x.as_str()).unwrap_or("") {
                        "tool_result" => {
                            m.tool_results += 1;
                            if b.get("is_error").and_then(|x| x.as_bool()).unwrap_or(false) {
                                m.tool_errors += 1;
                            }
                        }
                        "text" => {
                            let t = b.get("text").and_then(|x| x.as_str()).unwrap_or("");
                            if t.contains("[Request interrupted") {
                                m.interrupts += 1;
                            }
                            if t.trim_start().starts_with("<command-name>") {
                                m.slash_cmds += 1;
                            }
                            if t.contains("This session is being continued from a previous conversation") {
                                m.compactions += 1;
                            }
                        }
                        _ => {}
                    }
                }
                match origin_kind(r).as_deref() {
                    Some("human") | None => {
                        if !r.get("isMeta").and_then(|x| x.as_bool()).unwrap_or(false) {
                            m.user_human += 1;
                        }
                    }
                    _ => {}
                }
            }
            "cost-state" => {
                let mut c = CostInfo {
                    total_usd: f(r, "totalCostUSD"),
                    api_duration_ms: f(r, "totalAPIDurationWithoutRetries"),
                    tool_duration_ms: f(r, "totalToolDuration"),
                    total_duration_ms: f(r, "totalDuration"),
                    lines_added: r.get("totalLinesAdded").and_then(|x| x.as_i64()),
                    lines_removed: r.get("totalLinesRemoved").and_then(|x| x.as_i64()),
                };
                if c.total_usd.is_none() {
                    c.total_usd = f(r, "totalCost");
                }
                m.cost = Some(c);
            }
            _ => {}
        }
    }

    // Retried commands are the cheapest available thrash signal: identical
    // command text appearing more than once means the first attempt did not
    // settle the question.
    let mut counts: BTreeMap<&str, u64> = BTreeMap::new();
    for c in &bash_cmds {
        *counts.entry(c.as_str()).or_insert(0) += 1;
    }
    m.repeat_bash = counts.values().filter(|v| **v > 1).map(|v| v - 1).sum();

    // Edit failures are the most actionable error class, so they are counted
    // separately from the general tool error tally.
    m.edit_calls = edit_ids.len() as u64;
    let mut edit_failed = 0u64;
    for r in records.iter() {
        if record_type(r) != "user" || is_sidechain(r) {
            continue;
        }
        let msg = r.get("message").cloned().unwrap_or(Value::Null);
        for b in blocks(&msg) {
            if b.get("type").and_then(|x| x.as_str()) != Some("tool_result") {
                continue;
            }
            if !b.get("is_error").and_then(|x| x.as_bool()).unwrap_or(false) {
                continue;
            }
            if let Some(id) = b.get("tool_use_id").and_then(|x| x.as_str()) {
                if edit_ids.contains(id) {
                    edit_failed += 1;
                }
            }
        }
    }
    m.edit_failed = edit_failed;

    m.n_tool_calls = m.tool_calls.values().sum();
    m.n_files_touched = files_touched.len() as u64;
    m.models = models.keys().cloned().collect();
    m.model = models
        .iter()
        .max_by_key(|(_, v)| **v)
        .map(|(k, _)| k.clone());
    m.first_ts = ts_min;
    m.last_ts = ts_max;
    m.duration_sec = duration_between(&m.first_ts, &m.last_ts);
    m
}

/// Parse an RFC3339 pair into a duration. Timestamps in transcripts are UTC.
pub fn duration_between(a: &Option<String>, b: &Option<String>) -> Option<f64> {
    let (a, b) = (a.as_ref()?, b.as_ref()?);
    let pa = chrono::DateTime::parse_from_rfc3339(a).ok()?;
    let pb = chrono::DateTime::parse_from_rfc3339(b).ok()?;
    let d = pb.signed_duration_since(pa);
    Some(d.num_milliseconds() as f64 / 1000.0)
}

/// Session id: the harness writes it on most records; fall back to the filename
/// stem so that grouping never collapses distinct sessions into one bucket.
pub fn session_id(records: &[Value], path: &Path) -> String {
    for r in records {
        if let Some(id) = s(r, "sessionId") {
            return id;
        }
    }
    path.file_stem()
        .map(|x| x.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}