//! The Analyst: a coding-agent kernel run as a sidecar, and the loopback bridge
//! it calls back on.
//!
//! The kernel speaks whatever protocol it speaks: newline-delimited JSON on
//! stdin, events on stdout. It has no idea what a "session" is in this app.
//! Everything it can learn about your transcripts is declared in
//! `analyst/tm_ext.js`, and every tool there is a thin proxy: it POSTs to a
//! bridge bound to 127.0.0.1, and this module answers using the same code paths
//! the UI uses.
//!
//! That indirection is the point. There is one implementation of "read a
//! transcript", one place where a path is checked, and one place to gate
//! anything that would write, instead of a second data pipeline living inside a
//! prompt where nobody can see it.
//!
//! The bridge is loopback-only and token-guarded. The token is drawn per run and
//! handed to the kernel through the environment rather than through argv, where
//! every other process on the machine could read it.

use crate::commands::{self, ScanArgs, TraceArgs};
use crate::config::{self, AppConfig};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager, State};

/// Events the panel renders: one JSON object per line, straight from the kernel.
pub const EVENT_NAME: &str = "analyst:event";
/// Kernel chatter on stderr, kept next to the panel for when something is wrong.
pub const LOG_NAME: &str = "analyst:log";

/// A tool call is a few kilobytes; anything larger is a mistake or a probe.
const MAX_REQUEST: usize = 1 << 20;
/// Search: hits returned, files opened, and lines looked at per file.
const SEARCH_HITS: usize = 60;
const SEARCH_FILES: usize = 400;
const SEARCH_LINES: usize = 200_000;
/// Tool results are clipped before they reach a model's context window.
const CLIP_STEP: usize = 900;
const CLIP_ROW: usize = 400;
const KEEP_LOG: usize = 200;

#[derive(Default)]
pub struct AnalystState(Mutex<Inner>);

#[derive(Default)]
struct Inner {
    child: Option<Child>,
    port: u16,
    token: String,
    started: Option<Instant>,
    log: Vec<String>,
    error: Option<String>,
    model: String,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AnalystStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub port: u16,
    pub model: String,
    pub pi_path: Option<String>,
    pub pi_found: bool,
    pub extension_path: Option<String>,
    pub extension_found: bool,
    pub uptime_secs: Option<f64>,
    pub error: Option<String>,
    pub log: Vec<String>,
}

// ---------------------------------------------------------------- helpers

fn note(inner: &mut Inner, line: impl Into<String>) {
    if inner.log.len() >= KEEP_LOG {
        inner.log.remove(0);
    }
    inner.log.push(line.into());
}

/// Drop a kernel that exited on its own, so the panel stops claiming it is up.
fn reap(inner: &mut Inner) {
    let exited = match inner.child.as_mut() {
        Some(c) => c.try_wait().ok().flatten(),
        None => None,
    };
    if let Some(st) = exited {
        inner.child = None;
        inner.port = 0;
        note(inner, format!("kernel exited ({st})"));
    }
}

fn status_of(inner: &Inner, pi: &Option<PathBuf>, ext: &Option<PathBuf>) -> AnalystStatus {
    AnalystStatus {
        running: inner.child.is_some(),
        pid: inner.child.as_ref().map(|c| c.id()),
        port: inner.port,
        model: inner.model.clone(),
        pi_path: pi.as_ref().map(|p| p.to_string_lossy().to_string()),
        pi_found: pi.is_some(),
        extension_path: ext.as_ref().map(|p| p.to_string_lossy().to_string()),
        extension_found: ext.is_some(),
        uptime_secs: inner.started.map(|t| t.elapsed().as_secs_f64()),
        error: inner.error.clone(),
        log: inner.log.clone(),
    }
}

/// Clip to a character budget. Bytes would cut multibyte text in half.
fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out = String::with_capacity(max + 8);
    for (i, c) in s.chars().enumerate() {
        if i >= max {
            break;
        }
        out.push(c);
    }
    out.push_str("...");
    out
}

