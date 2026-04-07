use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

pub struct WatchRegistry {
    pub inner: Arc<Mutex<HashMap<i64, RecommendedWatcher>>>,
}

fn should_notify(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Create(_)
            | EventKind::Modify(_)
            | EventKind::Remove(_)
            | EventKind::Other
    )
}

fn path_is_sql_or_ddl(p: &std::path::Path) -> bool {
    p.extension()
        .and_then(|s| s.to_str())
        .map(|e| {
            let e = e.to_ascii_lowercase();
            e == "sql" || e == "ddl"
        })
        .unwrap_or(false)
}

pub fn start_workspace_watch(
    app: AppHandle,
    registry: &WatchRegistry,
    workspace_id: i64,
    root: PathBuf,
) -> Result<(), String> {
    let mut map = registry.inner.lock().map_err(|e| e.to_string())?;
    map.remove(&workspace_id);

    let app_handle = app.clone();

    if root.is_dir() {
        let root_clone = root.clone();
        let mut watcher = RecommendedWatcher::new(
            move |res: Result<Event, notify::Error>| {
                if let Ok(event) = res {
                    if !should_notify(&event.kind) {
                        return;
                    }
                    let touches_sql = event.paths.iter().any(|p| {
                        p.starts_with(&root_clone) && path_is_sql_or_ddl(p)
                    });
                    if touches_sql {
                        let _ = app_handle.emit(
                            "workspace-files-changed",
                            json!({ "workspaceId": workspace_id }),
                        );
                    }
                }
            },
            Config::default(),
        )
        .map_err(|e| e.to_string())?;

        watcher
            .watch(&root, RecursiveMode::Recursive)
            .map_err(|e| e.to_string())?;
        map.insert(workspace_id, watcher);
        return Ok(());
    }

    if !root.is_file() {
        return Err(format!(
            "workspace root must be a .sql/.ddl file or a directory: {}",
            root.display()
        ));
    }
    let ext = root
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext != "sql" && ext != "ddl" {
        return Err(format!(
            "watch path must be .sql or .ddl: {}",
            root.display()
        ));
    }

    let parent = root
        .parent()
        .ok_or_else(|| format!("sql file has no parent directory: {}", root.display()))?
        .to_path_buf();
    let file_name = root
        .file_name()
        .ok_or_else(|| format!("sql file has no name: {}", root.display()))?
        .to_owned();

    let mut watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                if !should_notify(&event.kind) {
                    return;
                }
                let touched = event.paths.iter().any(|p| {
                    p.file_name()
                        .map(|n| n == file_name.as_os_str())
                        .unwrap_or(false)
                });
                if touched {
                    let _ = app_handle.emit(
                        "workspace-files-changed",
                        json!({ "workspaceId": workspace_id }),
                    );
                }
            }
        },
        Config::default(),
    )
    .map_err(|e| e.to_string())?;

    watcher
        .watch(&parent, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    map.insert(workspace_id, watcher);
    Ok(())
}

pub fn stop_workspace_watch(registry: &WatchRegistry, workspace_id: i64) -> Result<(), String> {
    let mut map = registry.inner.lock().map_err(|e| e.to_string())?;
    map.remove(&workspace_id);
    Ok(())
}
