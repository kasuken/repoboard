//! Bounded, read-only file system work: discovery, language scan, logo, availability, path kind.

use base64::Engine;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

pub const MAX_DIRS_PER_ROOT: usize = 20_000;
pub const MAX_LOGO_BYTES: u64 = 96 * 1024;
const SCAN_MAX_DEPTH: usize = 10;

const LOGO_CANDIDATES: [&str; 20] = [
    "logo.svg",
    "logo.png",
    "icon.svg",
    "icon.png",
    ".github/logo.svg",
    ".github/logo.png",
    "media/icon.png",
    "media/icon.svg",
    "images/icon.png",
    "images/logo.png",
    "assets/logo.svg",
    "assets/logo.png",
    "assets/icon.png",
    "public/logo.svg",
    "public/logo.png",
    "public/favicon.svg",
    "public/apple-touch-icon.png",
    "resources/icon.png",
    "docs/logo.png",
    "docs/logo.svg",
];

/// lstat-based kind: symlinks and junctions are 'link' and never followed.
pub fn path_kind(path: &Path) -> &'static str {
    match fs::symlink_metadata(path) {
        Err(_) => "none",
        Ok(m) => {
            let t = m.file_type();
            if t.is_symlink() {
                "link"
            } else if t.is_dir() {
                "dir"
            } else {
                "file"
            }
        }
    }
}

/// Contents of `<folder>/.git` when it is a FILE (worktree / submodule), at most 4 KiB.
pub fn git_dot_file(folder: &Path) -> Option<String> {
    let p = folder.join(".git");
    let m = fs::symlink_metadata(&p).ok()?;
    if !m.is_file() {
        return None;
    }
    let mut buf = Vec::new();
    fs::File::open(&p).ok()?.take(4096).read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

pub fn has_linked_worktrees(folder: &Path) -> bool {
    fs::read_dir(folder.join(".git").join("worktrees")).map(|mut d| d.next().is_some()).unwrap_or(false)
}

fn mtime_ms(path: &Path) -> Option<f64> {
    let t = fs::metadata(path).ok()?.modified().ok()?;
    let d = t.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(d.as_secs_f64() * 1000.0)
}

/// The repo's git dir and common dir, resolved from `<folder>/.git` without running git.
fn git_dirs(folder: &Path) -> Option<(PathBuf, PathBuf)> {
    let dot = folder.join(".git");
    let m = fs::symlink_metadata(&dot).ok()?;
    if m.is_dir() {
        return Some((dot.clone(), dot));
    }
    let text = git_dot_file(folder)?;
    let line = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
    if line.is_empty() {
        return None;
    }
    let gitdir = folder.join(line);
    let common = match fs::read_to_string(gitdir.join("commondir")) {
        Ok(c) if !c.trim().is_empty() => gitdir.join(c.trim()),
        _ => gitdir.clone(),
    };
    Some((gitdir, common))
}

/// When the remote was last fetched by anyone, in ms since the epoch, read from file times only:
/// the newest of every `FETCH_HEAD` (own, common, linked worktrees) and the remote-tracking reflogs
/// (which `git clone` writes, so a fresh clone still has a time). None when nothing exists.
pub fn git_last_fetch(folder: &Path) -> Option<f64> {
    let (gitdir, common) = git_dirs(folder)?;
    let mut newest: Option<f64> = None;
    let mut see = |t: Option<f64>| {
        if let Some(t) = t {
            newest = Some(newest.map_or(t, |n| n.max(t)));
        }
    };
    see(mtime_ms(&gitdir.join("FETCH_HEAD")));
    see(mtime_ms(&common.join("FETCH_HEAD")));
    if let Ok(rd) = fs::read_dir(common.join("worktrees")) {
        for e in rd.flatten().take(500) {
            see(mtime_ms(&e.path().join("FETCH_HEAD")));
        }
    }
    let mut queue: VecDeque<(PathBuf, usize)> = VecDeque::new();
    queue.push_back((common.join("logs").join("refs").join("remotes"), 0));
    let mut seen = 0usize;
    'walk: while let Some((dir, depth)) = queue.pop_front() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            seen += 1;
            if seen > 2000 {
                break 'walk;
            }
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                if depth < 6 {
                    queue.push_back((e.path(), depth + 1));
                }
            } else if ft.is_file() {
                see(mtime_ms(&e.path()));
            }
        }
    }
    newest
}

