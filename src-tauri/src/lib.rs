mod db;
mod models;
mod ollama_download;
mod ollama_launch;
mod ollama_proxy;
mod watcher;

use models::{
    ChatMessage, ChatSession, FileContent, ParsedSchemaObjectRecord, ParsedSchemaPayload,
    SqlFileRecord, Workspace, WorkspaceSchemaStats,
};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;
use tauri::State;
use watcher::WatchRegistry;

pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    pub watchers: WatchRegistry,
}

fn db_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?;
    dir.push("sql-chat");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("app.db"))
}

fn restart_watchers(app: &tauri::AppHandle, state: &AppState) -> Result<(), String> {
    let workspaces = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        db::list_workspaces(&conn).map_err(|e| e.to_string())?
    };
    for w in workspaces {
        watcher::start_workspace_watch(
            app.clone(),
            &state.watchers,
            w.id,
            PathBuf::from(w.root_path),
        )?;
    }
    Ok(())
}

#[tauri::command]
fn create_workspace(
    app: tauri::AppHandle,
    state: State<AppState>,
    name: String,
    root_path: String,
) -> Result<Workspace, String> {
    let ws = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        db::create_workspace(&conn, &name, &root_path).map_err(|e| e.to_string())?
    };
    watcher::start_workspace_watch(
        app,
        &state.watchers,
        ws.id,
        PathBuf::from(&ws.root_path),
    )?;
    Ok(ws)
}

#[tauri::command]
fn list_workspaces(state: State<AppState>) -> Result<Vec<Workspace>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::list_workspaces(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_workspace(state: State<AppState>, id: i64) -> Result<Option<Workspace>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::get_workspace(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_workspace_dialect(state: State<AppState>, id: i64, dialect: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::update_workspace_dialect(&conn, id, &dialect).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_workspace_model(
    state: State<AppState>,
    id: i64,
    model: Option<String>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::update_workspace_model(&conn, id, model.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_workspace(state: State<AppState>, id: i64) -> Result<(), String> {
    watcher::stop_workspace_watch(&state.watchers, id)?;
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::delete_workspace(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
fn rescan_workspace(state: State<AppState>, id: i64) -> Result<Vec<FileContent>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::rescan_workspace_files(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_parsed_schema(
    state: State<AppState>,
    workspace_id: i64,
    schema: ParsedSchemaPayload,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::save_parsed_schema(&conn, workspace_id, &schema).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_parsed_schema(
    state: State<AppState>,
    workspace_id: i64,
) -> Result<Vec<db::LoadedTable>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::load_parsed_schema(&conn, workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_sql_files(state: State<AppState>, workspace_id: i64) -> Result<Vec<SqlFileRecord>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::list_sql_file_records(&conn, workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_parsed_schema_objects(
    state: State<AppState>,
    workspace_id: i64,
) -> Result<Vec<ParsedSchemaObjectRecord>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::load_parsed_schema_objects(&conn, workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_workspace_schema_stats(
    state: State<AppState>,
    workspace_id: i64,
) -> Result<WorkspaceSchemaStats, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::get_workspace_schema_stats(&conn, workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_chat_session(
    state: State<AppState>,
    workspace_id: i64,
    title: String,
) -> Result<ChatSession, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::create_chat_session(&conn, workspace_id, &title).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_chat_sessions(state: State<AppState>, workspace_id: i64) -> Result<Vec<ChatSession>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::list_chat_sessions(&conn, workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn append_chat_message(
    state: State<AppState>,
    session_id: i64,
    role: String,
    content: String,
) -> Result<ChatMessage, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::append_chat_message(&conn, session_id, &role, &content).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_chat_messages(state: State<AppState>, session_id: i64) -> Result<Vec<ChatMessage>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::list_chat_messages(&conn, session_id).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let path = db_file_path(app.handle())?;
            let conn = db::open_db(&path).map_err(|e| format!("db open: {e}"))?;
            let state = AppState {
                db: Mutex::new(conn),
                watchers: WatchRegistry {
                    inner: std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
                },
            };
            app.manage(state);
            let handle = app.handle().clone();
            let st = handle.state::<AppState>();
            restart_watchers(&handle, &st).map_err(|e| format!("watchers: {e}"))?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_workspace,
            list_workspaces,
            get_workspace,
            update_workspace_dialect,
            update_workspace_model,
            delete_workspace,
            rescan_workspace,
            save_parsed_schema,
            load_parsed_schema,
            list_sql_files,
            load_parsed_schema_objects,
            get_workspace_schema_stats,
            create_chat_session,
            list_chat_sessions,
            append_chat_message,
            list_chat_messages,
            ollama_launch::try_start_ollama,
            ollama_download::start_ollama_installer_download,
            ollama_download::ollama_installer_exists,
            ollama_download::install_ollama_from_download,
            ollama_proxy::ollama_api_tags,
            ollama_proxy::ollama_api_ps,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
