//! The agent panel: a conversation with the gateway already configured for
//! labelling, with read-only tools over the folders this app reads.
//!
//! This replaces the old `analyst.rs`, which launched an external `pi` binary
//! and talked to it over a loopback bridge. That design meant the panel did
//! nothing at all unless the binary happened to be installed — and it was a
//! second implementation of "read a transcript", kept in step with the first by
//! hand. Here the tools call the same Rust functions the UI calls, and there is
//! no external process to be missing.
//!
//! The event vocabulary on `agent:event` is kept identical to the one the panel
//! already knew (`message_update` with `text_delta`/`thinking_delta`,
//! `tool_execution_start`/`_update`/`_end`, `turn_end`, `agent_end`), so the
//! renderer in `components/Analyst.tsx` needed no rework.

use crate::config::{self, GatewayConfig};
use crate::gateway::Gateway;
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

pub const EV_AGENT: &str = "agent:event";
pub const EV_AGENT_LOG: &str = "agent:log";

/// How many tool round-trips one question may take before we stop and answer
/// with what we have. A reader that loops is worse than one that gives up.
const MAX_TOOL_ROUNDS: usize = 6;

/// Characters of a file handed to the model for a tool result. Enough to read a
/// record, far short of a whole transcript.
const TOOL_RESULT_CHARS: usize = 8000;

/// Characters of a search hit line kept.
const HIT_CHARS: usize = 240;

/// Extensions a data-read tool may touch. Anything else is refused, so asking
/// the agent to `summarize` a `.docx` is an error rather than a hang.
const READABLE: [&str; 4] = ["json", "jsonl", "ndjson", "parquet"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    /// Steps of one transcript the `read_trace` tool may pull into a call.
    #[serde(default = "default_max_steps")]
    pub max_steps: usize,
    /// Tool round-trips per question.
    #[serde(default = "default_max_rounds")]
    pub max_rounds: usize,
    /// Ceiling on tokens per reply.
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    /// Appended to the system prompt.
    #[serde(default)]
    pub system_extra: String,
}

fn default_max_steps() -> usize {
    120
}
fn default_max_rounds() -> usize {
    MAX_TOOL_ROUNDS
}
fn default_max_tokens() -> u32 {
    1500
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            max_steps: default_max_steps(),
            max_rounds: default_max_rounds(),
            max_tokens: default_max_tokens(),
            system_extra: String::new(),
        }
    }
}

/// What the panel knows about the agent.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub running: bool,
    pub model: String,
    pub endpoint: String,
    /// False when no gateway is configured, which is the panel's one real
    /// precondition.
    pub ready: bool,
    pub rounds: usize,
    pub spend_tokens: u64,
    pub error: Option<String>,
}

#[derive(Debug, Default)]
struct Session {
    messages: Vec<Value>,
    cancel: Option<Arc<AtomicBool>>,
    spend: u64,
}

#[derive(Default)]
pub struct AgentState {
    sessions: Mutex<HashMap<String, Session>>,
    logs: Mutex<Vec<String>>,
}

impl AgentState {
    fn log(&self, app: &AppHandle, line: impl Into<String>) {
        let line = line.into();
        if let Ok(mut l) = self.logs.lock() {
            l.push(line.clone());
            let n = l.len();
            if n > 200 {
                l.drain(0..n - 200);
            }
        }
        let _ = app.emit(EV_AGENT_LOG, line);
    }
}

