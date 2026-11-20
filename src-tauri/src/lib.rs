//! Repo Board backend. The contract with the webview lives in `src/host/api.ts`.

mod data;
mod fsops;
mod git;
mod launch;
mod shell;
mod util;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_global_shortcut::Shortcut;
use tauri_plugin_opener::OpenerExt;

use data::{DataDirs, LastCatalog};

pub struct AppState {
    dirs: DataDirs,
    last_catalog: LastCatalog,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
    pub close_to_tray: AtomicBool,
    pub shortcut: Mutex<Option<Shortcut>>,
}

async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlatformInfo {
    platform: &'static str,
    home: String,
    shared_dir: String,
    app_dir: String,
    version: &'static str,
    /// The updater has a real public key, so update checks and installs can work.
    updater_enabled: bool,
}

#[tauri::command]
fn platform_info(app: tauri::AppHandle, state: State<'_, AppState>) -> PlatformInfo {
    PlatformInfo {
        platform: if cfg!(windows) {
            "win32"
        } else if cfg!(target_os = "macos") {
            "darwin"
        } else {
            "linux"
        },
        home: data::home_dir().to_string_lossy().into_owned(),
        shared_dir: state.dirs.shared.to_string_lossy().into_owned(),
        app_dir: state.dirs.app.to_string_lossy().into_owned(),
        version: env!("CARGO_PKG_VERSION"),
        updater_enabled: updater_configured(&app),
    }
}

/// True when tauri.conf.json carries a real updater public key (builds made before the signing key existed don't).
fn updater_configured(app: &tauri::AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("pubkey"))
        .and_then(|k| k.as_str())
        .is_some_and(|k| !k.trim().is_empty() && !k.starts_with("REPLACE_WITH"))
}

// ── git ────────────────────────────────────────────────────────────────────

#[tauri::command]
async fn git_status(folder: String) -> Result<git::GitStatusRaw, String> {
    blocking(move || Ok(git::status(&PathBuf::from(folder)))).await
}

#[tauri::command]
async fn git_worktree_list(folder: String) -> Result<git::GitRun, String> {
    blocking(move || Ok(git::worktree_list(&PathBuf::from(folder)))).await
}

#[tauri::command]
async fn git_short_status(folder: String) -> Result<git::GitRun, String> {
    blocking(move || Ok(git::short_status(&PathBuf::from(folder)))).await
}

#[tauri::command]
async fn git_fetch_background(folder: String) -> Result<git::GitRun, String> {
    blocking(move || Ok(git::fetch_background(&PathBuf::from(folder)))).await
}

#[tauri::command]
async fn git_remote(folder: String, op: String) -> Result<git::GitRun, String> {
    blocking(move || git::remote(&PathBuf::from(folder), &op)).await
}

// ── file system ────────────────────────────────────────────────────────────

#[tauri::command]
async fn path_kind(path: String) -> Result<&'static str, String> {
    blocking(move || Ok(fsops::path_kind(&PathBuf::from(path)))).await
}

#[tauri::command]
async fn git_dot_file(folder: String) -> Result<Option<String>, String> {
    blocking(move || Ok(fsops::git_dot_file(&PathBuf::from(folder)))).await
}

#[tauri::command]
async fn has_linked_worktrees(folder: String) -> Result<bool, String> {
    blocking(move || Ok(fsops::has_linked_worktrees(&PathBuf::from(folder)))).await
}

#[tauri::command]
async fn git_last_fetch(folder: String) -> Result<Option<f64>, String> {
    blocking(move || Ok(fsops::git_last_fetch(&PathBuf::from(folder)))).await
}

#[tauri::command]
async fn availability(path: String) -> Result<&'static str, String> {
    blocking(move || Ok(fsops::availability(&PathBuf::from(path)))).await
}

#[tauri::command]
async fn discover_repos(roots: Vec<String>, max_depth: usize, ignore_dirs: Vec<String>) -> Result<Vec<String>, String> {
    blocking(move || Ok(fsops::discover_repos(&roots, max_depth, &ignore_dirs, fsops::MAX_DIRS_PER_ROOT))).await
}

#[tauri::command]
async fn scan_languages(
    folder: String,
    extensions: std::collections::HashMap<String, String>,
    ignore_dirs: Vec<String>,
    max_files: usize,
) -> Result<std::collections::HashMap<String, u64>, String> {
    blocking(move || Ok(fsops::scan_languages(&PathBuf::from(folder), &extensions, &ignore_dirs, max_files))).await
}

#[tauri::command]
async fn find_logo(folder: String) -> Result<Option<String>, String> {
    blocking(move || Ok(fsops::find_logo(&PathBuf::from(folder)))).await
}

// ── data files ─────────────────────────────────────────────────────────────

