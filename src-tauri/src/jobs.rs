//! Batch labelling engine.
//!
//! What this replaces is a shell script plus a Python worker: the job manager
//! owns the queue, bounds concurrency, streams results to disk as they arrive,
//! and reports progress to the UI. Three properties matter more than throughput:
//!
//! * **Durability** — every finished row is appended to a JSONL file immediately,
//!   so cancelling (or crashing) never loses completed work.
//! * **Bounded concurrency** — gateways rate-limit; the limit is explicit.
//! * **Per-row failure isolation** — one bad row must not sink a 5,000-row job.

use crate::config::GatewayConfig;
use crate::gateway::Gateway;
use crate::model::*;
use anyhow::{Context, Result};
use futures::stream::{FuturesUnordered, StreamExt};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

pub const EV_PROGRESS: &str = "job://progress";
pub const EV_RECORD: &str = "job://record";

struct JobInner {
    progress: JobProgress,
    results: Vec<LabelRecord>,
    cancel: Arc<AtomicBool>,
    output: Option<PathBuf>,
}

#[derive(Default)]
pub struct JobManager {
    jobs: Mutex<HashMap<String, Arc<Mutex<JobInner>>>>,
}

impl JobManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, id: &str) -> Option<JobProgress> {
        let map = self.jobs.lock().ok()?;
        let job = map.get(id)?;
        let inner = job.lock().ok()?;
        Some(inner.progress.clone())
    }

    pub fn list(&self) -> Vec<JobProgress> {
        let map = match self.jobs.lock() {
            Ok(m) => m,
            Err(_) => return Vec::new(),
        };
        let mut v: Vec<JobProgress> = map
            .values()
            .filter_map(|j| j.lock().ok().map(|i| i.progress.clone()))
            .collect();
        v.sort_by(|a, b| b.job_id.cmp(&a.job_id));
        v
    }

    pub fn results(&self, id: &str) -> Vec<LabelRecord> {
        self.jobs
            .lock()
            .ok()
            .and_then(|m| m.get(id).cloned())
            .and_then(|j| j.lock().ok().map(|i| i.results.clone()))
            .unwrap_or_default()
    }

    pub fn cancel(&self, id: &str) -> bool {
        let map = match self.jobs.lock() {
            Ok(m) => m,
            Err(_) => return false,
        };
        match map.get(id) {
            Some(job) => {
                if let Ok(inner) = job.lock() {
                    inner.cancel.store(true, Ordering::SeqCst);
                    return true;
                }
                false
            }
            None => false,
        }
    }

    pub fn forget(&self, id: &str) {
        if let Ok(mut map) = self.jobs.lock() {
            map.remove(id);
        }
    }

    /// Start a labelling job. Returns its id immediately; work happens on the
    /// async runtime and reports through events.
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        &self,
        app: AppHandle,
        segments: Vec<TurnSegment>,
        schema: LabelSchema,
        gateway_cfg: GatewayConfig,
        system_extra: String,
        output: Option<PathBuf>,
    ) -> Result<String> {
        let job_id = uuid::Uuid::new_v4().to_string();
        let total = segments.len();
        let inner = Arc::new(Mutex::new(JobInner {
            progress: JobProgress {
                job_id: job_id.clone(),
                status: JobStatus::Running,
                total,
                completed: 0,
                failed: 0,
                running: 0,
                message: Some(format!("starting · {} rows · {}", total, gateway_cfg.model)),
                started_at: Some(now()),
                finished_at: None,
            },
            results: Vec::with_capacity(total),
            cancel: Arc::new(AtomicBool::new(false)),
            output: output.clone(),
        }));

        {
            let mut map = self.jobs.lock().map_err(|_| anyhow::anyhow!("job lock poisoned"))?;
            map.insert(job_id.clone(), inner.clone());
        }

        let gateway = Arc::new(Gateway::new(gateway_cfg.clone())?);
        let concurrency = gateway_cfg.concurrency.clamp(1, 64);

        if let Some(path) = output.as_ref() {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).ok();
            }
        }

        let app_handle = app.clone();
        let schema = Arc::new(schema);
        let extra = Arc::new(system_extra);

        tauri::async_runtime::spawn(async move {
            let mut queue = segments.into_iter();
            let mut pending: FuturesUnordered<JobFuture> = FuturesUnordered::new();

            // Keep `concurrency` requests in flight: prime the pipeline, then top
            // it up on every completion. This bounds load on the gateway without
            // the bookkeeping of a worker pool.
            for _ in 0..concurrency {
                if let Some(seg) = queue.next() {
                    pending.push(spawn_row(gateway.clone(), schema.clone(), extra.clone(), seg));
                }
            }

            while let Some(record) = pending.next().await {
                let cancelled = inner
                    .lock()
                    .map(|i| i.cancel.load(Ordering::SeqCst))
                    .unwrap_or(true);
                if cancelled {
                    break;
                }

                // Stream to disk before notifying the UI, so a crash mid-job
                // still leaves every finished row behind.
                if let Some(path) = inner.lock().ok().and_then(|i| i.output.clone()) {
                    if let Ok(line) = serde_json::to_string(&record) {
                        if let Ok(mut fh) = std::fs::OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open(&path)
                        {
                            let _ = writeln!(fh, "{line}");
                        }
                    }
                }

                if let Ok(mut i) = inner.lock() {
                    if record.error.is_some() {
                        i.progress.failed += 1;
                    } else {
                        i.progress.completed += 1;
                    }
                    i.progress.message = Some(match &record.error {
                        Some(e) => format!("{} - error: {}", record.id, crate::gateway::truncate(e, 90)),
                        None => format!("{} - ok ({} ms)", record.id, record.latency_ms.unwrap_or(0.0) as i64),
                    });
                    i.results.push(record.clone());
                }
                let _ = app_handle.emit(EV_RECORD, &record);
                if let Ok(p) = inner.lock().map(|i| i.progress.clone()) {
                    let _ = app_handle.emit(EV_PROGRESS, &p);
                }

                if let Some(seg) = queue.next() {
                    pending.push(spawn_row(gateway.clone(), schema.clone(), extra.clone(), seg));
                }
            }

            let mut guard = match inner.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            guard.progress.running = 0;
            guard.progress.finished_at = Some(now());
            guard.progress.status = if guard.cancel.load(Ordering::SeqCst) {
                JobStatus::Cancelled
            } else if guard.progress.completed == 0 && guard.progress.failed > 0 {
                JobStatus::Failed
            } else {
                JobStatus::Done
            };
            guard.progress.message = Some(format!(
                "{} - {} ok - {} failed - {} rows",
                match guard.progress.status {
                    JobStatus::Cancelled => "cancelled",
                    JobStatus::Failed => "failed",
                    _ => "finished",
                },
                guard.progress.completed,
                guard.progress.failed,
                guard.progress.total
            ));
            let p = guard.progress.clone();
            drop(guard);
            let _ = app_handle.emit(EV_PROGRESS, &p);
        });

        Ok(job_id)
    }
}

