//! Download Ollama installers in-app (same artifacts as ollama.com) and launch local install.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

static DOWNLOAD_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

fn installers_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let mut dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?;
    dir.push("sql-chat");
    dir.push("installers");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn installer_path(app: &AppHandle) -> Result<PathBuf, String> {
    let name = installer_filename();
    Ok(installers_dir(app)?.join(name))
}

fn installer_filename() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "Ollama.dmg"
    }
    #[cfg(target_os = "windows")]
    {
        "OllamaSetup.exe"
    }
    #[cfg(target_os = "linux")]
    {
        "ollama-install.sh"
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        "ollama-unknown"
    }
}

fn download_url() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "https://ollama.com/download/Ollama.dmg"
    }
    #[cfg(target_os = "windows")]
    {
        "https://ollama.com/download/OllamaSetup.exe"
    }
    #[cfg(target_os = "linux")]
    {
        "https://ollama.com/install.sh"
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        ""
    }
}

#[derive(Clone, Serialize)]
pub struct DownloadProgressPayload {
    pub received: u64,
    pub total: Option<u64>,
}

#[derive(Clone, Serialize)]
pub struct DownloadDonePayload {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn emit_progress(app: &AppHandle, received: u64, total: Option<u64>) {
    let _ = app.emit(
        "ollama-download-progress",
        DownloadProgressPayload { received, total },
    );
}

fn emit_done(app: &AppHandle, path: PathBuf, error: Option<String>) {
    let _ = app.emit(
        "ollama-download-done",
        DownloadDonePayload {
            path: path.to_string_lossy().into_owned(),
            error,
        },
    );
}

fn download_file(app: &AppHandle, url: &str, dest: &Path) -> Result<(), String> {
    let part = dest.with_extension("part");
    if part.exists() {
        fs::remove_file(&part).map_err(|e| e.to_string())?;
    }

    let resp = ureq::get(url)
        .timeout(Duration::from_secs(7200))
        .call()
        .map_err(|e| format!("Request failed: {e}"))?;

    let status = resp.status();
    if !(200..300).contains(&status) {
        return Err(format!("Download failed: HTTP {status}"));
    }

    let total = resp
        .header("Content-Length")
        .and_then(|s: &str| s.parse::<u64>().ok());

    let mut reader = resp.into_reader();
    let mut file = File::create(&part).map_err(|e| e.to_string())?;
    let mut buf = [0u8; 64 * 1024];
    let mut received: u64 = 0;

    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("Read error: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .map_err(|e| format!("Write error: {e}"))?;
        received += n as u64;
        emit_progress(app, received, total);
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);

    fs::rename(&part, dest).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn start_ollama_installer_download(app: AppHandle) -> Result<(), String> {
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        return Err("Downloads are not supported on this platform.".into());
    }

    if DOWNLOAD_IN_PROGRESS
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("A download is already in progress.".into());
    }

    let url = download_url();
    if url.is_empty() {
        DOWNLOAD_IN_PROGRESS.store(false, Ordering::SeqCst);
        return Err("Unsupported platform.".into());
    }

    let dest = installer_path(&app)?;
    let app_thread = app.clone();

    std::thread::spawn(move || {
        let result = download_file(&app_thread, url, &dest);
        DOWNLOAD_IN_PROGRESS.store(false, Ordering::SeqCst);
        match result {
            Ok(()) => emit_done(&app_thread, dest, None),
            Err(e) => emit_done(&app_thread, dest, Some(e)),
        }
    });

    Ok(())
}

#[tauri::command]
pub fn ollama_installer_exists(app: AppHandle) -> Result<bool, String> {
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        return Ok(false);
    }
    let p = installer_path(&app)?;
    Ok(p.is_file() && p.metadata().map(|m| m.len() > 0).unwrap_or(false))
}

