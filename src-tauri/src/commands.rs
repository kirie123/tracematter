//! Tauri command surface.
//!
//! Everything the UI can ask for is declared here. Commands return `Result<_,
//! String>` because a failed future must not take the window down; the error
//! text is what the user sees, so it is written to be actionable.

use crate::config::{self, AppConfig};
use crate::model::*;
use crate::profile;
use crate::segments::{self, DigestOptions};
use crate::steps;
use crate::transcript;
use crate::{gateway::Gateway, jobs::JobManager};
use futures::stream::StreamExt;
use serde::Deserialize;
use std::path::PathBuf;
use std::time::Instant;
use tauri::{AppHandle, State};

fn err(e: impl std::fmt::Display) -> String {
    format!("{e:#}")
}

// ---------------------------------------------------------------- settings

#[tauri::command]
pub fn load_config() -> AppConfig {
    config::load()
}

#[tauri::command]
pub fn save_config(cfg: AppConfig) -> Result<AppConfig, String> {
    config::save(&cfg).map_err(err)?;
    Ok(config::load())
}

#[tauri::command]
pub fn config_location() -> String {
    config::config_path().to_string_lossy().to_string()
}

/// The format profiles this build knows about, built-in and user-supplied.
#[tauri::command]
pub fn list_profiles() -> Vec<serde_json::Value> {
    profile::catalog()
}

/// Where to drop a profile for a format nobody has written an adapter for yet.
#[tauri::command]
pub fn profiles_dir() -> String {
    let dir = profile::profiles_dir();
    // Create it on demand so the path we hand out is one the user can open.
    let _ = std::fs::create_dir_all(&dir);
    dir.to_string_lossy().to_string()
}

/// Best guesses for what an unrecognised file is, best first.
#[tauri::command]
pub fn detect_profile(path: String) -> Result<Vec<serde_json::Value>, String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("no such file: {}", p.display()));
    }
    let probe = profile::sample(&p, 32);
    if probe.is_empty() {
        return Err("nothing parseable in that file".to_string());
    }
    Ok(profile::detect(&probe)
        .into_iter()
        .map(|(p, score)| {
            serde_json::json!({
                "id": p.id,
                "name": p.name,
                "score": (score * 1000.0).round() / 1000.0,
            })
        })
        .collect())
}

// ---------------------------------------------------------------- reading

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanArgs {
    pub root: String,
    /// Parallel readers. Disk-bound, so a small number is plenty.
    #[serde(default = "default_scan_concurrency")]
    pub concurrency: usize,
    /// Format profile to apply. `auto` or absent means detect per file.
    #[serde(default)]
    pub profile: Option<String>,
}

fn default_scan_concurrency() -> usize {
    8
}

