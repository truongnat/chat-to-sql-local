//! Best-effort launch of the Ollama daemon / app when it is installed but not listening on :11434.

use std::path::PathBuf;
use std::process::{Command, Stdio};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Hide console window for background `ollama serve` on Windows.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn spawn_ollama_serve_detached() -> std::io::Result<()> {
    let mut cmd = Command::new("ollama");
    cmd.arg("serve")
        .env("OLLAMA_HOST", "127.0.0.1:11434")
        .env("OLLAMA_ORIGINS", "127.0.0.1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn().map(|_| ())
}

#[tauri::command]
pub fn try_start_ollama() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let st = Command::new("open")
            .args(["-a", "Ollama"])
            .status()
            .map_err(|e| format!("Could not run `open -a Ollama`: {e}"))?;
        if st.success() {
            return Ok(
                "Launched the Ollama app. Wait a few seconds for the API on port 11434.".into(),
            );
        }

        let app = PathBuf::from("/Applications/Ollama.app");
        if app.exists() {
            let st2 = Command::new("open")
                .arg(&app)
                .status()
                .map_err(|e| format!("Could not open Ollama.app: {e}"))?;
            if st2.success() {
                return Ok("Opened Ollama from /Applications. Wait a few seconds.".into());
            }
        }

        spawn_ollama_serve_detached().map_err(|e| {
            format!(
                "Ollama.app not found and `ollama serve` failed: {e}. Install from https://ollama.com/download"
            )
        })?;
        return Ok("Started `ollama serve` in the background.".into());
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let exe = PathBuf::from(&local)
                .join("Programs")
                .join("Ollama")
                .join("Ollama.exe");
            if exe.is_file() {
                Command::new(&exe)
                    .env("OLLAMA_HOST", "127.0.0.1:11434")
                    .env("OLLAMA_ORIGINS", "127.0.0.1")
                    .spawn()
                    .map_err(|e| format!("Could not start {exe:?}: {e}"))?;
                return Ok("Started Ollama from your user Programs folder.".into());
            }
        }

        let st = Command::new("cmd")
            .args(["/C", "start", "", "ollama", "serve"])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
        if let Ok(s) = st {
            if s.success() {
                return Ok("Tried to start `ollama serve` via cmd.".into());
            }
        }

        spawn_ollama_serve_detached().map_err(|e| {
            format!(
                "Could not start Ollama. Install from https://ollama.com/download — {e}"
            )
        })?;
        return Ok("Started `ollama serve` in the background.".into());
    }

    #[cfg(target_os = "linux")]
    {
        let sys = Command::new("systemctl")
            .args(["--user", "start", "ollama"])
            .status();
        if let Ok(st) = sys {
            if st.success() {
                return Ok("Started the Ollama systemd user service.".into());
            }
        }

        spawn_ollama_serve_detached().map_err(|e| {
            format!(
                "Could not run `ollama serve`. Install Ollama from https://ollama.com/download or your package manager — {e}"
            )
        })?;
        return Ok("Started `ollama serve` in the background.".into());
    }

    #[cfg(not(any(
        target_os = "macos",
        target_os = "windows",
        target_os = "linux"
    )))]
    {
        Err("Starting Ollama is not implemented on this platform.".into())
    }
}
