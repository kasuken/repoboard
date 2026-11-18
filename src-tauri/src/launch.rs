//! Editors, terminals, URLs. Nothing here goes through a shell.

use crate::util::{find_in_path, new_console, no_window, resolve_program, spawn_detached};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherInfo {
    pub id: String,
    pub name: String,
    pub available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Launchers {
    pub editors: Vec<LauncherInfo>,
    pub terminals: Vec<LauncherInfo>,
}

struct Editor {
    id: &'static str,
    name: &'static str,
    /// Program names looked up on PATH (`code` also finds `code.cmd` on Windows).
    bins: &'static [&'static str],
    /// Windows install locations (with %VAR%); the real .exe takes the same flags as the shim.
    win: &'static [&'static str],
    mac: &'static [&'static str],
    new_flag: Option<&'static str>,
    reuse_flag: Option<&'static str>,
}

const EDITORS: &[Editor] = &[
    Editor {
        id: "code",
        name: "Visual Studio Code",
        bins: &["code"],
        win: &["%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe", "%ProgramFiles%\\Microsoft VS Code\\Code.exe"],
        mac: &["/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"],
        new_flag: Some("-n"),
        reuse_flag: Some("-r"),
    },
    Editor {
        id: "code-insiders",
        name: "VS Code Insiders",
        bins: &["code-insiders"],
        win: &[
            "%LOCALAPPDATA%\\Programs\\Microsoft VS Code Insiders\\Code - Insiders.exe",
            "%ProgramFiles%\\Microsoft VS Code Insiders\\Code - Insiders.exe",
        ],
        mac: &["/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders"],
        new_flag: Some("-n"),
        reuse_flag: Some("-r"),
    },
    Editor {
        id: "cursor",
        name: "Cursor",
        bins: &["cursor"],
        win: &["%LOCALAPPDATA%\\Programs\\cursor\\Cursor.exe", "%LOCALAPPDATA%\\Programs\\Cursor\\Cursor.exe"],
        mac: &["/Applications/Cursor.app/Contents/Resources/app/bin/cursor"],
        new_flag: Some("-n"),
        reuse_flag: Some("-r"),
    },
    Editor {
        id: "windsurf",
        name: "Windsurf",
        bins: &["windsurf"],
        win: &["%LOCALAPPDATA%\\Programs\\Windsurf\\Windsurf.exe"],
        mac: &["/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf"],
        new_flag: Some("-n"),
        reuse_flag: Some("-r"),
    },
    Editor {
        id: "codium",
        name: "VSCodium",
        bins: &["codium"],
        win: &["%LOCALAPPDATA%\\Programs\\VSCodium\\VSCodium.exe", "%ProgramFiles%\\VSCodium\\VSCodium.exe"],
        mac: &["/Applications/VSCodium.app/Contents/Resources/app/bin/codium"],
        new_flag: Some("-n"),
        reuse_flag: Some("-r"),
    },
    Editor {
        id: "zed",
        name: "Zed",
        bins: &["zed"],
        win: &[],
        mac: &["/Applications/Zed.app/Contents/MacOS/cli"],
        new_flag: Some("-n"),
        reuse_flag: Some("-r"),
    },
    Editor {
        id: "sublime",
        name: "Sublime Text",
        bins: &["subl"],
        win: &["%ProgramFiles%\\Sublime Text\\subl.exe", "%ProgramFiles%\\Sublime Text 3\\subl.exe"],
        mac: &["/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl"],
        new_flag: Some("-n"),
        reuse_flag: None,
    },
    Editor {
        id: "idea",
        name: "IntelliJ IDEA",
        bins: &["idea"],
        win: &[],
        mac: &["/Applications/IntelliJ IDEA.app/Contents/MacOS/idea", "/Applications/IntelliJ IDEA CE.app/Contents/MacOS/idea"],
        new_flag: None,
        reuse_flag: None,
    },
];