/// 'ok' if it exists; 'missing' if its root (drive / share / mount) exists; else 'offline'.
pub fn availability(path: &Path) -> &'static str {
    if fs::metadata(path).is_ok() {
        return "ok";
    }
    let abs = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let root = abs.ancestors().last().map(Path::to_path_buf).unwrap_or(abs);
    if fs::metadata(root).is_ok() {
        "missing"
    } else {
        "offline"
    }
}

fn key_of(p: &Path) -> String {
    let s = p.to_string_lossy().into_owned();
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

fn ignore_set(ignore_dirs: &[String]) -> HashSet<String> {
    ignore_dirs.iter().map(|d| d.to_lowercase()).collect()
}

/// Breadth-first repo discovery with the extension's rules. Returns sorted absolute paths.
pub fn discover_repos(roots: &[String], max_depth: usize, ignore_dirs: &[String], max_dirs: usize) -> Vec<String> {
    let ignore = ignore_set(ignore_dirs);
    let mut found: Vec<PathBuf> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for root in roots {
        match fs::symlink_metadata(root) {
            Ok(m) if m.file_type().is_dir() => {}
            _ => continue,
        }
        let start = std::path::absolute(root).unwrap_or_else(|_| PathBuf::from(root));
        let mut queue: VecDeque<(PathBuf, usize)> = VecDeque::new();
        queue.push_back((start, 0));
        let mut visited = 0usize;
        while visited < max_dirs {
            let Some((dir, depth)) = queue.pop_front() else { break };
            visited += 1;
            let Ok(rd) = fs::read_dir(&dir) else { continue };
            let mut subdirs: Vec<(String, PathBuf)> = Vec::new();
            let mut is_repo = false;
            for entry in rd.flatten() {
                let Ok(ft) = entry.file_type() else { continue };
                let name = entry.file_name().to_string_lossy().into_owned();
                if name == ".git" && (ft.is_dir() || ft.is_file()) {
                    is_repo = true;
                    break;
                }
                // file_type() does not follow links, so symlinks and junctions are never dirs here.
                if ft.is_dir() {
                    subdirs.push((name, entry.path()));
                }
            }
            if is_repo {
                if seen.insert(key_of(&dir)) {
                    found.push(dir);
                }
                continue;
            }
            if depth >= max_depth {
                continue;
            }
            for (name, path) in subdirs {
                if name.starts_with('.') || ignore.contains(&name.to_lowercase()) {
                    continue;
                }
                queue.push_back((path, depth + 1));
            }
        }
    }
    let mut out: Vec<String> = found.into_iter().map(|p| p.to_string_lossy().into_owned()).collect();
    out.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| a.cmp(b)));
    out
}

/// The extension's `languageForFile`, with the extension table passed in.
pub fn language_for_file<'a>(file_name: &str, table: &'a HashMap<String, String>) -> Option<&'a str> {
    let lower = file_name.to_lowercase();
    let get = |k: &str| table.get(k).map(String::as_str);
    if lower == "dockerfile" || lower.starts_with("dockerfile.") || lower.ends_with(".dockerfile") {
        return get("dockerfile");
    }
    if lower == "makefile" || lower == "gnumakefile" {
        return get("makefile");
    }
    if lower == "cmakelists.txt" {
        return get("cmake");
    }
    if lower.ends_with(".blade.php") {
        return get("blade.php");
    }
    for excluded in [".min.js", ".min.css", ".d.ts", ".g.cs", ".designer.cs"] {
        if lower.ends_with(excluded) {
            return None;
        }
    }
    match lower.rfind('.') {
        Some(dot) if dot > 0 => get(&lower[dot + 1..]),
        _ => None,
    }
}