fn err(e: impl std::fmt::Display) -> String {
    format!("{e:#}")
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

/// Tool schemas, as the OpenAI chat-completions `tools` array.
fn tool_defs() -> Value {
    json!([
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read a JSON, JSONL or parquet file's shape and first rows. Use this to look at a dataset before answering questions about it.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Absolute path to the file." },
                        "limit": { "type": "integer", "description": "How many records to return (default 20, max 200)." }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "read_lines",
                "description": "Read a specific range of lines from a JSONL file, in full. Use after read_file when you need the complete text of a record.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" },
                        "from": { "type": "integer", "description": "First line, 1-based." },
                        "to": { "type": "integer", "description": "Last line, inclusive." }
                    },
                    "required": ["path", "from", "to"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "search",
                "description": "Search JSON/JSONL files under a folder for a string, and return the matching lines.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string" },
                        "root": { "type": "string", "description": "Folder to search. Omit for the active project." },
                        "max_hits": { "type": "integer", "description": "Default 40." }
                    },
                    "required": ["query"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "list_files",
                "description": "List the JSON/JSONL/parquet files under a folder, with sizes. Use this to find out what data exists.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "root": { "type": "string", "description": "Folder to list. Omit for the active project." }
                    }
                }
            }
        }
    ])
}

/// Refuse a path whose extension is not one a data reader should open.
fn check_readable(path: &std::path::Path) -> Result<()> {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if !READABLE.contains(&ext.as_str()) {
        return Err(anyhow!(
            "{} is a .{} file - this reader only opens {}",
            path.display(),
            ext,
            READABLE.join(", ")
        ));
    }
    let meta = std::fs::metadata(path)?;
    if meta.len() > 512 * 1024 * 1024 {
        return Err(anyhow!("{} is {} bytes, too large to read", path.display(), meta.len()));
    }
    Ok(())
}

/// A clipped JSON rendering, so one enormous record cannot fill the context.
fn clip_json(v: &Value, max: usize) -> String {
    let s = serde_json::to_string_pretty(v).unwrap_or_else(|_| String::from("<unrenderable>"));
    if s.len() <= max {
        return s;
    }
    format!("{}…\n[{} of {} chars shown]", &s[..max], max, s.len())
}

fn read_file_tool(path: &str, limit: usize) -> Result<String> {
    let p = std::path::PathBuf::from(path);
    check_readable(&p)?;
    let lim = limit.clamp(1, 200);
    let doc = crate::data::open(&p, lim)?;
    let mut out = format!(
        "{} · {:?} · {:?} · {} bytes · {} lines\n",
        doc.name, doc.kind, doc.family, doc.bytes, doc.total_lines
    );
    out.push_str(&format!("probe: {}\n", doc.probe.join("; ")));
    if !doc.shape.keys.is_empty() {
        out.push_str("\nkeys (path, types, coverage):\n");
        for k in doc.shape.keys.iter().take(40) {
            out.push_str(&format!(
                "  {} [{}] {:.0}%\n",
                k.path,
                k.types.join("|"),
                k.coverage * 100.0
            ));
        }
    }
    if doc.rows.is_empty() {
        if let Some(d) = &doc.doc {
            out.push_str("\ndocument:\n");
            out.push_str(&clip_json(d, TOOL_RESULT_CHARS));
        }
    } else {
        out.push_str(&format!("\nfirst {} records:\n", doc.rows.len()));
        for r in doc.rows.iter().take(lim) {
            match &r.value {
                Some(v) => out.push_str(&format!("  {}: {}\n", r.line, clip_json(v, 900))),
                None => out.push_str(&format!("  {}: <unparseable: {}>\n", r.line, r.error.clone().unwrap_or_default())),
            }
            if out.len() > TOOL_RESULT_CHARS {
                out.push_str("\n… more records exist; raise limit or use read_lines\n");
                break;
            }
        }
    }
    Ok(crate::gateway::truncate(&out, TOOL_RESULT_CHARS))
}

fn read_lines_tool(path: &str, from: u32, to: u32) -> Result<String> {
    let p = std::path::PathBuf::from(path);
    check_readable(&p)?;
    if to < from {
        return Err(anyhow!("`to` is before `from`"));
    }
    // Guard against a single call pulling a whole big file.
    let span = (to - from + 1).min(400);
    let mut out = String::new();
    for n in from..from + span {
        match crate::data::row_at(&p, n) {
            Ok(r) => {
                out.push_str(&format!("{n}: {}\n", r.raw));
            }
            Err(_) => break,
        }
        if out.len() > TOOL_RESULT_CHARS {
            out.push_str("… truncated\n");
            break;
        }
    }
    if out.is_empty() {
        return Err(anyhow!("no lines in that range"));
    }
    Ok(out)
}

