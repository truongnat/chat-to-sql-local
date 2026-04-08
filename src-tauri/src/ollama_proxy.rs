use std::io::Read;
use std::time::Duration;

use serde_json::Value;

#[derive(serde::Deserialize)]
struct VerifiedModel {
    name: String,
}

#[derive(serde::Deserialize)]
struct VerifiedModelsConfig {
    verified_models: Vec<VerifiedModel>,
}

pub fn is_model_verified(name: &str) -> bool {
    let json = include_str!("verified_models.json");
    if let Ok(config) = serde_json::from_str::<VerifiedModelsConfig>(json) {
        config.verified_models.iter().any(|m| m.name == name)
    } else {
        false
    }
}

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
pub fn verify_ollama_models() -> Result<Value, String> {
    let body = fetch_ollama_path("/api/tags")?;
    let tags: Value = serde_json::from_str(&body).map_err(|e| format!("Ollama /api/tags: invalid JSON ({e})"))?;
    
    let verified_json = include_str!("verified_models.json");
    let verified_config: Value = serde_json::from_str(verified_json).map_err(|e| e.to_string())?;
    let verified_list = verified_config["verified_models"].as_array().ok_or("Invalid verified_models.json")?;

    let mut results = Vec::new();
    if let Some(models) = tags["models"].as_array() {
        for model in models {
            let name = model["name"].as_str().unwrap_or("");
            let digest = model["digest"].as_str().unwrap_or("");
            
            let verified_info = verified_list.iter().find(|m| m["name"].as_str() == Some(name));
            
            let (is_verified, reason) = match verified_info {
                Some(v) => {
                    let expected_checksum = v["checksum"].as_str().unwrap_or("");
                    if digest == expected_checksum || digest.replace("sha256:", "") == expected_checksum.replace("sha256:", "") {
                        (true, "Verified".to_string())
                    } else {
                        (false, format!("Checksum mismatch. Expected: {}, Got: {}", expected_checksum, digest))
                    }
                },
                None => (false, "Model not in verified registry".to_string()),
            };

            results.push(serde_json::json!({
                "name": name,
                "digest": digest,
                "verified": is_verified,
                "reason": reason,
                "details": model
            }));
        }
    }

    Ok(serde_json::json!({ "models": results }))
}

#[tauri::command]
pub fn ollama_api_show(name: String) -> Result<Value, String> {
    let body = fetch_ollama_path_post("/api/show", serde_json::json!({ "name": name }))?;
    serde_json::from_str(&body).map_err(|e| format!("Ollama /api/show: invalid JSON ({e})"))
}

fn fetch_ollama_path_post(path: &str, body: Value) -> Result<String, String> {
    let mut last_err = String::from("could not reach Ollama on any address");
    for base in OLLAMA_BASES {
        let url = format!("{base}{path}");
        match ureq::post(&url)
            .timeout(Duration::from_secs(25))
            .send_json(&body)
        {
            Ok(resp) => {
                let status = resp.status();
                if !(200..300).contains(&status) {
                    last_err = format!("{url} → HTTP {status}");
                    continue;
                }
                let mut resp_body = String::new();
                match resp
                    .into_reader()
                    .take(64 * 1024 * 1024)
                    .read_to_string(&mut resp_body)
                {
                    Ok(_) => return Ok(resp_body),
                    Err(e) => last_err = format!("read {url}: {e}"),
                }
            }
            Err(e) => last_err = format!("{url}: {e}"),
        }
    }
    Err(last_err)
}

