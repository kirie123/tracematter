// Hide the console window on Windows release builds; keep it in debug so panics
// and `println!` diagnostics stay visible.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod analyst;
mod commands;
mod config;
mod gateway;
mod jobs;
mod model;
mod profile;
mod providers;
mod segments;
mod steps;
mod transcript;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(jobs::JobManager::new())
        .manage(analyst::AnalystState::default())
        .invoke_handler(tauri::generate_handler![
            // settings
            commands::load_config,
            commands::save_config,
            commands::config_location,
            // format profiles
            commands::list_profiles,
            commands::profiles_dir,
            commands::detect_profile,
            // reading
            commands::default_roots,
            commands::count_transcripts,
            commands::scan_sessions,
            commands::load_trace,
            commands::workspace_at,
            commands::edit_leaderboard,
            // gateway
            commands::probe_gateway,
            commands::provider_presets,
            commands::list_models,
            // batch jobs
            commands::start_job,
            commands::job_status,
            commands::list_jobs,
            commands::cancel_job,
            commands::job_results,
            commands::forget_job,
            commands::export_results,
            commands::read_jsonl,
            // analyst
            analyst::analyst_status,
            analyst::analyst_start,
            analyst::analyst_send,
            analyst::analyst_stop,
        ])
        .run(tauri::generate_context!())
        .expect("TraceMatter failed to start");
}