#[tauri::command]
async fn read_data(state: State<'_, AppState>, name: String) -> Result<Option<String>, String> {
    let (dirs, last) = (state.dirs.clone(), state.last_catalog.clone());
    blocking(move || data::read_data(&dirs, &last, &name)).await
}

#[tauri::command]
async fn write_data(state: State<'_, AppState>, name: String, text: String) -> Result<(), String> {
    let (dirs, last) = (state.dirs.clone(), state.last_catalog.clone());
    blocking(move || data::write_data(&dirs, &last, &name, &text)).await
}

#[tauri::command]
async fn backup_data(state: State<'_, AppState>, name: String) -> Result<Option<String>, String> {
    let file = state.dirs.file(&name)?;
    blocking(move || Ok(data::backup(&file))).await
}

#[tauri::command]
fn data_file_path(state: State<'_, AppState>, name: String) -> Result<String, String> {
    Ok(state.dirs.file(&name)?.to_string_lossy().into_owned())
}

#[tauri::command]
async fn watch_catalog(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let file = state.dirs.file("catalog")?;
    let last = state.last_catalog.clone();
    let mut slot = state.watcher.lock().map_err(|e| e.to_string())?;
    if slot.is_some() {
        return Ok(());
    }
    let handle = app.clone();
    let watcher = data::start_watch(file, last, move |text| {
        let _ = handle.emit("catalog-changed", text);
    })?;
    *slot = Some(watcher);
    Ok(())
}

// ── launching ──────────────────────────────────────────────────────────────

#[tauri::command]
async fn list_launchers() -> Result<launch::Launchers, String> {
    blocking(|| Ok(launch::list_launchers())).await
}

#[tauri::command]
async fn open_in_editor(path: String, editor: String, custom_command: String, new_window: bool) -> Result<(), String> {
    blocking(move || launch::open_in_editor(&path, &editor, &custom_command, new_window)).await
}

#[tauri::command]
async fn open_terminal(dir: String, terminal: String, custom_command: String) -> Result<(), String> {
    blocking(move || launch::open_terminal(&dir, &terminal, &custom_command)).await
}

#[tauri::command]
async fn reveal(path: String) -> Result<(), String> {
    blocking(move || {
        let p = PathBuf::from(&path);
        if fsops::path_kind(&p) == "none" {
            return Err(format!("{path} does not exist"));
        }
        tauri_plugin_opener::reveal_item_in_dir(&p).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    let u = launch::validate_url(&url)?;
    blocking(move || app.opener().open_url(u.as_str(), None::<&str>).map_err(|e| e.to_string())).await
}

#[tauri::command]
async fn open_data_file(app: AppHandle, state: State<'_, AppState>, name: String) -> Result<(), String> {
    let file = state.dirs.file(&name)?;
    blocking(move || {
        if !file.is_file() {
            return Err(format!("{} does not exist yet", file.display()));
        }
        app.opener().open_path(file.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
fn set_global_shortcut(app: AppHandle, accelerator: String) -> Result<(), String> {
    shell::set_global_shortcut(&app, &accelerator)
}

#[tauri::command]
fn set_close_to_tray(state: State<'_, AppState>, enabled: bool) {
    state.close_to_tray.store(enabled, Ordering::Relaxed);
}

fn build_state(app: &AppHandle) -> Result<AppState, Box<dyn std::error::Error>> {
    let home = data::home_dir();
    let override_dir = std::env::var_os("REPOBOARD_DATA_DIR").map(PathBuf::from);
    let default_app = app.path().app_config_dir()?;
    let dirs = DataDirs::resolve(override_dir, data::default_shared_dir(&home), default_app);
    Ok(AppState {
        dirs,
        last_catalog: Arc::default(),
        watcher: Mutex::new(None),
        close_to_tray: AtomicBool::new(false),
        shortcut: Mutex::new(None),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(not(windows))]
    util::augment_path();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| shell::show_main(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::default().build());

    // Self-update (checked and installed from the webview); desktop only.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    builder
        .setup(|app| {
            let state = build_state(app.handle())?;
            app.manage(state);
            shell::build_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == shell::MAIN && shell::close_to_tray_enabled(window.app_handle()) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            platform_info,
            git_status,
            git_worktree_list,
            git_short_status,
            git_fetch_background,
            git_remote,
            path_kind,
            git_dot_file,
            has_linked_worktrees,
            git_last_fetch,
            availability,
            discover_repos,
            scan_languages,
            find_logo,
            read_data,
            write_data,
            backup_data,
            data_file_path,
            watch_catalog,
            list_launchers,
            open_in_editor,
            open_terminal,
            reveal,
            open_url,
            open_data_file,
            set_global_shortcut,
            set_close_to_tray,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Repo Board");
}