fn search_tool(root: &str, query: &str, max_hits: usize) -> Result<String> {
    let root = std::path::PathBuf::from(root);
    if !root.exists() {
        return Err(anyhow!("{} does not exist", root.display()));
    }
    let needle = query.to_lowercase();
    let mut hits: Vec<String> = Vec::new();
    let mut scanned = 0usize;

    walk(&root, &mut |p| {
        if hits.len() >= max_hits || scanned > 4000 {
            return;
        }
        scanned += 1;
        let Ok(f) = std::fs::File::open(p) else { return };
        use std::io::BufRead;
        for (i, line) in std::io::BufReader::new(f).lines().enumerate() {
            let Ok(l) = line else { break };
            if l.to_lowercase().contains(&needle) {
                hits.push(format!(
                    "{}:{}: {}",
                    p.display(),
                    i + 1,
                    crate::gateway::truncate(&l, HIT_CHARS)
                ));
                if hits.len() >= max_hits {
                    break;
                }
            }
        }
    });

    if hits.is_empty() {
        return Ok(format!("no match for `{query}` under {}", root.display()));
    }
    Ok(hits.join("\n"))
}

fn list_files_tool(root: &str) -> Result<String> {
    let root = std::path::PathBuf::from(root);
    if !root.exists() {
        return Err(anyhow!("{} does not exist", root.display()));
    }
    let mut lines: Vec<String> = Vec::new();
    let mut total = 0usize;
    walk(&root, &mut |p| {
        total += 1;
        if lines.len() < 300 {
            let size = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
            lines.push(format!("{:>12}  {}", size, p.display()));
        }
    });
    if lines.is_empty() {
        return Ok(format!("no JSON or parquet files under {}", root.display()));
    }
    lines.sort();
    Ok(format!("{total} files\n{}", lines.join("\n")))
}

/// Walk a tree, stopping at files whose extension a data reader understands.
/// Depth-limited so a symlink loop cannot hang the panel.
fn walk(root: &std::path::Path, f: &mut impl FnMut(&std::path::Path)) {
    fn inner(dir: &std::path::Path, depth: usize, f: &mut impl FnMut(&std::path::Path), stop: &dyn Fn() -> bool) {
        if depth > 6 || stop() {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            if stop() {
                return;
            }
            let p = e.path();
            if p.is_dir() {
                let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
                if name.starts_with('.') || name == "node_modules" || name == "target" {
                    continue;
                }
                inner(&p, depth + 1, f, stop);
            } else {
                let ext = p
                    .extension()
                    .map(|x| x.to_string_lossy().to_lowercase())
                    .unwrap_or_default();
                if READABLE.contains(&ext.as_str()) {
                    f(&p);
                }
            }
        }
    }
    let capped = std::cell::Cell::new(false);
    inner(root, 0, f, &|| capped.get());
}

