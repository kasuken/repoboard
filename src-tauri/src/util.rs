//! Process helpers shared by every module: no console windows, timeouts, PATH lookup.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
pub const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

/// Hides the console window a child process would otherwise flash on Windows.
pub fn no_window(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Gives a console program its own visible console window (Windows only).
pub fn new_console(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NEW_CONSOLE);
    }
    cmd
}

#[derive(Debug, Clone)]
pub struct Captured {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
    /// Spawning failed with NotFound (program missing).
    pub not_found: bool,
}

/// Runs `cmd` to completion with a timeout, capturing stdout/stderr as lossy UTF-8.
pub fn run_capture(mut cmd: Command, timeout: Duration) -> Captured {
    no_window(&mut cmd);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return Captured {
                ok: false,
                stdout: String::new(),
                stderr: e.to_string(),
                not_found: e.kind() == std::io::ErrorKind::NotFound,
            }
        }
    };
    let mut out = child.stdout.take();
    let mut err = child.stderr.take();
    let t_out = thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(o) = out.as_mut() {
            let _ = o.read_to_end(&mut buf);
        }
        buf
    });
    let t_err = thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(o) = err.as_mut() {
            let _ = o.read_to_end(&mut buf);
        }
        buf
    });
    let start = Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    timed_out = true;
                    break None;
                }
                thread::sleep(Duration::from_millis(8));
            }
            Err(_) => break None,
        }
    };
    // After a kill a grandchild may still hold the pipes; don't block on the readers then.
    let (stdout, mut stderr) = if timed_out {
        (String::new(), String::new())
    } else {
        (
            String::from_utf8_lossy(&t_out.join().unwrap_or_default()).into_owned(),
            String::from_utf8_lossy(&t_err.join().unwrap_or_default()).into_owned(),
        )
    };
    if timed_out {
        stderr = format!("timed out after {} s", timeout.as_secs());
    }
    Captured { ok: status.is_some_and(|s| s.success()), stdout, stderr, not_found: false }
}

/// Spawns detached: no waiting, no stdio. A reaper thread avoids zombies.
pub fn spawn_detached(cmd: &mut Command) -> Result<(), String> {
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("{} was not found", cmd.get_program().to_string_lossy())
        } else {
            e.to_string()
        }
    })?;
    thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

fn is_file_like(p: &Path) -> bool {
    // symlink_metadata: Windows app-execution aliases (wt.exe) fail a followed stat.
    std::fs::symlink_metadata(p).map(|m| !m.is_dir()).unwrap_or(false)
}

/// Finds a program on PATH. On Windows tries .exe/.cmd/.bat/.com when `name` has no extension.
pub fn find_in_path(name: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    let has_ext = Path::new(name).extension().is_some();
    for dir in std::env::split_paths(&paths) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        if cfg!(windows) && !has_ext {
            for ext in ["exe", "cmd", "bat", "com"] {
                let p = dir.join(format!("{name}.{ext}"));
                if is_file_like(&p) {
                    return Some(p);
                }
            }
        } else {
            let p = dir.join(name);
            if is_file_like(&p) {
                return Some(p);
            }
        }
    }
    None
}

/// Resolves a program name: explicit paths are kept, bare names are looked up on PATH.
pub fn resolve_program(program: &str) -> PathBuf {
    let p = Path::new(program);
    if p.components().count() > 1 {
        return p.to_path_buf();
    }
    find_in_path(program).unwrap_or_else(|| p.to_path_buf())
}

/// Merges PATH lists (colon separated), keeping order and dropping duplicates.
#[cfg_attr(windows, allow(dead_code))]
pub fn merge_path(current: &str, shell_path: Option<&str>, extras: &[String]) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut push = |s: &str| {
        if !s.is_empty() && !parts.iter().any(|p| p == s) {
            parts.push(s.to_string());
        }
    };
    for p in current.split(':') {
        push(p);
    }
    if let Some(sp) = shell_path {
        for p in sp.split(':') {
            push(p);
        }
    }
    for p in extras {
        push(p);
    }
    parts.join(":")
}

/// macOS/Linux GUI apps do not inherit the login shell's PATH; rebuild it.
#[cfg(not(windows))]
pub fn augment_path() {
    let current = std::env::var("PATH").unwrap_or_default();
    let mut shell_path = None;
    if let Ok(shell) = std::env::var("SHELL") {
        let mut cmd = Command::new(shell);
        cmd.args(["-ilc", "printf %s \"$PATH\""]);
        let r = run_capture(cmd, Duration::from_millis(2500));
        if r.ok && !r.stdout.trim().is_empty() {
            // Interactive shells may print banners; the PATH is the last line.
            shell_path = r.stdout.lines().last().map(|s| s.trim().to_string());
        }
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let mut extras: Vec<String> =
        ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].iter().map(|s| s.to_string()).collect();
    if !home.is_empty() {
        extras.push(format!("{home}/.local/bin"));
    }
    extras.push("/snap/bin".to_string());
    let merged = merge_path(&current, shell_path.as_deref(), &extras);
    std::env::set_var("PATH", merged);
}

#[cfg(test)]
pub mod testutil {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static N: AtomicUsize = AtomicUsize::new(0);

    /// A unique temp directory removed on drop.
    pub struct TempDir(pub PathBuf);

    impl TempDir {
        pub fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "repoboard-test-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::SeqCst)
            ));
            std::fs::create_dir_all(&p).unwrap();
            TempDir(p)
        }
        pub fn dir(&self, rel: &str) -> PathBuf {
            let p = self.0.join(rel);
            std::fs::create_dir_all(&p).unwrap();
            p
        }
        pub fn file(&self, rel: &str, content: &[u8]) -> PathBuf {
            let p = self.0.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, content).unwrap();
            p
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_path_dedupes_and_appends() {
        let m = merge_path("/usr/bin:/bin", Some("/opt/x:/usr/bin"), &["/opt/homebrew/bin".into(), "/bin".into()]);
        assert_eq!(m, "/usr/bin:/bin:/opt/x:/opt/homebrew/bin");
    }

    #[test]
    fn missing_program_reports_not_found() {
        let r = run_capture(Command::new("definitely-not-a-real-program-xyz"), Duration::from_secs(2));
        assert!(r.not_found && !r.ok);
    }
}