fn expand_env(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find('%') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        match after.find('%') {
            Some(j) => {
                out.push_str(&std::env::var(&after[..j]).unwrap_or_default());
                rest = &after[j + 1..];
            }
            None => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn resolve_editor(e: &Editor) -> Option<PathBuf> {
    if cfg!(windows) {
        // The real .exe first: no .cmd shim, same flags.
        for w in e.win {
            let p = PathBuf::from(expand_env(w));
            if !p.as_os_str().is_empty() && p.is_file() {
                return Some(p);
            }
        }
    }
    for b in e.bins {
        if let Some(p) = find_in_path(b) {
            return Some(p);
        }
    }
    if cfg!(target_os = "macos") {
        for m in e.mac {
            let p = PathBuf::from(m);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

fn which_any(names: &[&str]) -> Option<PathBuf> {
    names.iter().find_map(|n| find_in_path(n))
}

pub fn os_terminals() -> &'static [(&'static str, &'static str)] {
    if cfg!(windows) {
        &[("windows-terminal", "Windows Terminal"), ("powershell", "PowerShell"), ("cmd", "Command Prompt")]
    } else if cfg!(target_os = "macos") {
        &[("terminal", "Terminal"), ("iterm", "iTerm2")]
    } else {
        &[
            ("x-terminal-emulator", "Default terminal"),
            ("gnome-terminal", "GNOME Terminal"),
            ("konsole", "Konsole"),
            ("xterm", "xterm"),
        ]
    }
}

fn terminal_available(id: &str) -> bool {
    match id {
        "windows-terminal" => find_in_path("wt").is_some(),
        "powershell" => which_any(&["pwsh", "powershell"]).is_some(),
        "cmd" => true,
        "terminal" => true,
        "iterm" => Path::new("/Applications/iTerm.app").exists() || Path::new("/Applications/iTerm2.app").exists(),
        "gnome-terminal" | "konsole" | "xterm" | "x-terminal-emulator" => find_in_path(id).is_some(),
        _ => false,
    }
}

pub fn list_launchers() -> Launchers {
    let mut editors: Vec<LauncherInfo> = EDITORS
        .iter()
        .map(|e| LauncherInfo { id: e.id.into(), name: e.name.into(), available: resolve_editor(e).is_some() })
        .collect();
    editors.push(LauncherInfo { id: "custom".into(), name: "Custom command".into(), available: true });
    let mut terminals: Vec<LauncherInfo> = os_terminals()
        .iter()
        .map(|(id, name)| LauncherInfo { id: (*id).into(), name: (*name).into(), available: terminal_available(id) })
        .collect();
    terminals.push(LauncherInfo { id: "custom".into(), name: "Custom command".into(), available: true });
    Launchers { editors, terminals }
}

/// Splits a custom command shell-style; `{path}` (anywhere in a token) becomes the path, still ONE argument.
/// The path is appended when there is no placeholder.
pub fn build_custom(command: &str, path: &str) -> Result<(String, Vec<String>), String> {
    build_custom_for(command, path, cfg!(windows))
}

/// Shell-style split; on Windows a backslash is a path separator, not an escape.
fn split_command(command: &str, windows: bool) -> Result<Vec<String>, shell_words::ParseError> {
    if windows {
        let mut out = String::with_capacity(command.len() + 8);
        let mut chars = command.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '\\' && chars.peek() != Some(&'"') {
                out.push_str("\\\\");
            } else {
                out.push(c);
            }
        }
        shell_words::split(&out)
    } else {
        shell_words::split(command)
    }
}

fn build_custom_for(command: &str, path: &str, windows: bool) -> Result<(String, Vec<String>), String> {
    let tokens = split_command(command, windows).map_err(|e| format!("invalid custom command: {e}"))?;
    let (program, rest) = tokens.split_first().ok_or("the custom command is empty")?;
    if program.contains("{path}") {
        return Err("the program name cannot contain {path}".into());
    }
    let mut args: Vec<String> = Vec::new();
    let mut substituted = false;
    for t in rest {
        if t.contains("{path}") {
            substituted = true;
            args.push(t.replace("{path}", path));
        } else {
            args.push(t.clone());
        }
    }
    if !substituted {
        args.push(path.to_string());
    }
    Ok((program.clone(), args))
}

pub fn open_in_editor(path: &str, editor: &str, custom: &str, new_window: bool) -> Result<(), String> {
    if !Path::new(path).exists() {
        return Err(format!("{path} does not exist"));
    }
    if editor == "custom" {
        let (program, args) = build_custom(custom, path)?;
        let mut cmd = Command::new(resolve_program(&program));
        cmd.args(args);
        no_window(&mut cmd);
        return spawn_detached(&mut cmd);
    }
    let spec = EDITORS.iter().find(|e| e.id == editor).ok_or_else(|| format!("unknown editor: {editor}"))?;
    let exe = resolve_editor(spec).ok_or_else(|| format!("{} was not found on this machine", spec.name))?;
    let mut cmd = Command::new(exe);
    let flag = if new_window { spec.new_flag } else { spec.reuse_flag };
    if let Some(f) = flag {
        cmd.arg(f);
    }
    cmd.arg(path);
    no_window(&mut cmd);
    spawn_detached(&mut cmd)
}

fn auto_terminal() -> &'static str {
    os_terminals().iter().map(|(id, _)| *id).find(|id| terminal_available(id)).unwrap_or(os_terminals()[0].0)
}

pub fn open_terminal(dir: &str, terminal: &str, custom: &str) -> Result<(), String> {
    let d = Path::new(dir);
    if !d.is_dir() {
        return Err(format!("{dir} is not a folder"));
    }
    let id = if terminal == "auto" || terminal.is_empty() { auto_terminal() } else { terminal };
    if id == "custom" {
        let (program, args) = build_custom(custom, dir)?;
        let mut cmd = Command::new(resolve_program(&program));
        cmd.args(args).current_dir(d);
        // Console programs need their own window; GUI programs ignore the flag.
        new_console(&mut cmd);
        return spawn_detached(&mut cmd);
    }
    if !os_terminals().iter().any(|(i, _)| *i == id) {
        return Err(format!("unknown terminal: {id}"));
    }
    let mut cmd;
    match id {
        "windows-terminal" => {
            cmd = Command::new(resolve_program("wt"));
            cmd.arg("-d").arg(d);
            no_window(&mut cmd);
        }
        "powershell" => {
            cmd = Command::new(which_any(&["pwsh", "powershell"]).ok_or("PowerShell was not found")?);
            cmd.arg("-NoExit").current_dir(d);
            new_console(&mut cmd);
        }
        "cmd" => {
            cmd = Command::new("cmd");
            cmd.current_dir(d);
            new_console(&mut cmd);
        }
        "terminal" => {
            cmd = Command::new("open");
            cmd.args(["-a", "Terminal"]).arg(d);
        }
        "iterm" => {
            cmd = Command::new("open");
            cmd.args(["-a", "iTerm"]).arg(d);
        }
        "gnome-terminal" => {
            cmd = Command::new("gnome-terminal");
            let mut a = std::ffi::OsString::from("--working-directory=");
            a.push(d);
            cmd.arg(a);
        }
        "konsole" => {
            cmd = Command::new("konsole");
            cmd.arg("--workdir").arg(d);
        }
        other => {
            cmd = Command::new(other);
            cmd.current_dir(d);
        }
    }
    spawn_detached(&mut cmd)
}

/// Only http and https URLs with a host.
pub fn validate_url(raw: &str) -> Result<url::Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("invalid URL".into());
    }
    let u = url::Url::parse(trimmed).map_err(|_| "invalid URL".to_string())?;
    match u.scheme() {
        "http" | "https" if u.host_str().is_some_and(|h| !h.is_empty()) => Ok(u),
        other => Err(format!("only http and https URLs can be opened, not {other}:")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_validation() {
        assert!(validate_url("https://github.com/a/b").is_ok());
        assert!(validate_url("http://localhost:3000/x?y=1").is_ok());
        for bad in [
            "",
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "ftp://example.com",
            "calc.exe",
            "C:\\Windows\\notepad.exe",
            "https://",
            "http://exa mple.com",
            "ms-msdt:/id x",
            "https://a.com\nfoo",
        ] {
            assert!(validate_url(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn custom_command_splitting() {
        let (p, a) = build_custom("code -n {path}", "C:\\My Projects\\x").unwrap();
        assert_eq!((p.as_str(), a), ("code", vec!["-n".to_string(), "C:\\My Projects\\x".to_string()]));
        let (p, a) = build_custom("\"C:\\Program Files\\Ed\\ed.exe\" --goto", "/tmp/a b").unwrap();
        assert_eq!(p, "C:\\Program Files\\Ed\\ed.exe");
        assert_eq!(a, vec!["--goto", "/tmp/a b"]);
        // Unquoted Windows paths keep their backslashes.
        let (p, a) = build_custom_for("C:\\Tools\\ed.exe -n {path}", "D:\\p", true).unwrap();
        assert_eq!((p.as_str(), a), ("C:\\Tools\\ed.exe", vec!["-n".to_string(), "D:\\p".to_string()]));
        let (_, a) = build_custom("ed --dir={path} --again {path}", "/x y").unwrap();
        assert_eq!(a, vec!["--dir=/x y", "--again", "/x y"]);
        let (_, a) = build_custom("ed 'a b' c", "/p").unwrap();
        assert_eq!(a, vec!["a b", "c", "/p"]);
        assert!(build_custom("   ", "/p").is_err());
        assert!(build_custom("ed \"unterminated", "/p").is_err());
        // Shell metacharacters in the path stay one inert argument.
        let (_, a) = build_custom("ed {path}", "/p; rm -rf / && echo $(x)").unwrap();
        assert_eq!(a, vec!["/p; rm -rf / && echo $(x)"]);
    }

    #[test]
    fn launcher_lists_include_custom() {
        let l = list_launchers();
        assert!(l.editors.iter().any(|e| e.id == "code"));
        assert!(l.editors.last().unwrap().available && l.editors.last().unwrap().id == "custom");
        assert!(l.terminals.last().unwrap().id == "custom");
        assert!(open_in_editor("/definitely/not/here", "code", "", true).is_err());
        assert!(open_terminal("/definitely/not/here", "auto", "").is_err());
    }

    #[test]
    fn env_expansion() {
        std::env::set_var("RB_TEST_X", "val");
        assert_eq!(expand_env("%RB_TEST_X%\\a"), "val\\a");
        assert_eq!(expand_env("100%"), "100%");
    }
}