/// Run one tool call and return its text result.
fn run_tool(state: &AgentState, app: &AppHandle, name: &str, args: &Value) -> Result<String> {
    let s = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let n = |k: &str, d: usize| {
        args.get(k).and_then(|v| v.as_u64()).map(|v| v as usize).unwrap_or(d)
    };

    // A tool with no explicit root works on whatever folder the user is in.
    let cfg = config::load();
    let default_root = cfg.workspace_root.clone().unwrap_or_default();

    match name {
        "read_file" => read_file_tool(&s("path"), n("limit", 20)),
        "read_lines" => read_lines_tool(&s("path"), n("from", 1) as u32, n("to", 20) as u32),
        "search" => {
            let root = {
                let r = s("root");
                if r.is_empty() { default_root } else { r }
            };
            state.log(app, format!("search `{}` in {root}", s("query")));
            search_tool(&root, &s("query"), n("max_hits", 40))
        }
        "list_files" => {
            let root = {
                let r = s("root");
                if r.is_empty() { default_root } else { r }
            };
            list_files_tool(&root)
        }
        other => Err(anyhow!("unknown tool `{other}`")),
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

fn status_of(cfg: &GatewayConfig, st: &AgentState, id: &str, error: Option<String>) -> AgentStatus {
    let sessions = st.sessions.lock().ok();
    let spend = sessions
        .as_ref()
        .and_then(|m| m.get(id).map(|s| s.spend))
        .unwrap_or(0);
    AgentStatus {
        running: false,
        model: cfg.model.clone(),
        endpoint: cfg.base_url.clone(),
        ready: !cfg.base_url.trim().is_empty(),
        rounds: MAX_TOOL_ROUNDS,
        spend_tokens: spend,
        error,
    }
}

#[tauri::command]
pub fn agent_status(state: State<'_, AgentState>) -> AgentStatus {
    let cfg = config::load().gateway;
    status_of(&cfg, &state, "default", None)
}

/// Ask a question. Returns as soon as the turn is accepted; the answer arrives
/// on `agent:event`.
#[tauri::command]
pub async fn agent_send(
    app: AppHandle,
    state: State<'_, AgentState>,
    id: String,
    message: String,
    context: Option<String>,
) -> Result<(), String> {
    let cfg = config::load();
    if cfg.gateway.base_url.trim().is_empty() {
        return Err("Set a gateway base URL in Settings first.".into());
    }
    let gw = Gateway::new(cfg.gateway.clone()).map_err(err)?;

    // One turn at a time per session: a second question would interleave two
    // transcripts into the same row list.
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut sessions = state.sessions.lock().map_err(|_| "state poisoned".to_string())?;
        let s = sessions.entry(id.clone()).or_default();
        if s.cancel.is_some() {
            return Err("the previous turn is still running".into());
        }
        s.cancel = Some(cancel.clone());

        // Seed the system prompt once, so the conversation keeps its shape.
        if s.messages.is_empty() {
            let mut sys = SYSTEM_PROMPT.to_string();
            if let Some(root) = &cfg.workspace_root {
                sys.push_str(&format!("\nThe active project folder is {root}."));
            }
            for p in &cfg.projects {
                sys.push_str(&format!("\nKnown folder: {}", p.path));
            }
            if !cfg.agent.system_extra.trim().is_empty() {
                sys.push_str("\n\n");
                sys.push_str(&cfg.agent.system_extra);
            }
            s.messages.push(json!({ "role": "system", "content": sys }));
        }
        // Whatever the user was looking at travels with the question.
        let mut content = message.clone();
        if let Some(ctx) = context.filter(|c| !c.trim().is_empty()) {
            content.push_str("\n\n--- attached context ---\n");
            content.push_str(&crate::gateway::truncate(&ctx, 20_000));
        }
        s.messages.push(json!({ "role": "user", "content": content }));
    }

    let tools = tool_defs();
    let app2 = app.clone();

    // The turn runs on its own task so the command can return immediately.
    tauri::async_runtime::spawn(async move {
        let st = app2.state::<AgentState>();
        let _ = app2.emit(EV_AGENT, json!({ "type": "agent_start" }));

        let mut round = 0usize;
        let mut failed: Option<String> = None;

        'turn: while round < MAX_TOOL_ROUNDS {
            round += 1;
            if cancel.load(Ordering::Relaxed) {
                break;
            }

            let msgs = {
                let Ok(sessions) = st.sessions.lock() else { break };
                sessions.get(&id).map(|s| s.messages.clone()).unwrap_or_default()
            };

            let reply = match gw.chat(&msgs, Some(&tools)).await {
                Ok(r) => r,
                Err(e) => {
                    failed = Some(err(e));
                    break;
                }
            };

            if !reply.reasoning.is_empty() {
                let _ = app2.emit(
                    EV_AGENT,
                    json!({
                        "type": "message_update",
                        "assistantMessageEvent": { "type": "thinking_delta", "delta": reply.reasoning }
                    }),
                );
                let _ = app2.emit(
                    EV_AGENT,
                    json!({
                        "type": "message_update",
                        "assistantMessageEvent": { "type": "thinking_end", "content": reply.reasoning }
                    }),
                );
            }

            if !reply.content.is_empty() {
                let _ = app2.emit(
                    EV_AGENT,
                    json!({
                        "type": "message_update",
                        "assistantMessageEvent": { "type": "text_delta", "delta": reply.content }
                    }),
                );
                let _ = app2.emit(
                    EV_AGENT,
                    json!({
                        "type": "message_update",
                        "assistantMessageEvent": { "type": "text_end", "content": reply.content }
                    }),
                );
            }

            let usage = json!({
                "input": reply.prompt_tokens.unwrap_or(0),
                "output": reply.completion_tokens.unwrap_or(0),
                "cacheRead": 0,
            });

            // Record the assistant turn, tool calls and all, so the next
            // request sees a well-formed history.
            {
                let Ok(mut sessions) = st.sessions.lock() else { break };
                let s = sessions.entry(id.clone()).or_default();
                let mut m = json!({ "role": "assistant", "content": reply.content });
                if !reply.tool_calls.is_empty() {
                    m["tool_calls"] = Value::Array(reply.tool_calls.clone());
                }
                s.messages.push(m);
                s.spend += reply.prompt_tokens.unwrap_or(0) + reply.completion_tokens.unwrap_or(0);
            }

            if reply.tool_calls.is_empty() {
                let _ = app2.emit(EV_AGENT, json!({ "type": "turn_end", "message": { "usage": usage } }));
                break 'turn;
            }

            for tc in &reply.tool_calls {
                if cancel.load(Ordering::Relaxed) {
                    break 'turn;
                }
                let call_id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("call").to_string();
                let name = tc
                    .get("function")
                    .and_then(|f| f.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let args_text = tc
                    .get("function")
                    .and_then(|f| f.get("arguments"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("{}")
                    .to_string();
                let args: Value = serde_json::from_str(&args_text).unwrap_or(json!({}));

                let _ = app2.emit(
                    EV_AGENT,
                    json!({
                        "type": "tool_execution_start",
                        "toolCallId": call_id,
                        "toolName": name,
                        "args": args,
                    }),
                );

                let result = match run_tool(&st, &app2, &name, &args) {
                    Ok(text) => text,
                    Err(e) => format!("error: {e}"),
                };
                let is_error = result.starts_with("error:");

                let _ = app2.emit(
                    EV_AGENT,
                    json!({
                        "type": "tool_execution_end",
                        "toolCallId": call_id,
                        "result": result,
                        "isError": is_error,
                    }),
                );

                if let Ok(mut sessions) = st.sessions.lock() {
                    if let Some(s) = sessions.get_mut(&id) {
                        s.messages.push(json!({
                            "role": "tool",
                            "tool_call_id": call_id,
                            "content": result,
                        }));
                    }
                }
            }
            let _ = app2.emit(EV_AGENT, json!({ "type": "turn_end", "message": { "usage": usage } }));
        }

        if round >= MAX_TOOL_ROUNDS {
            st.log(&app2, format!("stopped after {MAX_TOOL_ROUNDS} tool rounds"));
        }
        if let Some(e) = &failed {
            let _ = app2.emit(EV_AGENT, json!({ "type": "note", "text": e, "bad": true }));
        }
        {
            if let Ok(mut sessions) = st.sessions.lock() {
                if let Some(s) = sessions.get_mut(&id) {
                    s.cancel = None;
                }
            }
        }
        let _ = app2.emit(EV_AGENT, json!({ "type": "agent_settled" }));
    });

    Ok(())
}

#[tauri::command]
pub fn agent_stop(state: State<'_, AgentState>, id: String) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|_| "state poisoned".to_string())?;
    if let Some(s) = sessions.get(&id) {
        if let Some(c) = &s.cancel {
            c.store(true, Ordering::Relaxed);
        }
    }
    Ok(())
}

/// Forget the conversation. The next question starts a fresh context.
#[tauri::command]
pub fn agent_reset(state: State<'_, AgentState>, id: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|_| "state poisoned".to_string())?;
    sessions.remove(&id);
    Ok(())
}

#[tauri::command]
pub fn agent_log(state: State<'_, AgentState>) -> Vec<String> {
    state.logs.lock().map(|l| l.clone()).unwrap_or_default()
}

const SYSTEM_PROMPT: &str = "\
You are the analyst inside TraceMatter, a local workbench for reading agent
trajectories and the datasets built from them.

You have read-only tools. Use them rather than guessing: when a question is
about a file, read the file. When it is about what data exists, list the folder.
Every claim you make about a file should be one you just looked at.

The data you will typically be asked about:
- Agent transcripts: JSONL, one record per line, with typed records and
  block-structured content (text, thinking, tool_use, tool_result).
- harvey-labs tasks: task.json carries a title, instructions, and a criteria
  array; each criterion has an id, a title, and the match_criteria a judge
  grades against.
- Eval results: a JSONL whose first line is a summary ({model, n, acc}) followed
  by one row per item ({i, question, ref, pred, correct, gen}).
- pass@k results: a JSONL whose first line carries pass_at_1..k, followed by
  rows of {i, ref, preds: {E0: [...]}, lens: [...]}.
- GRPO completions: parquet with prompt, completion, reward, advantage.

Be concise and concrete. Quote the numbers you actually read. If the data does
not answer the question, say so plainly instead of inferring around it.";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_reader_refuses_a_file_it_cannot_read() {
        let d = std::env::temp_dir().join(format!("tm-agent-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let docx = d.join("a.docx");
        std::fs::write(&docx, b"x").unwrap();
        let e = check_readable(&docx).unwrap_err().to_string();
        assert!(e.contains("only opens"), "got: {e}");
        let ok = d.join("a.jsonl");
        std::fs::write(&ok, b"{}\n").unwrap();
        assert!(check_readable(&ok).is_ok());
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn the_line_reader_stops_at_the_end_of_the_file() {
        let d = std::env::temp_dir().join(format!("tm-agent-lines-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join("a.jsonl");
        std::fs::write(&p, "{\"a\":1}\n{\"a\":2}\n").unwrap();
        let out = read_lines_tool(p.to_str().unwrap(), 1, 5).unwrap();
        assert!(out.contains("1: {\"a\":1}"));
        assert!(out.contains("2: {\"a\":2}"));
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn a_bad_range_is_refused_rather_than_silently_empty() {
        let d = std::env::temp_dir().join(format!("tm-agent-range-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join("a.jsonl");
        std::fs::write(&p, "{}\n").unwrap();
        assert!(read_lines_tool(p.to_str().unwrap(), 9, 3).is_err());
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn a_config_written_by_the_old_build_still_loads() {
        // The previous build stored the agent's settings under `analyst`, with
        // a `piPath` this version has no use for. Take a whole default config,
        // rename that one key back to what the old build wrote, and confirm it
        // still loads -- the alias accepts it and the dead key is ignored.
        let mut v = serde_json::to_value(crate::config::AppConfig::default()).unwrap();
        let agent = v["agent"].take();
        v.as_object_mut().unwrap().remove("agent");
        v["analyst"] = agent;
        v["analyst"]["piPath"] = serde_json::json!("C:/pi.exe");
        v["analyst"]["maxSteps"] = serde_json::json!(77);

        let cfg: crate::config::AppConfig = serde_json::from_value(v).unwrap();
        assert_eq!(cfg.agent.max_steps, 77, "the old block's value survives");

        // And the current name still wins, so a freshly written config round-trips.
        let mut v2 = serde_json::to_value(crate::config::AppConfig::default()).unwrap();
        v2["agent"]["maxSteps"] = serde_json::json!(42);
        let cfg2: crate::config::AppConfig = serde_json::from_value(v2).unwrap();
        assert_eq!(cfg2.agent.max_steps, 42);
    }
}
