//! Desktop shell integration: window focus, tray icon, global shortcut.

use std::sync::atomic::Ordering;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::AppState;

pub const MAIN: &str = "main";

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Repo Board", true, None::<&str>)?;
    let switcher = MenuItem::with_id(app, "switcher", "Switch project…", true, None::<&str>)?;
    let fetch_all = MenuItem::with_id(app, "fetchAll", "Fetch all repos", true, None::<&str>)?;
    let pull_all = MenuItem::with_id(app, "pullAll", "Pull all repos that are behind", true, None::<&str>)?;
    let scan = MenuItem::with_id(app, "scan", "Scan folders for repos", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Repo Board", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &switcher,
            &PredefinedMenuItem::separator(app)?,
            &fetch_all,
            &pull_all,
            &scan,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Repo Board")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "quit" => app.exit(0),
            id @ ("switcher" | "fetchAll" | "pullAll" | "scan" | "settings") => {
                show_main(app);
                let _ = app.emit("tray-action", id);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// Replaces the registered global shortcut; "" unregisters.
pub fn set_global_shortcut(app: &AppHandle, accelerator: &str) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut current = state.shortcut.lock().map_err(|e| e.to_string())?;
    let gs = app.global_shortcut();
    if let Some(prev) = current.take() {
        let _ = gs.unregister(prev);
    }
    let accel = accelerator.trim();
    if accel.is_empty() {
        return Ok(());
    }
    let shortcut: Shortcut = accel.parse().map_err(|e| format!("invalid shortcut \"{accel}\": {e}"))?;
    gs.on_shortcut(shortcut, |app, _s, event| {
        if event.state() == ShortcutState::Pressed {
            show_main(app);
            let _ = app.emit("global-switcher", ());
        }
    })
    .map_err(|e| format!("could not register \"{accel}\": {e}"))?;
    *current = Some(shortcut);
    Ok(())
}

pub fn close_to_tray_enabled(app: &AppHandle) -> bool {
    app.try_state::<AppState>().is_some_and(|s| s.close_to_tray.load(Ordering::Relaxed))
}
