use std::io::Read;
use std::time::Duration;

use serde_json::Value;

/// Try both — on some systems Ollama only answers on `localhost` (::1) or only on `127.0.0.1`.
const OLLAMA_BASES: &[&str] = &[
    "http://localhost:11434",
    "http://127.0.0.1:11434",
    "http://[::1]:11434",
];

fn fetch_ollama_path(path: &str) -> Result<String, String> {
    if !path.starts_with('/') || path.contains("..") {
        return Err("invalid path".to_string());
    }
    let mut last_err = String::from("could not reach Ollama on any address");
    for base in OLLAMA_BASES {
        let url = format!("{base}{path}");
        match ureq::get(&url)
            .timeout(Duration::from_secs(25))
            .call()
        {
            Ok(resp) => {
                let status = resp.status();
                if !(200..300).contains(&status) {
                    last_err = format!("{url} → HTTP {status}");
                    continue;
                }
                let mut body = String::new();
                match resp
                    .into_reader()
                    .take(64 * 1024 * 1024)
                    .read_to_string(&mut body)
                {
                    Ok(_) => return Ok(body),
                    Err(e) => last_err = format!("read {url}: {e}"),
                }
            }
            Err(e) => last_err = format!("{url}: {e}"),
        }
    }
    Err(last_err)
}

/// Parsed JSON from `GET /api/tags` (avoids string round-trip through IPC).
#[tauri::command]
pub fn ollama_api_tags() -> Result<Value, String> {
    let body = fetch_ollama_path("/api/tags")?;
    serde_json::from_str(&body).map_err(|e| format!("Ollama /api/tags: invalid JSON ({e})"))
}

#[tauri::command]
pub fn ollama_api_ps() -> Result<Value, String> {
    match fetch_ollama_path("/api/ps") {
        Ok(body) => Ok(serde_json::from_str(&body).unwrap_or_else(|_| {
            serde_json::json!({ "models": [] })
        })),
        Err(_) => Ok(serde_json::json!({ "models": [] })),
    }
}

/// Public library catalog (`GET https://ollama.com/api/tags`) — same JSON shape as local `/api/tags`.
#[tauri::command]
pub fn ollama_com_api_tags() -> Result<Value, String> {
    let url = "https://ollama.com/api/tags";
    match ureq::get(url).timeout(Duration::from_secs(45)).call() {
        Ok(resp) => {
            let status = resp.status();
            if !(200..300).contains(&status) {
                return Err(format!("{url} → HTTP {status}"));
            }
            let mut body = String::new();
            resp.into_reader()
                .take(32 * 1024 * 1024)
                .read_to_string(&mut body)
                .map_err(|e| format!("read {url}: {e}"))?;
            serde_json::from_str(&body).map_err(|e| format!("ollama.com /api/tags: invalid JSON ({e})"))
        }
        Err(e) => Err(format!("{url}: {e}")),
    }
}
