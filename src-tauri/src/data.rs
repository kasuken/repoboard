//! Data files (catalog / settings / meta-cache) as TEXT, plus the catalog directory watcher.
//! TypeScript owns the schema; Rust only moves text atomically.

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone)]
pub struct DataDirs {
    /// Holds catalog.json (shared with the VS Code extension).
    pub shared: PathBuf,
    /// Holds settings.json and meta-cache.json.
    pub app: PathBuf,
}

impl DataDirs {
    /// `override_dir` (REPOBOARD_DATA_DIR) replaces both folders.
    pub fn resolve(override_dir: Option<PathBuf>, default_shared: PathBuf, default_app: PathBuf) -> DataDirs {
        match override_dir {
            Some(d) if !d.as_os_str().is_empty() => DataDirs { shared: d.clone(), app: d },
            _ => DataDirs { shared: default_shared, app: default_app },
        }
    }

    pub fn file(&self, name: &str) -> Result<PathBuf, String> {
        match name {
            "catalog" => Ok(self.shared.join("catalog.json")),
            "settings" => Ok(self.app.join("settings.json")),
            "meta-cache" => Ok(self.app.join("meta-cache.json")),
            other => Err(format!("unknown data file: {other}")),
        }
    }
}

/// The extension's `sharedDataDir()`.
pub fn default_shared_dir(home: &Path) -> PathBuf {
    if cfg!(windows) {
        return std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| home.join("AppData").join("Roaming"))
            .join("repoboard");
    }
    if cfg!(target_os = "macos") {
        return home.join("Library").join("Application Support").join("repoboard");
    }
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| home.join(".config"))
        .join("repoboard")
}

pub fn home_dir() -> PathBuf {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var).map(PathBuf::from).unwrap_or_default()
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

pub fn read_text(file: &Path) -> Result<Option<String>, String> {
    match std::fs::read(file) {
        Ok(b) => Ok(Some(String::from_utf8_lossy(&b).into_owned())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn is_busy(e: &std::io::Error) -> bool {
    matches!(e.kind(), std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::ResourceBusy)
        || (cfg!(windows) && matches!(e.raw_os_error(), Some(5 | 32 | 33)))
}

/// Writes `<file>.<pid>.<ms>.tmp`, renames over `file`, retrying briefly when something holds it.
/// `before_rename` runs once the temp file is on disk (used to record the text we are about to publish).
pub fn write_atomic(file: &Path, text: &str, before_rename: impl FnOnce()) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut tmp_name = file.as_os_str().to_owned();
    tmp_name.push(format!(".{}.{}.tmp", std::process::id(), now_ms()));
    let tmp = PathBuf::from(tmp_name);
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    before_rename();
    let mut attempt = 0u64;
    loop {
        match std::fs::rename(&tmp, file) {
            Ok(()) => return Ok(()),
            Err(e) if is_busy(&e) && attempt < 6 => {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(40 * attempt));
            }
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                return Err(e.to_string());
            }
        }
    }
}

/// Copies `file` to `<file>.broken-<ms>`; returns the backup path.
pub fn backup(file: &Path) -> Option<String> {
    let mut name = file.as_os_str().to_owned();
    name.push(format!(".broken-{}", now_ms()));
    let dest = PathBuf::from(name);
    std::fs::copy(file, &dest).ok()?;
    Some(dest.to_string_lossy().into_owned())
}

/// Shared "last catalog text we read or wrote" so the watcher can ignore our own writes.
pub type LastCatalog = Arc<Mutex<Option<String>>>;

pub fn read_data(dirs: &DataDirs, last: &LastCatalog, name: &str) -> Result<Option<String>, String> {
    let text = read_text(&dirs.file(name)?)?;
    if name == "catalog" {
        if let (Some(t), Ok(mut l)) = (&text, last.lock()) {
            *l = Some(t.clone());
        }
    }
    Ok(text)
}

pub fn write_data(dirs: &DataDirs, last: &LastCatalog, name: &str, text: &str) -> Result<(), String> {
    let file = dirs.file(name)?;
    write_atomic(&file, text, || {
        if name == "catalog" {
            if let Ok(mut l) = last.lock() {
                *l = Some(text.to_string());
            }
        }
    })
}