#[cfg(target_os = "macos")]
fn install_macos_dmg(app: &AppHandle, dmg: &Path) -> Result<String, String> {
    let mount_base = installers_dir(app)?;
    let mount = mount_base.join("ollama_dmg_mount");
    if mount.exists() {
        let _ = Command::new("hdiutil")
            .args(["detach", "-force", mount.to_str().ok_or("path")?])
            .status();
        let _ = fs::remove_dir(&mount);
    }
    fs::create_dir_all(&mount).map_err(|e| e.to_string())?;

    let st = Command::new("hdiutil")
        .args([
            "attach",
            "-nobrowse",
            "-quiet",
            "-mountpoint",
            mount.to_str().ok_or("invalid mount path")?,
            dmg.to_str().ok_or("invalid dmg path")?,
        ])
        .status()
        .map_err(|e| e.to_string())?;
    if !st.success() {
        Command::new("open").arg(dmg).spawn().map_err(|e| e.to_string())?;
        return Ok(
            "Opened the Ollama disk image. Drag **Ollama** into **Applications**, then use **Start Ollama**."
                .into(),
        );
    }

    let app_src = mount.join("Ollama.app");
    if !app_src.is_dir() {
        let _ = Command::new("hdiutil")
            .args(["detach", mount.to_str().unwrap()])
            .status();
        Command::new("open").arg(dmg).spawn().map_err(|e| e.to_string())?;
        return Ok(
            "Opened the disk image (unexpected layout). Drag **Ollama** into **Applications**."
                .into(),
        );
    }

    let system_apps = Path::new("/Applications/Ollama.app");
    let ditto_sys = Command::new("ditto")
        .args([app_src.as_os_str(), system_apps.as_os_str()])
        .status();

    let ok_sys = matches!(ditto_sys, Ok(s) if s.success());

    if !ok_sys {
        if let Some(home) = dirs::home_dir() {
            let user_apps = home.join("Applications");
            fs::create_dir_all(&user_apps).ok();
            let dst = user_apps.join("Ollama.app");
            let st = Command::new("ditto")
                .args([app_src.as_os_str(), dst.as_os_str()])
                .status();
            if matches!(st, Ok(s) if s.success()) {
                let _ = Command::new("hdiutil")
                    .args(["detach", mount.to_str().unwrap()])
                    .status();
                return Ok(
                    "Installed Ollama to **~/Applications**. Use **Start Ollama**.".into(),
                );
            }
        }
    } else {
        let _ = Command::new("hdiutil")
            .args(["detach", mount.to_str().unwrap()])
            .status();
        return Ok("Installed **Ollama** to /Applications. Use **Start Ollama**.".into());
    }

    let _ = Command::new("hdiutil")
        .args(["detach", mount.to_str().unwrap()])
        .status();
    Command::new("open").arg(dmg).spawn().map_err(|e| e.to_string())?;
    Ok(
        "Automatic install needs permission. Opened the disk image — drag **Ollama** into **Applications**."
            .into(),
    )
}

#[tauri::command]
pub fn install_ollama_from_download(app: AppHandle) -> Result<String, String> {
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        return Err("Unsupported platform.".into());
    }

    let path = installer_path(&app)?;
    if !path.is_file() {
        return Err("Installer not found. Download it first.".into());
    }

    #[cfg(target_os = "macos")]
    {
        return install_macos_dmg(&app, &path);
    }

    #[cfg(target_os = "windows")]
    {
        Command::new(&path)
            .spawn()
            .map_err(|e| format!("Could not start installer: {e}"))?;
        return Ok(
            "The Ollama setup wizard should open. Finish the steps, then use **Start Ollama**."
                .into(),
        );
    }

    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&path)
            .map_err(|e| e.to_string())?
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&path, perms).map_err(|e| e.to_string())?;

        Command::new("bash")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Could not run install script: {e}"))?;
        return Ok(
            "Started the official **install.sh**. If your system opens a terminal, follow prompts (sudo may be required).".into(),
        );
    }
}