/// Walk a directory and summarise every transcript in it.
///
/// Summaries are computed in parallel because a session directory is typically
/// hundreds of megabytes of JSONL and the parse is CPU-bound per file.
#[tauri::command]
pub async fn scan_sessions(args: ScanArgs) -> Result<ScanResult, String> {
    let started = Instant::now();
    let root = PathBuf::from(&args.root);
    if !root.exists() {
        return Err(format!("no such directory: {}", root.display()));
    }
    let files = transcript::list_transcripts(&root).map_err(err)?;
    let files_seen = files.len();
    let forced = args.profile.clone();

    let results: Vec<SessionSummary> = futures::stream::iter(files.into_iter().map(|path| {
        // One clone per file: the closure below runs many times, so it cannot
        // hand its own copy of the profile id to each future.
        let forced = forced.clone();
        async move {
            let file_name = path
                .file_name()
                .map(|x| x.to_string_lossy().to_string())
                .unwrap_or_default();
            // Paths are the identity here: two directories can hold sessions
            // with the same id, and collapsing them would hide data.
            let path_str = path.to_string_lossy().to_string();
            match tokio::task::spawn_blocking({
                let path = path.clone();
                let path_str = path_str.clone();
                let file_name = file_name.clone();
                let forced = forced.clone();
                move || -> Result<SessionSummary, String> {
                    let (records, _bad) =
                        profile::read_auto(&path, forced.as_deref()).map_err(|e| e.to_string())?;
                    if records.is_empty() {
                        return Err("empty transcript".to_string());
                    }
                    let id = transcript::session_id(&records, &path);
                    Ok(transcript::summarize(&records, id, file_name, path_str))
                }
            })
            .await
            {
                Ok(Ok(mut s)) => {
                    s.error = None;
                    Some(s)
                }
                Ok(Err(e)) => Some(SessionSummary {
                    id: file_name.clone(),
                    file: file_name,
                    path: path_str,
                    error: Some(e),
                    ..Default::default()
                }),
                Err(_) => None,
            }
        }
    }))
    .buffer_unordered(args.concurrency.clamp(1, 32))
    .filter_map(|x| async move { x })
    .collect()
    .await;

    let mut sessions = results;
    sessions.sort_by(|a, b| {
        b.first_ts
            .cmp(&a.first_ts)
            .then(a.file.cmp(&b.file))
    });
    let files_failed = sessions.iter().filter(|s| s.error.is_some()).count();

    Ok(ScanResult {
        root: root.to_string_lossy().to_string(),
        sessions,
        files_seen,
        files_failed,
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceArgs {
    pub path: String,
    pub session_id: Option<String>,
    #[serde(default)]
    pub digest: Option<DigestOptions>,
    /// Format profile to apply. `auto` or absent means detect.
    #[serde(default)]
    pub profile: Option<String>,
}

/// Fully parse one transcript: timeline + workspace-derived file list + turns.
#[tauri::command]
pub async fn load_trace(args: TraceArgs) -> Result<Trace, String> {
    let path = PathBuf::from(&args.path);
    if !path.exists() {
        return Err(format!("no such file: {}", path.display()));
    }
    let digest = args.digest.unwrap_or_default();
    let session_id = args.session_id.clone();
    let forced = args.profile.clone();

    tokio::task::spawn_blocking(move || -> Result<Trace, String> {
        let (records, bad_lines) =
            profile::read_auto(&path, forced.as_deref()).map_err(err)?;
        if records.is_empty() {
            return Err("transcript has no parsable records".to_string());
        }
        let id = session_id.unwrap_or_else(|| transcript::session_id(&records, &path));
        let file_name = path
            .file_name()
            .map(|x| x.to_string_lossy().to_string())
            .unwrap_or_default();
        let summary = transcript::summarize(&records, id, file_name, path.to_string_lossy().to_string());
        let collected = steps::build_steps(&records);
        let turns = segments::segment_turns(&summary, &collected.steps, digest);

        Ok(Trace {
            summary,
            steps: collected.steps,
            turns,
            files: collected.files,
            bash_commands: collected.bash_commands,
            bad_lines,
        })
    })
    .await
    .map_err(err)?
}

/// Workspace snapshot as of a step: which files exist and what they hold.
#[tauri::command]
pub async fn workspace_at(args: TraceArgs) -> Result<Vec<(String, String)>, String> {
    let trace = load_trace(args).await?;
    Ok(steps::reconstruct_workspace(&trace.steps, trace.steps.len()).files)
}

/// Most-edited files across a set of sessions — a cheap thrash read-out.
#[tauri::command]
pub async fn edit_leaderboard(paths: Vec<String>) -> Result<Vec<(String, usize)>, String> {
    let mut totals: std::collections::BTreeMap<String, usize> = Default::default();
    for p in paths {
        let path = PathBuf::from(&p);
        if !path.exists() {
            continue;
        }
        let (records, _) =
            tokio::task::spawn_blocking(move || transcript::read_records(&path).map_err(err))
                .await
                .map_err(err)??;
        let collected = steps::build_steps(&records);
        for (file, n) in steps::edit_counts(&collected.steps) {
            *totals.entry(file).or_insert(0) += n;
        }
    }
    let mut v: Vec<(String, usize)> = totals.into_iter().collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    v.truncate(50);
    Ok(v)
}

// ---------------------------------------------------------------- gateway

#[tauri::command]
pub async fn probe_gateway(cfg: config::GatewayConfig) -> Result<(bool, String), String> {
    let gw = Gateway::new(cfg).map_err(err)?;
    gw.probe().await.map_err(err)
}

// ---------------------------------------------------------------- jobs

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartJobArgs {
    pub segments: Vec<TurnSegment>,
    pub schema: LabelSchema,
    pub gateway: config::GatewayConfig,
    /// Appended to every prompt, after the rubric instructions. Useful for
    /// project-specific context that should not be baked into the rubric.
    #[serde(default)]
    pub system_extra: String,
    #[serde(default)]
    pub output_path: Option<String>,
}

#[tauri::command]
pub fn start_job(
    app: AppHandle,
    jobs: State<'_, JobManager>,
    args: StartJobArgs,
) -> Result<String, String> {
    if args.segments.is_empty() {
        return Err("nothing to label: select at least one turn".to_string());
    }
    let output = args.output_path.map(PathBuf::from);
    jobs.start(
        app,
        args.segments,
        args.schema,
        args.gateway,
        args.system_extra,
        output,
    )
    .map_err(err)
}

#[tauri::command]
pub fn job_status(jobs: State<'_, JobManager>, id: String) -> Option<JobProgress> {
    jobs.get(&id)
}

#[tauri::command]
pub fn list_jobs(jobs: State<'_, JobManager>) -> Vec<JobProgress> {
    jobs.list()
}

#[tauri::command]
pub fn cancel_job(jobs: State<'_, JobManager>, id: String) -> bool {
    jobs.cancel(&id)
}

#[tauri::command]
pub fn job_results(jobs: State<'_, JobManager>, id: String) -> Vec<LabelRecord> {
    jobs.results(&id)
}

#[tauri::command]
pub fn forget_job(jobs: State<'_, JobManager>, id: String) {
    jobs.forget(&id)
}

#[tauri::command]
pub fn export_results(
    records: Vec<LabelRecord>,
    path: String,
    fields: Vec<LabelField>,
) -> Result<usize, String> {
    crate::jobs::export(&records, &PathBuf::from(path), &fields).map_err(err)
}

/// Pull rows straight off disk, so a job started in a previous session can still
/// be reviewed and exported.
#[tauri::command]
pub async fn read_jsonl(path: String, limit: usize) -> Result<Vec<serde_json::Value>, String> {
    let p = PathBuf::from(&path);
    let text = tokio::fs::read_to_string(&p).await.map_err(err)?;
    let lim = if limit == 0 { usize::MAX } else { limit };
    Ok(text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .take(lim)
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .collect())
}
// ---------------------------------------------------------------- discovery

#[derive(serde::Serialize)]
pub struct RootCandidate {
    pub label: String,
    pub path: String,
    pub exists: bool,
    /// How many transcripts sit below the candidate, so the UI can prefer the
    /// richest one without asking the user to guess.
    pub n_jsonl: usize,
}

/// Well-known locations agent transcripts accumulate in. Ordered by how likely
/// they are to be the thing the user wants.
#[tauri::command]
pub async fn default_roots() -> Vec<RootCandidate> {
    let home = dirs::home_dir().unwrap_or_default();
    let mut out: Vec<RootCandidate> = Vec::new();

    let mut push = |label: &str, p: std::path::PathBuf| {
        if out.iter().any(|c| c.path == p.to_string_lossy()) {
            return;
        }
        let exists = p.is_dir();
        let n_jsonl = if exists {
            crate::transcript::list_transcripts(&p).map(|v| v.len()).unwrap_or(0)
        } else {
            0
        };
        out.push(RootCandidate {
            label: label.to_string(),
            path: p.to_string_lossy().to_string(),
            exists,
            n_jsonl,
        });
    };

    push("Claude Code", home.join(".claude").join("projects"));
    push("Codex", home.join(".codex").join("sessions"));
    push("Cursor", home.join(".cursor").join("projects"));
    push("Aider", home.join(".aider"));
    push("Downloads", home.join("Downloads"));

    // Richest first among the ones that actually exist.
    out.sort_by(|a, b| b.n_jsonl.cmp(&a.n_jsonl));
    out
}

#[derive(serde::Serialize)]
pub struct FolderCount {
    pub path: String,
    pub exists: bool,
    pub transcripts: usize,
}

/// How many transcripts each folder holds, for the project list.
///
/// Directories are walked but no file is parsed, so this stays cheap enough to
/// refresh whenever the list changes rather than only after a full scan. A
/// folder that no longer exists comes back with `exists: false` so the sidebar
/// can say so instead of showing a silent zero.
#[tauri::command]
pub async fn count_transcripts(paths: Vec<String>) -> Vec<FolderCount> {
    futures::stream::iter(paths.into_iter().map(|p| async move {
        let probe = p.clone();
        let (exists, transcripts) = tokio::task::spawn_blocking(move || {
            let path = PathBuf::from(&probe);
            if !path.is_dir() {
                return (false, 0);
            }
            let n = crate::transcript::list_transcripts(&path)
                .map(|v| v.len())
                .unwrap_or(0);
            (true, n)
        })
        .await
        .unwrap_or((false, 0));
        FolderCount { path: p, exists, transcripts }
    }))
    .buffered(8)
    .collect()
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway directory, emptied first so a rerun cannot inherit files.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tracematter-count-{}-{}",
            std::process::id(),
            name
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[tokio::test]
    async fn counts_transcripts_and_ignores_other_files() {
        let dir = scratch("jsonl");
        std::fs::write(dir.join("one.jsonl"), "{}\n").expect("write");
        std::fs::write(dir.join("two.jsonl"), "{}\n").expect("write");
        std::fs::write(dir.join("notes.txt"), "not a transcript").expect("write");

        let out = count_transcripts(vec![dir.to_string_lossy().to_string()]).await;

        assert_eq!(out.len(), 1);
        assert!(out[0].exists);
        assert_eq!(out[0].transcripts, 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_vanished_folder_says_so_instead_of_reporting_zero() {
        let dir = scratch("gone");
        let missing = dir.join("not-here");

        let out = count_transcripts(vec![missing.to_string_lossy().to_string()]).await;

        assert_eq!(out.len(), 1);
        assert!(!out[0].exists);
        assert_eq!(out[0].transcripts, 0);
        assert!(out[0].path.ends_with("not-here"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn the_answer_holds_the_order_the_list_arrived_in() {
        let dir = scratch("order");
        let empty = dir.join("empty");
        std::fs::create_dir_all(&empty).expect("empty dir");
        let first = dir.to_string_lossy().to_string();
        let second = empty.to_string_lossy().to_string();

        let out = count_transcripts(vec![second.clone(), first.clone()]).await;

        assert_eq!(out[0].path, second);
        assert_eq!(out[1].path, first);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