/// Serialise, then clip. Used on structs this module does not want to
/// re-declare: the shape stays in `model.rs` and the size policy lives here.
fn clip_value(v: Value, max: usize) -> Value {
    match serde_json::to_string(&v) {
        Ok(s) if s.chars().count() > max => json!({
            "clipped": true,
            "chars": s.chars().count(),
            "json": clip(&s, max),
        }),
        _ => v,
    }
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    hay.windows(needle.len()).position(|w| w == needle)
}

// ---------------------------------------------------------------- payloads

fn model_ids(cfg: &AppConfig) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    let mut push = |m: &str| {
        let m = m.trim();
        if !m.is_empty() && !ids.iter().any(|x| x == m) {
            ids.push(m.to_string());
        }
    };
    push(&cfg.gateway.model);
    for m in &cfg.gateway.models {
        push(m);
    }
    ids
}

/// What the kernel needs to reach the model the app is configured for. The key
/// is included because the kernel is the client that calls it; the bridge token
/// is what keeps this answer from being readable by anything else on the
/// machine.
fn provider_payload() -> Result<Value, String> {
    let cfg = config::load();
    if cfg.gateway.base_url.trim().is_empty() {
        return Err("no model endpoint is configured: set one under Settings".to_string());
    }
    let models: Vec<Value> = model_ids(&cfg)
        .into_iter()
        .map(|id| {
            json!({
                "id": id,
                "name": id,
                "reasoning": false,
                "input": ["text"],
                "cost": {"input": 0.0, "output": 0.0, "cacheRead": 0.0, "cacheWrite": 0.0},
                "contextWindow": 128000,
                "maxTokens": cfg.gateway.max_tokens,
            })
        })
        .collect();
    Ok(json!({
        "name": "tracematter",
        "baseUrl": cfg.gateway.base_url,
        "apiKey": cfg.gateway.api_key,
        "api": "openai-completions",
        "models": models,
        "activeModel": cfg.gateway.model,
    }))
}

async fn models_payload() -> Result<Value, String> {
    let cfg = config::load();
    let live = commands::list_models(cfg.gateway.clone())
        .await
        .unwrap_or_default();
    let mut ids = model_ids(&cfg);
    for m in live {
        if !ids.iter().any(|x| x == &m) {
            ids.push(m);
        }
    }
    Ok(json!({ "models": ids }))
}