/// Bytes per language over a bounded breadth-first walk (each counted file is at least 1 byte).
pub fn scan_languages(
    folder: &Path,
    extensions: &HashMap<String, String>,
    ignore_dirs: &[String],
    max_files: usize,
) -> HashMap<String, u64> {
    let ignore = ignore_set(ignore_dirs);
    let mut bytes: HashMap<String, u64> = HashMap::new();
    let mut queue: VecDeque<(PathBuf, usize)> = VecDeque::new();
    queue.push_back((folder.to_path_buf(), 0));
    let mut counted = 0usize;
    while counted < max_files {
        let Some((dir, depth)) = queue.pop_front() else { break };
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        let mut files: Vec<(PathBuf, String)> = Vec::new();
        for entry in rd.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            let name = entry.file_name().to_string_lossy().into_owned();
            if ft.is_dir() {
                if depth < SCAN_MAX_DEPTH && !name.starts_with('.') && !ignore.contains(&name.to_lowercase()) {
                    queue.push_back((entry.path(), depth + 1));
                }
            } else if ft.is_file() {
                if let Some(lang) = language_for_file(&name, extensions) {
                    if counted + files.len() < max_files {
                        files.push((entry.path(), lang.to_string()));
                    }
                }
            }
        }
        counted += files.len();
        for (path, lang) in files {
            let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0).max(1);
            *bytes.entry(lang).or_insert(0) += size;
        }
    }
    bytes
}