/// Boxed so the in-flight set has a nameable type and no borrow of the local
/// gateway: every request owns an `Arc` clone instead.
type JobFuture = std::pin::Pin<Box<dyn std::future::Future<Output = LabelRecord> + Send>>;

fn spawn_row(
    gateway: Arc<Gateway>,
    schema: Arc<LabelSchema>,
    extra: Arc<String>,
    seg: TurnSegment,
) -> JobFuture {
    Box::pin(async move { run_one(&gateway, schema, extra, seg).await })
}

async fn run_one(
    gateway: &Gateway,
    schema: Arc<LabelSchema>,
    extra: Arc<String>,
    seg: TurnSegment,
) -> LabelRecord {
    let prompt = if extra.trim().is_empty() {
        seg.digest.clone()
    } else {
        format!("{extra}\n\n--- TURN DIGEST ---\n{}\n--- END ---", seg.digest)
    };

    let base = LabelRecord {
        id: seg.id.clone(),
        session: seg.session.clone(),
        turn: seg.index,
        title: seg.title.clone(),
        n_tools: seg.n_tools,
        n_errors: seg.n_errors,
        n_interrupts: seg.n_interrupts,
        values: Default::default(),
        error: None,
        model: None,
        latency_ms: None,
        prompt_tokens: None,
        completion_tokens: None,
        finished_at: Some(now()),
    };

    match gateway.complete(&schema, &prompt).await {
        Ok(c) => LabelRecord {
            values: c.values,
            model: Some(c.model),
            latency_ms: Some(c.latency_ms),
            prompt_tokens: c.prompt_tokens,
            completion_tokens: c.completion_tokens,
            ..base
        },
        Err(e) => LabelRecord {
            error: Some(format!("{e:#}")),
            model: Some(gateway.config().model.clone()),
            ..base
        },
    }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Write a set of labelled rows to disk. Format is chosen by extension so the
/// same button can produce a training file or a spreadsheet.
pub fn export(records: &[LabelRecord], path: &PathBuf, fields: &[LabelField]) -> Result<usize> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("jsonl")
        .to_lowercase();
    let mut out = String::new();
    match ext.as_str() {
        "csv" => {
            let mut header = vec!["id", "session", "turn", "nTools", "nErrors", "nInterrupts", "model", "error"];
            for f in fields {
                header.push(f.name.as_str());
            }
            out.push_str(&header.join(","));
            out.push('\n');
            for r in records {
                let mut row = vec![
                    r.id.clone(),
                    r.session.clone(),
                    r.turn.to_string(),
                    r.n_tools.to_string(),
                    r.n_errors.to_string(),
                    r.n_interrupts.to_string(),
                    r.model.clone().unwrap_or_default(),
                    r.error.clone().unwrap_or_default(),
                ];
                for f in fields {
                    row.push(cell(r.values.get(&f.name)));
                }
                out.push_str(&row.iter().map(|c| csv_escape(c)).collect::<Vec<_>>().join(","));
                out.push('\n');
            }
        }
        "json" => {
            out = serde_json::to_string_pretty(records)?;
        }
        _ => {
            for r in records {
                out.push_str(&serde_json::to_string(r)?);
                out.push('\n');
            }
        }
    }
    std::fs::write(path, out).with_context(|| format!("write {}", path.display()))?;
    Ok(records.len())
}

fn cell(v: Option<&serde_json::Value>) -> String {
    match v {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

fn csv_escape(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}