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

pub fn start_workspace_watch(
    app: AppHandle,
    registry: &WatchRegistry,
    workspace_id: i64,
    root: PathBuf,
) -> Result<(), String> {
    if !root.is_dir() {
        return Err(format!("watch root is not a directory: {}", root.display()));
    }

    let mut map = registry.inner.lock().map_err(|e| e.to_string())?;
    map.remove(&workspace_id);

    let app_handle = app.clone();
    let mut watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                if should_notify(&event.kind) {
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
    Ok(())
}

pub fn stop_workspace_watch(registry: &WatchRegistry, workspace_id: i64) -> Result<(), String> {
    let mut map = registry.inner.lock().map_err(|e| e.to_string())?;
    map.remove(&workspace_id);
    Ok(())
}