/// What the panel shows as "in scope", and the first thing a model should read:
/// which folders exist, which is active, how they are read, and which model
/// answers.
fn context_payload() -> Value {
    let cfg = config::load();
    let projects: Vec<Value> = cfg
        .projects
        .iter()
        .map(|p| json!({ "name": p.name, "path": p.path, "profile": p.profile }))
        .collect();
    let reads: Vec<String> = ["tm_sessions", "tm_trace", "tm_search", "tm_context"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    json!({
        "activeProject": cfg.workspace_root,
        "projects": projects,
        "model": cfg.gateway.model,
        "endpoint": clip(&cfg.gateway.base_url, 120),
        "maxSteps": cfg.analyst.max_steps,
        "tools": reads,
        "readOnly": !cfg.analyst.allow_writes,
    })
}

async fn sessions_payload(args: &Value) -> Result<Value, String> {
    let root = args
        .get("root")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(active_root)
        .ok_or_else(|| "no folder is active: add one in the sidebar first".to_string())?;
    if !Path::new(&root).exists() {
        return Err(format!("no such folder: {root}"));
    }
    let scan: ScanArgs = serde_json::from_value(json!({ "root": root, "concurrency": 8 }))
        .map_err(|e| format!("bad scan arguments: {e}"))?;
    let res = commands::scan_sessions(scan).await?;
    let rows: Vec<Value> = res
        .sessions
        .iter()
        .map(|s| clip_value(serde_json::to_value(s).unwrap_or(Value::Null), 1200))
        .collect();
    Ok(json!({
        "root": res.root,
        "filesSeen": res.files_seen,
        "filesFailed": res.files_failed,
        "count": res.sessions.len(),
        "sessions": rows,
    }))
}

async fn trace_payload(args: &Value) -> Result<Value, String> {
    let cfg = config::load();
    let path = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "tm_trace needs the path of a transcript".to_string())?
        .to_string();
    if !Path::new(&path).exists() {
        return Err(format!("no such transcript: {path}"));
    }
    let limit = args
        .get("limit")
        .and_then(|v| v.as_u64())
        .map(|v| v as usize)
        .unwrap_or(cfg.analyst.max_steps)
        .clamp(10, 1000);
    let ta: TraceArgs = serde_json::from_value(json!({ "path": path }))
        .map_err(|e| format!("bad trace arguments: {e}"))?;
    let trace = commands::load_trace(ta).await?;
    let total = trace.steps.len();
    let steps: Vec<Value> = trace
        .steps
        .iter()
        .take(limit)
        .map(|s| clip_value(serde_json::to_value(s).unwrap_or(Value::Null), CLIP_STEP))
        .collect();
    let turns: Vec<Value> = trace
        .turns
        .iter()
        .take(12)
        .map(|t| clip_value(serde_json::to_value(t).unwrap_or(Value::Null), CLIP_STEP))
        .collect();
    Ok(json!({
        "summary": serde_json::to_value(&trace.summary).unwrap_or(Value::Null),
        "stepsTotal": total,
        "stepsShown": steps.len(),
        "truncated": total > steps.len(),
        "steps": steps,
        "turns": turns,
        "files": trace.files.iter().take(80).collect::<Vec<_>>(),
        "bashCommands": trace.bash_commands.iter().take(40).collect::<Vec<_>>(),
        "badLines": trace.bad_lines,
    }))
}

/// Grep the transcripts. Deliberately simple: this is a finding aid, and a model
/// that can search a log is far more useful than one handed every log.
fn search_payload(args: &Value) -> Result<Value, String> {
    let needle = args
        .get("query")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "tm_search needs a query".to_string())?
        .to_lowercase();
    if needle.trim().is_empty() {
        return Err("tm_search needs a non-empty query".to_string());
    }
    let root = args
        .get("root")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(active_root)
        .ok_or_else(|| "no folder is active: add one in the sidebar first".to_string())?;
    let root_path = PathBuf::from(&root);
    if !root_path.exists() {
        return Err(format!("no such folder: {root}"));
    }
    let files = crate::transcript::list_transcripts(&root_path).map_err(|e| format!("{e:#}"))?;
    let mut hits: Vec<Value> = Vec::new();
    let mut scanned = 0usize;
    for f in files.iter().take(SEARCH_FILES) {
        if hits.len() >= SEARCH_HITS {
            break;
        }
        scanned += 1;
        let Ok(handle) = std::fs::File::open(f) else {
            continue;
        };
        let reader = BufReader::new(handle);
        for (i, line) in reader.lines().enumerate() {
            if i >= SEARCH_LINES || hits.len() >= SEARCH_HITS {
                break;
            }
            let Ok(line) = line else { break };
            if line.to_lowercase().contains(&needle) {
                hits.push(json!({
                    "path": f.to_string_lossy(),
                    "line": i + 1,
                    "text": clip(&line, CLIP_ROW),
                }));
            }
        }
    }
    Ok(json!({
        "query": needle,
        "root": root,
        "filesScanned": scanned,
        "hits": hits,
        "truncated": hits.len() >= SEARCH_HITS,
    }))
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub fn analyst_status(app: AppHandle, state: State<AnalystState>) -> AnalystStatus {
    let cfg = config::load();
    let mut inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
    reap(&mut inner);
    status_of(&inner, &resolve_pi(&cfg), &resolve_extension(&app))
}