/// First logo candidate that is a file of 1..=96 KiB, as a data: URI.
pub fn find_logo(folder: &Path) -> Option<String> {
    for candidate in LOGO_CANDIDATES.iter() {
        let file = folder.join(candidate);
        let Ok(meta) = fs::metadata(&file) else { continue };
        if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_LOGO_BYTES {
            continue;
        }
        let Ok(data) = fs::read(&file) else { continue };
        let mime = if candidate.ends_with(".svg") { "image/svg+xml" } else { "image/png" };
        return Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(data)));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::testutil::TempDir;

    fn rel(root: &Path, found: &[String]) -> Vec<String> {
        let mut v: Vec<String> = found
            .iter()
            .map(|p| Path::new(p).strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/"))
            .collect();
        v.sort();
        v
    }

    fn table() -> HashMap<String, String> {
        [
            ("ts", "TypeScript"),
            ("css", "CSS"),
            ("js", "JavaScript"),
            ("dockerfile", "Dockerfile"),
            ("makefile", "Makefile"),
            ("cmake", "CMake"),
            ("blade.php", "Blade"),
            ("php", "PHP"),
            ("cs", "C#"),
            ("rs", "Rust"),
        ]
        .iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect()
    }

    #[test]
    fn discovers_repos_with_extension_rules() {
        let t = TempDir::new();
        t.dir("code/alpha/.git");
        t.dir("code/alpha/packages/nested/.git");
        t.dir("code/group/beta/.git");
        t.file("code/worktree/.git", b"gitdir: ../alpha/.git/worktrees/w");
        t.dir("code/node_modules/dep/.git");
        t.dir("code/NODE_MODULES/other/.git");
        t.dir("code/.hidden/secret/.git");
        t.dir("code/a/b/c/too-deep/.git");
        let linked = {
            let target = t.0.join("code/group");
            let link = t.0.join("code/link-to-group");
            #[cfg(windows)]
            let r = std::os::windows::fs::symlink_dir(&target, &link);
            #[cfg(unix)]
            let r = std::os::unix::fs::symlink(&target, &link);
            r.is_ok()
        };
        let root = t.0.join("code").to_string_lossy().into_owned();
        let ignore = vec!["Node_Modules".to_string()];
        let found = discover_repos(&[root.clone(), root.clone()], 3, &ignore, MAX_DIRS_PER_ROOT);
        assert_eq!(rel(&t.0, &found), ["code/alpha", "code/group/beta", "code/worktree"]);
        if linked {
            assert!(!found.iter().any(|f| f.contains("link-to-group")));
        }
        let deeper = discover_repos(std::slice::from_ref(&root), 5, &[], MAX_DIRS_PER_ROOT);
        assert!(deeper.iter().any(|p| p.ends_with("too-deep")));
        assert!(deeper.iter().any(|p| p.contains("node_modules")));
        assert!(!deeper.iter().any(|p| p.contains(".hidden")));
        // depth limit: too-deep is at depth 4
        assert!(!discover_repos(&[root], 3, &[], MAX_DIRS_PER_ROOT).iter().any(|p| p.ends_with("too-deep")));
        let none = t.0.join("does-not-exist").to_string_lossy().into_owned();
        assert!(discover_repos(&[none], 3, &[], MAX_DIRS_PER_ROOT).is_empty());
    }

    #[test]
    fn scan_root_itself_can_be_a_repo() {
        let t = TempDir::new();
        let solo = t.dir("solo");
        t.dir("solo/.git");
        let found = discover_repos(&[solo.to_string_lossy().into_owned()], 2, &[], MAX_DIRS_PER_ROOT);
        assert_eq!(found.len(), 1);
        assert!(found[0].ends_with("solo"));
    }

    #[test]
    fn dir_cap_limits_the_walk() {
        let t = TempDir::new();
        t.dir("r/a/.git");
        t.dir("r/b/.git");
        let root = t.0.join("r").to_string_lossy().into_owned();
        // Only the root itself gets visited with a cap of 1.
        assert!(discover_repos(&[root], 3, &[], 1).is_empty());
    }

    #[test]
    fn language_special_names() {
        let tb = table();
        assert_eq!(language_for_file("Dockerfile", &tb), Some("Dockerfile"));
        assert_eq!(language_for_file("dockerfile.dev", &tb), Some("Dockerfile"));
        assert_eq!(language_for_file("api.DockerFile", &tb), Some("Dockerfile"));
        assert_eq!(language_for_file("GNUmakefile", &tb), Some("Makefile"));
        assert_eq!(language_for_file("CMakeLists.txt", &tb), Some("CMake"));
        assert_eq!(language_for_file("home.blade.php", &tb), Some("Blade"));
        assert_eq!(language_for_file("index.php", &tb), Some("PHP"));
        for f in ["app.min.js", "x.min.css", "types.d.ts", "a.g.cs", "form.designer.cs"] {
            assert_eq!(language_for_file(f, &tb), None, "{f}");
        }
        assert_eq!(language_for_file("main.RS", &tb), Some("Rust"));
        assert_eq!(language_for_file(".ts", &tb), None);
        assert_eq!(language_for_file("noext", &tb), None);
    }

    #[test]
    fn language_scan_weighs_bytes_and_honours_ignores_and_cap() {
        let t = TempDir::new();
        t.file("langs/a.ts", &[b'x'; 3000]);
        t.file("langs/b.css", &[b'x'; 1000]);
        t.file("langs/data.json", &[b'x'; 50000]);
        t.file("langs/empty.ts", b"");
        t.file("langs/node_modules/huge.js", &[b'x'; 90000]);
        t.file("langs/.hidden/h.js", &[b'x'; 90000]);
        let p = t.0.join("langs");
        let r = scan_languages(&p, &table(), &["node_modules".to_string()], 100);
        assert_eq!(r.get("TypeScript"), Some(&3001));
        assert_eq!(r.get("CSS"), Some(&1000));
        assert_eq!(r.len(), 2);

        let capped = scan_languages(&p, &table(), &["node_modules".to_string()], 2);
        let files: usize = capped.len();
        assert!(files <= 2);
        let total_cap = scan_languages(&p, &table(), &[], 1);
        assert_eq!(total_cap.len(), 1);
    }

    #[test]
    fn logo_lookup_caps_size() {
        let t = TempDir::new();
        let p = t.dir("logo");
        assert_eq!(find_logo(&p), None);
        t.file("logo/logo.svg", &vec![b'x'; 200 * 1024]);
        assert_eq!(find_logo(&p), None);
        t.file("logo/icon.png", &[0x89, 0x50, 0x4e, 0x47]);
        assert!(find_logo(&p).unwrap().starts_with("data:image/png;base64,"));
        // Exactly at the cap is accepted, and an earlier candidate wins.
        t.file("logo/logo.png", &vec![b'x'; MAX_LOGO_BYTES as usize]);
        assert!(find_logo(&p).unwrap().starts_with("data:image/png;base64,eHh4"));
        t.file("logo/logo.svg", b"<svg/>");
        assert!(find_logo(&p).unwrap().starts_with("data:image/svg+xml;base64,"));
    }

    #[test]
    fn path_kinds_and_dot_file() {
        let t = TempDir::new();
        t.dir("d");
        t.file("f.txt", b"x");
        assert_eq!(path_kind(&t.0.join("d")), "dir");
        assert_eq!(path_kind(&t.0.join("f.txt")), "file");
        assert_eq!(path_kind(&t.0.join("nope")), "none");
        t.file("wt/.git", b"gitdir: /x/.git/worktrees/wt\n");
        assert_eq!(git_dot_file(&t.0.join("wt")).unwrap(), "gitdir: /x/.git/worktrees/wt\n");
        t.dir("repo/.git");
        assert_eq!(git_dot_file(&t.0.join("repo")), None);
        assert!(!has_linked_worktrees(&t.0.join("repo")));
        t.dir("repo/.git/worktrees/w1");
        assert!(has_linked_worktrees(&t.0.join("repo")));
        assert_eq!(availability(&t.0.join("d")), "ok");
        assert_eq!(availability(&t.0.join("gone")), "missing");
    }

    fn set_mtime(p: &Path, secs_ago: u64) {
        let f = fs::OpenOptions::new().write(true).open(p).unwrap();
        f.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(secs_ago)).unwrap();
    }

    fn age_secs(ms: f64) -> i64 {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs_f64() * 1000.0;
        ((now - ms) / 1000.0).round() as i64
    }

    #[test]
    fn last_fetch_from_fetch_head_in_a_normal_repo() {
        let t = TempDir::new();
        t.dir("repo/.git");
        assert_eq!(git_last_fetch(&t.0.join("repo")), None);
        let f = t.file("repo/.git/FETCH_HEAD", b"x");
        set_mtime(&f, 3600);
        let age = age_secs(git_last_fetch(&t.0.join("repo")).unwrap());
        assert!((3595..=3660).contains(&age), "age {age}");
        assert_eq!(git_last_fetch(&t.0.join("missing")), None);
    }

    #[test]
    fn last_fetch_in_a_linked_worktree_uses_common_dir_and_sibling_worktrees() {
        let t = TempDir::new();
        t.dir("main/.git/worktrees/wt");
        t.dir("main/.git/worktrees/other");
        t.file("main/.git/worktrees/wt/commondir", b"../..\n");
        t.file("wt/.git", b"gitdir: ../main/.git/worktrees/wt\n");
        assert_eq!(git_last_fetch(&t.0.join("wt")), None);
        set_mtime(&t.file("main/.git/FETCH_HEAD", b"x"), 7200);
        set_mtime(&t.file("main/.git/worktrees/other/FETCH_HEAD", b"x"), 600);
        set_mtime(&t.file("main/.git/worktrees/wt/FETCH_HEAD", b"x"), 86_400);
        let age = age_secs(git_last_fetch(&t.0.join("wt")).unwrap());
        assert!((595..=660).contains(&age), "age {age}");
        // The main repo sees its linked worktrees' fetches too.
        let age = age_secs(git_last_fetch(&t.0.join("main")).unwrap());
        assert!((595..=660).contains(&age), "age {age}");
    }

    #[test]
    fn last_fetch_falls_back_to_remote_reflogs() {
        let t = TempDir::new();
        t.dir("repo/.git");
        set_mtime(&t.file("repo/.git/logs/refs/remotes/origin/HEAD", b"x"), 1000);
        set_mtime(&t.file("repo/.git/logs/refs/remotes/origin/feature/deep/topic", b"x"), 500);
        set_mtime(&t.file("repo/.git/logs/HEAD", b"x"), 10);
        let age = age_secs(git_last_fetch(&t.0.join("repo")).unwrap());
        assert!((495..=560).contains(&age), "age {age}");
    }
}