/// Watches the catalog's folder (an atomic rename replaces the file's inode, which breaks file watches).
/// `emit` receives the new text, debounced 150 ms, only when it differs from `last`.
pub fn start_watch(
    file: PathBuf,
    last: LastCatalog,
    emit: impl Fn(String) + Send + 'static,
) -> Result<RecommendedWatcher, String> {
    let dir = file.parent().ok_or("catalog has no folder")?.to_path_buf();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let (tx, rx) = mpsc::channel::<()>();
    let base = file.file_name().map(|n| n.to_os_string());
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if ev.paths.is_empty() || ev.paths.iter().any(|p| p.file_name().map(|n| n.to_os_string()) == base) {
                let _ = tx.send(());
            }
        }
    })
    .map_err(|e| e.to_string())?;
    watcher.watch(&dir, RecursiveMode::NonRecursive).map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        // Ends when the watcher (and with it the sender) is dropped.
        while rx.recv().is_ok() {
            while rx.recv_timeout(Duration::from_millis(150)).is_ok() {}
            let Ok(Some(text)) = read_text(&file) else { continue };
            let changed = match last.lock() {
                Ok(mut l) => {
                    if l.as_deref() == Some(text.as_str()) {
                        false
                    } else {
                        *l = Some(text.clone());
                        true
                    }
                }
                Err(_) => false,
            };
            if changed {
                emit(text);
            }
        }
    });
    Ok(watcher)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::testutil::TempDir;

    fn dirs(t: &TempDir) -> DataDirs {
        DataDirs { shared: t.0.join("shared"), app: t.0.join("app") }
    }

    #[test]
    fn names_map_to_files_and_override_wins() {
        let d = DataDirs::resolve(None, "S".into(), "A".into());
        assert_eq!(d.file("catalog").unwrap(), Path::new("S").join("catalog.json"));
        assert_eq!(d.file("settings").unwrap(), Path::new("A").join("settings.json"));
        assert_eq!(d.file("meta-cache").unwrap(), Path::new("A").join("meta-cache.json"));
        assert!(d.file("../etc").is_err());
        let o = DataDirs::resolve(Some("X".into()), "S".into(), "A".into());
        assert_eq!(o.shared, o.app);
        assert_eq!(o.file("catalog").unwrap(), Path::new("X").join("catalog.json"));
    }

    #[test]
    fn atomic_write_round_trip_and_backup() {
        let t = TempDir::new();
        let d = dirs(&t);
        let last: LastCatalog = Arc::default();
        assert_eq!(read_data(&d, &last, "catalog").unwrap(), None);
        write_data(&d, &last, "catalog", "{\"a\":1}\n").unwrap();
        assert_eq!(read_data(&d, &last, "catalog").unwrap().as_deref(), Some("{\"a\":1}\n"));
        assert_eq!(last.lock().unwrap().as_deref(), Some("{\"a\":1}\n"));
        write_data(&d, &last, "settings", "{}").unwrap();
        // No temp files left behind.
        let leftovers = std::fs::read_dir(&d.shared).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".tmp")).count();
        assert_eq!(leftovers, 0);
        let b = backup(&d.file("catalog").unwrap()).unwrap();
        assert!(b.contains("catalog.json.broken-"));
        assert_eq!(std::fs::read_to_string(b).unwrap(), "{\"a\":1}\n");
        assert_eq!(backup(&d.file("meta-cache").unwrap()), None);
    }

    #[test]
    fn watcher_ignores_own_writes_and_reports_foreign_ones() {
        let t = TempDir::new();
        let d = dirs(&t);
        let last: LastCatalog = Arc::default();
        let (tx, rx) = mpsc::channel::<String>();
        let _w = start_watch(d.file("catalog").unwrap(), last.clone(), move |s| {
            let _ = tx.send(s);
        })
        .unwrap();
        write_data(&d, &last, "catalog", "own").unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(800)).is_err(), "own write must not be reported");
        // A foreign writer (bypasses our tracking).
        std::fs::write(d.file("catalog").unwrap(), "foreign").unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), "foreign");
    }
}