/// Start the kernel: bridge first, because it asks for its provider before the
/// first turn, and settings read second, so the model id is not stale.
#[tauri::command]
pub async fn analyst_start(
    app: AppHandle,
    state: State<'_, AnalystState>,
) -> Result<AnalystStatus, String> {
    let cfg = config::load();
    let pi = resolve_pi(&cfg).ok_or_else(|| {
        "no kernel binary found. Set its path in Settings, or put pi on PATH.".to_string()
    })?;
    let ext = resolve_extension(&app)
        .ok_or_else(|| "analyst/tm_ext.js is missing from this build".to_string())?;

    let mut inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(mut child) = inner.child.take() {
        let _ = child.kill();
        let _ = child.wait();
        note(&mut inner, "previous kernel stopped");
    }

    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("cannot open a bridge port: {e}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("cannot configure the bridge: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("cannot read the bridge port: {e}"))?
        .port();
    let token = uuid::Uuid::new_v4().simple().to_string();
    let listener = tokio::net::TcpListener::from_std(listener)
        .map_err(|e| format!("cannot register the bridge with the runtime: {e}"))?;
    {
        let app = app.clone();
        let token = token.clone();
        tauri::async_runtime::spawn(async move { serve(app, token, listener).await });
    }

    let mut cmd = Command::new(&pi);
    cmd.arg("--mode")
        .arg("rpc")
        .arg("--provider")
        .arg("tracematter")
        .arg("--model")
        .arg(&cfg.gateway.model)
        .arg("--no-session")
        .arg("--no-context-files")
        .arg("--no-builtin-tools")
        .arg("--tools")
        .arg("tm_context,tm_sessions,tm_trace,tm_search")
        .arg("-e")
        .arg(&ext)
        .env("TM_BRIDGE", format!("http://127.0.0.1:{port}"))
        .env("TM_TOKEN", &token)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(root) = active_root() {
        if Path::new(&root).is_dir() {
            cmd.current_dir(root);
        }
    }
    // A console window flashing up on every start would be its own bug report.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("cannot start {}: {e}", pi.display()))?;
    note(&mut inner, format!("kernel started: {}", pi.display()));

    if let Some(out) = child.stdout.take() {
        let app = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(out);
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        let _ = app.emit(EVENT_NAME, l);
                    }
                    Err(_) => break,
                }
            }
            let _ = app.emit(EVENT_NAME, "{\"type\":\"kernel_exit\"}".to_string());
        });
    }
    if let Some(out) = child.stderr.take() {
        let app = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(out);
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        let _ = app.emit(LOG_NAME, l);
                    }
                    Err(_) => break,
                }
            }
        });
    }

    inner.port = port;
    inner.token = token;
    inner.started = Some(Instant::now());
    inner.error = None;
    inner.model = cfg.gateway.model.clone();
    inner.child = Some(child);
    Ok(status_of(&inner, &Some(pi), &Some(ext)))
}

/// Hand the kernel a prompt. The id is echoed back on every event of that turn,
/// which is what lets the panel tell two runs apart.
#[tauri::command]
pub fn analyst_send(state: State<AnalystState>, id: String, message: String) -> Result<(), String> {
    let mut inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
    reap(&mut inner);
    let child = inner
        .child
        .as_mut()
        .ok_or_else(|| "the kernel is not running".to_string())?;
    let stdin = child
        .stdin
        .as_mut()
        .ok_or_else(|| "the kernel has no input pipe".to_string())?;
    let line = json!({ "id": id, "type": "prompt", "message": message }).to_string();
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("cannot reach the kernel: {e}"))
}

