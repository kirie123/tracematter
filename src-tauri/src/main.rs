// Hide the console window on Windows release builds; keep it in debug so panics
// and `println!` diagnostics stay visible.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;
mod commands;
mod config;
mod data;
mod gateway;
mod jobs;
mod model;
mod parquet_data;
mod profile;
mod providers;
mod segments;
mod steps;
mod transcript;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(jobs::JobManager::new())
        .manage(agent::AgentState::default())
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
            // data
            commands::data_open,
            commands::data_row,
            commands::data_set,
            commands::data_fork,
            commands::data_overwrite,
            commands::data_diff,
            // parquet
            commands::parquet_schema,
            commands::parquet_page,
            commands::parquet_cell,
            commands::parquet_index,
            // agent
            agent::agent_status,
            agent::agent_send,
            agent::agent_stop,
            agent::agent_reset,
            agent::agent_log,
        ])
        .run(tauri::generate_context!())
        .expect("TraceMatter failed to start");
}