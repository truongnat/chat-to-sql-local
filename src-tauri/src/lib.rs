mod db;
mod models;
mod ollama_download;
mod ollama_launch;
mod ollama_proxy;
mod vector_index;
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

#[derive(serde::Serialize, serde::Deserialize)]
pub struct VerifiedModel {
    pub name: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub description: String,
    #[serde(rename = "parameterSize")]
    pub parameter_size: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct VerifiedModelsConfig {
    pub verified_models: Vec<VerifiedModel>,
}

#[tauri::command]
fn get_verified_models() -> Result<Vec<VerifiedModel>, String> {
    let json = include_str!("verified_models.json");
    let config: VerifiedModelsConfig =
        serde_json::from_str(json).map_err(|e| format!("verified_models.json: {e}"))?;
    Ok(config.verified_models)
}

pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    pub watchers: WatchRegistry,
    pub db_path: PathBuf,
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
        if let Err(e) = watcher::start_workspace_watch(
            app.clone(),
            &state.watchers,
            w.id,
            PathBuf::from(&w.root_path),
        ) {
            eprintln!(
                "[sql-chat] no file watcher for workspace \"{}\" (id {}): {}. \
                 Check Edit workspace → the path must be a .sql/.ddl file or a folder of those files.",
                w.name, w.id, e
            );
        }
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
fn update_workspace(
    app: tauri::AppHandle,
    state: State<AppState>,
    id: i64,
    name: Option<String>,
    root_path: Option<String>,
) -> Result<(), String> {
    let touch_root = root_path.as_ref().map(|p| !p.trim().is_empty()).unwrap_or(false);
    if touch_root {
        watcher::stop_workspace_watch(&state.watchers, id)?;
    }
    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        if let Some(ref n) = name {
            let t = n.trim();
            if !t.is_empty() {
                db::update_workspace_name(&conn, id, t).map_err(|e| e.to_string())?;
            }
        }
        if let Some(ref p) = root_path {
            let t = p.trim();
            if t.is_empty() {
                return Err("root_path is empty".to_string());
            }
            db::update_workspace_root_path(&conn, id, t).map_err(|e| e.to_string())?;
        }
    }
    if let Some(p) = root_path {
        let t = p.trim();
        if !t.is_empty() {
            watcher::start_workspace_watch(
                app.clone(),
                &state.watchers,
                id,
                std::path::PathBuf::from(t),
            )?;
        }
    }
    Ok(())
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
fn update_chat_session_title(
    state: State<AppState>,
    session_id: i64,
    title: String,
) -> Result<(), String> {
    let t = title.trim();
    if t.is_empty() {
        return Err("title is empty".to_string());
    }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::update_chat_session_title(&conn, session_id, t).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_chat_session(
    state: State<AppState>,
    workspace_id: i64,
    session_id: i64,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let ok =
        db::delete_chat_session_for_workspace(&conn, workspace_id, session_id).map_err(|e| e.to_string())?;
    if !ok {
        return Err("chat session not found".to_string());
    }
    Ok(())
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

#[tauri::command]
fn rebuild_schema_vector_index(
    app: tauri::AppHandle,
    state: State<AppState>,
    workspace_id: i64,
) -> Result<(), String> {
    let db_path = state.db_path.clone();
    std::thread::spawn(move || {
        vector_index::rebuild_workspace_index_blocking(&app, &db_path, workspace_id);
    });
    Ok(())
}

#[tauri::command]
fn search_schema_for_chat(
    state: State<AppState>,
    workspace_id: i64,
    query: String,
    top_k: Option<i64>,
) -> Result<Vec<vector_index::SchemaSearchHit>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let k = top_k.unwrap_or(8).clamp(1, 32) as usize;
    vector_index::search_schema_chunks(&conn, workspace_id, &query, k)
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
                db_path: path.clone(),
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
            update_workspace,
            delete_workspace,
            rescan_workspace,
            save_parsed_schema,
            load_parsed_schema,
            list_sql_files,
            load_parsed_schema_objects,
            get_workspace_schema_stats,
            create_chat_session,
            list_chat_sessions,
            update_chat_session_title,
            delete_chat_session,
            append_chat_message,
            list_chat_messages,
            rebuild_schema_vector_index,
            search_schema_for_chat,
            get_verified_models,
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