#[tauri::command]
pub fn analyst_stop(app: AppHandle, state: State<AnalystState>) -> AnalystStatus {
    let cfg = config::load();
    let mut inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(mut child) = inner.child.take() {
        let _ = child.kill();
        let _ = child.wait();
        note(&mut inner, "kernel stopped");
    }
    inner.port = 0;
    inner.token.clear();
    inner.started = None;
    status_of(&inner, &resolve_pi(&cfg), &resolve_extension(&app))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipping_counts_characters_not_bytes() {
        assert_eq!(clip("hello world", 5), "hello...");
        assert_eq!(clip("abcdef", 6), "abcdef");
        assert_eq!(clip("abcdef", 3), "abc...");
    }

    #[test]
    fn a_big_value_comes_back_clipped_and_marked() {
        let big = json!({ "text": "x".repeat(500) });
        let out = clip_value(big, 100);
        assert_eq!(out["clipped"], json!(true));
        assert!(out["json"].as_str().unwrap().chars().count() <= 104);

        let small = json!({ "text": "hi" });
        assert_eq!(clip_value(small.clone(), 100), small);
    }

    #[test]
    fn the_header_terminator_is_found_where_it_is() {
        assert_eq!(find(b"GET / HTTP/1.1\r\n\r\nbody", b"\r\n\r\n"), Some(14));
        assert_eq!(find(b"nothing", b"\r\n\r\n"), None);
    }

    #[test]
    fn the_model_list_starts_with_the_active_one_and_has_no_duplicates() {
        let mut cfg = AppConfig::default();
        cfg.gateway.model = "active".to_string();
        cfg.gateway.models = vec!["active".to_string(), "b".to_string(), "".to_string()];
        assert_eq!(model_ids(&cfg), vec!["active", "b"]);
    }
}

// ---------------------------------------------------------------- bridge

#[derive(Deserialize)]
struct CallRequest {
    tool: String,
    #[serde(default)]
    args: Value,
}

async fn tool_call(body: &[u8]) -> (u16, Value) {
    let req: CallRequest = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(e) => return (400, json!({ "error": format!("bad tool call: {e}") })),
    };
    let out = match req.tool.as_str() {
        "tm_context" => Ok(context_payload()),
        "tm_sessions" => sessions_payload(&req.args).await,
        "tm_trace" => trace_payload(&req.args).await,
        "tm_search" => search_payload(&req.args),
        "tm_provider" => provider_payload(),
        "tm_models" => models_payload().await,
        other => Err(format!("this build has no tool called {other}")),
    };
    // A tool that fails is still an answer: the model should hear why.
    match out {
        Ok(v) => (200, v),
        Err(e) => (200, json!({ "error": e })),
    }
}

async fn dispatch(method: &str, path: &str, body: &[u8]) -> (u16, Value) {
    match (method, path) {
        ("GET", "/ping") => (200, json!({ "ok": true, "app": "tracematter" })),
        ("GET", "/provider") => match provider_payload() {
            Ok(v) => (200, v),
            Err(e) => (200, json!({ "error": e })),
        },
        ("GET", "/models") => match models_payload().await {
            Ok(v) => (200, v),
            Err(e) => (200, json!({ "error": e })),
        },
        ("POST", "/call") => tool_call(body).await,
        _ => (
            404,
            json!({ "error": format!("no route for {method} {path}") }),
        ),
    }
}

async fn serve(app: AppHandle, token: String, listener: tokio::net::TcpListener) {
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            break;
        };
        let app = app.clone();
        let token = token.clone();
        tokio::spawn(async move {
            let _ = one_request(app, token, stream).await;
        });
    }
}

