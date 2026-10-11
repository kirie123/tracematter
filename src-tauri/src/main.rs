// Hide the console window on Windows release builds; keep it in debug so panics
// and `println!` diagnostics stay visible.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod config;
mod gateway;
mod jobs;
mod model;
mod segments;
mod steps;
mod transcript;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(jobs::JobManager::new())
        .invoke_handler(tauri::generate_handler![
            // settings
            commands::load_config,
            commands::save_config,
            commands::config_location,
            // reading
            commands::default_roots,
            commands::scan_sessions,
            commands::load_trace,
            commands::workspace_at,
            commands::edit_leaderboard,
            // gateway
            commands::probe_gateway,
            // batch jobs
            commands::start_job,
            commands::job_status,
            commands::list_jobs,
            commands::cancel_job,
            commands::job_results,
            commands::forget_job,
            commands::export_results,
            commands::read_jsonl,
        ])
        .run(tauri::generate_context!())
        .expect("TraceMatter failed to start");
}