//! Git invocations. Every argument list is fixed here; the webview never supplies git arguments.

use crate::util::{run_capture, Captured};
use serde::Serialize;
use std::path::Path;
use std::process::Command;
use std::thread;
use std::time::Duration;

const READ_FLAGS: [&str; 9] = [
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.quotepath=off",
    "-c",
    "color.ui=false",
];

/// Never prompt: no terminal prompt, no credential manager dialog, no askpass GUI.
pub const NON_INTERACTIVE_ENV: [(&str, &str); 6] = [
    ("GIT_TERMINAL_PROMPT", "0"),
    ("GCM_INTERACTIVE", "never"),
    ("GIT_ASKPASS", ""),
    ("SSH_ASKPASS", ""),
    ("GIT_OPTIONAL_LOCKS", "0"),
    ("LC_ALL", "C"),
];

pub const READ_TIMEOUT: Duration = Duration::from_secs(8);
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(30);
pub const REMOTE_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRun {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
    pub missing_git: bool,
}

impl From<Captured> for GitRun {
    fn from(c: Captured) -> Self {
        GitRun { ok: c.ok, stdout: c.stdout, stderr: c.stderr, missing_git: c.not_found }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusRaw {
    pub status: GitRun,
    pub log: GitRun,
    pub stash: GitRun,
    pub remotes: GitRun,
}

/// Runs `git <args>` in `cwd`. A missing cwd is reported as a failure, not as "git not found".
fn run_git(cwd: &Path, args: &[&str], timeout: Duration) -> GitRun {
    if !cwd.is_dir() {
        return GitRun {
            ok: false,
            stdout: String::new(),
            stderr: format!("{} is not a directory", cwd.display()),
            missing_git: false,
        };
    }
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(cwd);
    for (k, v) in NON_INTERACTIVE_ENV {
        cmd.env(k, v);
    }
    run_capture(cmd, timeout).into()
}

fn read(cwd: &Path, args: &[&str]) -> GitRun {
    let mut all: Vec<&str> = READ_FLAGS.to_vec();
    all.extend_from_slice(args);
    run_git(cwd, &all, READ_TIMEOUT)
}

pub fn status(folder: &Path) -> GitStatusRaw {
    thread::scope(|s| {
        let st = s.spawn(|| read(folder, &["status", "--porcelain=v2", "--branch"]));
        let log = s.spawn(|| read(folder, &["log", "-1", "--format=%h%x1f%s%x1f%an%x1f%ct"]));
        let stash = s.spawn(|| read(folder, &["rev-list", "--walk-reflogs", "--count", "refs/stash"]));
        let remotes = s.spawn(|| read(folder, &["remote", "-v"]));
        let join = |h: thread::ScopedJoinHandle<'_, GitRun>| {
            h.join().unwrap_or(GitRun { ok: false, stdout: String::new(), stderr: "internal error".into(), missing_git: false })
        };
        GitStatusRaw { status: join(st), log: join(log), stash: join(stash), remotes: join(remotes) }
    })
}

pub fn worktree_list(folder: &Path) -> GitRun {
    read(folder, &["worktree", "list", "--porcelain"])
}

pub fn short_status(folder: &Path) -> GitRun {
    read(folder, &["status", "--porcelain=v2"])
}

pub fn fetch_background(folder: &Path) -> bool {
    let mut all: Vec<&str> = READ_FLAGS.to_vec();
    all.extend_from_slice(&["fetch", "--quiet", "--no-tags", "--no-write-fetch-head"]);
    run_git(folder, &all, FETCH_TIMEOUT).ok
}

/// The fixed argument list for a user-requested remote operation; anything else is rejected.
pub fn remote_args(op: &str) -> Result<Vec<&'static str>, String> {
    let tail: &[&'static str] = match op {
        "fetch" => &["fetch", "--quiet"],
        "pull" => &["pull", "--ff-only", "--quiet"],
        "push" => &["push", "--quiet"],
        other => return Err(format!("unsupported git operation: {other}")),
    };
    let mut v = vec!["-c", "core.fsmonitor=false", "-c", "core.quotepath=off"];
    v.extend_from_slice(tail);
    Ok(v)
}

pub fn remote(folder: &Path, op: &str) -> Result<GitRun, String> {
    let args = remote_args(op)?;
    if std::fs::symlink_metadata(folder.join(".git")).is_err() {
        return Ok(GitRun {
            ok: false,
            stdout: String::new(),
            stderr: format!("{} is not available or is not a git repository.", folder.display()),
            missing_git: false,
        });
    }
    Ok(run_git(folder, &args, REMOTE_TIMEOUT))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::testutil::TempDir;

    fn git_available() -> bool {
        crate::util::find_in_path("git").is_some()
    }

    #[test]
    fn remote_rejects_unknown_ops() {
        for op in ["", "clone", "fetch --all", "-c core.sshCommand=x", "PUSH"] {
            assert!(remote_args(op).is_err(), "{op}");
        }
        assert_eq!(remote_args("pull").unwrap().last(), Some(&"--quiet"));
        let t = TempDir::new();
        assert!(remote(&t.0, "rebase").is_err());
        // Not a repo: reported as a failed run, not as missing git.
        let r = remote(&t.0, "fetch").unwrap();
        assert!(!r.ok && !r.missing_git);
    }

    #[test]
    fn read_flags_are_exact() {
        assert_eq!(READ_FLAGS.join(" "), "--no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.quotepath=off -c color.ui=false");
    }

    #[test]
    fn status_on_a_temp_repo() {
        if !git_available() {
            eprintln!("git missing, skipping");
            return;
        }
        let t = TempDir::new();
        let ok = |args: &[&str]| {
            let mut c = Command::new("git");
            c.args(args).current_dir(&t.0);
            run_capture(c, Duration::from_secs(20)).ok
        };
        assert!(ok(&["init", "-q"]));
        t.file("a.txt", b"hello");
        assert!(ok(&["add", "a.txt"]));
        assert!(ok(&["-c", "user.name=T", "-c", "user.email=t@t.t", "commit", "-q", "-m", "first"]));
        t.file("b.txt", b"untracked");
        let r = status(&t.0);
        assert!(r.status.ok, "{}", r.status.stderr);
        assert!(r.status.stdout.contains("# branch.head"));
        assert!(r.status.stdout.contains("? b.txt"));
        assert!(r.log.stdout.contains('\u{1f}') && r.log.stdout.contains("first"));
        assert!(!r.status.missing_git);
        // No stash: rev-list fails, which the TypeScript side treats as zero.
        assert!(r.remotes.ok);
        assert!(worktree_list(&t.0).ok);
        assert!(short_status(&t.0).ok);
        // A missing folder is a failure but never "missing git".
        let gone = status(&t.0.join("nope"));
        assert!(!gone.status.ok && !gone.status.missing_git);
    }
}