async fn one_request(
    _app: AppHandle,
    token: String,
    mut stream: tokio::net::TcpStream,
) -> std::io::Result<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut buf: Vec<u8> = Vec::with_capacity(8192);
    let mut chunk = [0u8; 8192];
    let head_end;
    loop {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
        match find(&buf, b"\r\n\r\n") {
            Some(i) => {
                head_end = i + 4;
                break;
            }
            None => {
                if buf.len() > MAX_REQUEST {
                    return Ok(());
                }
            }
        }
    }

    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or_default().to_string();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("/").to_string();

    let mut want = 0usize;
    let mut supplied = String::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            let k = k.trim().to_ascii_lowercase();
            let v = v.trim().to_string();
            if k == "content-length" {
                want = v.parse().unwrap_or(0);
            }
            if k == "x-tm-token" {
                supplied = v;
            }
        }
    }

    let mut body = buf[head_end..].to_vec();
    while body.len() < want && body.len() <= MAX_REQUEST {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }

    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (target.clone(), String::new()),
    };
    if supplied.is_empty() {
        for pair in query.split('&') {
            if let Some((k, v)) = pair.split_once('=') {
                if k == "token" {
                    supplied = v.to_string();
                }
            }
        }
    }

    let (code, payload) = if supplied != token {
        (403u16, json!({ "error": "bad or missing bridge token" }))
    } else {
        dispatch(&method, &path, &body).await
    };

    let text = serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string());
    let reason = match code {
        200 => "OK",
        400 => "Bad Request",
        403 => "Forbidden",
        _ => "Not Found",
    };
    let head = format!(
        "HTTP/1.1 {code} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        text.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(text.as_bytes()).await?;
    stream.flush().await?;
    let _ = stream.shutdown().await;
    Ok(())
}

// ---------------------------------------------------------------- discovery

fn which(names: &[&str]) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for n in names {
            let cand = dir.join(n);
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    None
}

#[cfg(windows)]
fn kernel_names() -> &'static [&'static str] {
    &["pi.exe", "pi-x86_64-pc-windows-msvc.exe", "pi.cmd"]
}

#[cfg(not(windows))]
fn kernel_names() -> &'static [&'static str] {
    &["pi", "pi-x86_64-unknown-linux-gnu", "pi-aarch64-apple-darwin"]
}

/// Where the kernel binary is.
///
/// An explicit path in the settings wins. Then a `pi` on PATH, then the places a
/// desktop install keeps its binaries.
fn resolve_pi(cfg: &AppConfig) -> Option<PathBuf> {
    let configured = cfg.analyst.pi_path.trim();
    if !configured.is_empty() {
        let p = PathBuf::from(configured);
        if p.is_file() {
            return Some(p);
        }
    }
    if let Some(p) = which(kernel_names()) {
        return Some(p);
    }
    let mut bases: Vec<PathBuf> = Vec::new();
    if let Some(d) = dirs::data_local_dir() {
        bases.push(d.join("kalo").join("binaries"));
    }
    if let Some(d) = dirs::home_dir() {
        bases.push(d.join(".kalo").join("binaries"));
    }
    for base in bases {
        for n in kernel_names() {
            let cand = base.join(n);
            if cand.is_file() {
                return Some(cand);
            }
        }
        // Also accept a versioned file name: installers rename as they update.
        if let Ok(rd) = std::fs::read_dir(&base) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().to_string();
                if n.starts_with("pi") && n.ends_with(".exe") {
                    return Some(e.path());
                }
            }
        }
    }
    None
}

/// The extension that declares what the kernel may do here. It ships with the
/// app; in a source checkout it sits next to the crate.
fn resolve_extension(app: &AppHandle) -> Option<PathBuf> {
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        cands.push(dir.join("analyst").join("tm_ext.js"));
        cands.push(dir.join("tm_ext.js"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            cands.push(parent.join("analyst").join("tm_ext.js"));
        }
    }
    cands.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("analyst")
            .join("tm_ext.js"),
    );
    cands.into_iter().find(|p| p.is_file())
}

/// The folder a tool call works on when it does not name one: whatever project
/// the sidebar has active.
fn active_root() -> Option<String> {
    let cfg = config::load();
    cfg.workspace_root
        .clone()
        .or_else(|| cfg.projects.first().map(|p| p.path.clone()))
}
