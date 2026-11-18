/**
 * CONTRACT between the TypeScript app and the Rust backend (src-tauri/src).
 *
 * Every Rust command is listed here with its exact name, argument names and result shape.
 * Tauri maps the camelCase argument keys used here to snake_case Rust parameters.
 * Results are serialised with `#[serde(rename_all = "camelCase")]`.
 *
 * Design rules:
 *  - Rust never exposes a generic "run git with these args" command. Every git invocation has
 *    its argument list fixed in Rust, so the webview can't turn git into an execution path
 *    (e.g. `-c core.sshCommand=...`).
 *  - Background reads always use READ_FLAGS + the non-interactive environment (see git.rs).
 *  - Rust moves catalog/settings/cache files as TEXT. TypeScript owns their schema
 *    (`sanitizeCatalog`), so the app and the VS Code extension can never drift apart.
 *  - Every spawned process on Windows uses CREATE_NO_WINDOW.
 */
import type { Availability } from '../domain/model';

export type Platform = 'win32' | 'darwin' | 'linux';

export interface PlatformInfo {
  platform: Platform;
  /** User home directory. */
  home: string;
  /** Folder shared with the VS Code extension; holds catalog.json. `REPOBOARD_DATA_DIR` overrides it. */
  sharedDir: string;
  /** The app's own folder; holds settings.json and meta-cache.json. `REPOBOARD_DATA_DIR` overrides it too. */
  appDir: string;
  /** App version from Cargo.toml / tauri.conf.json. */
  version: string;
}

/** Result of one git process. */
export interface GitRun {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** git is not on PATH (spawn failed with NotFound). */
  missingGit: boolean;
}

/**
 * The four reads `git_status` runs in parallel in `folder`, all with READ_FLAGS:
 *   status:  status --porcelain=v2 --branch
 *   log:     log -1 --format=%h%x1f%s%x1f%an%x1f%ct
 *   stash:   rev-list --walk-reflogs --count refs/stash
 *   remotes: remote -v
 */
export interface GitStatusRaw {
  status: GitRun;
  log: GitRun;
  stash: GitRun;
  remotes: GitRun;
}

export type RemoteOp = 'fetch' | 'pull' | 'push';

/** lstat-based kind: symlinks / junctions are reported as 'link' and never followed. */
export type PathKind = 'dir' | 'file' | 'link' | 'none';

/** Names of the data files Rust may read and write. */
export type DataFile = 'catalog' | 'settings' | 'meta-cache';

export interface LauncherInfo {
  /** Stable id stored in settings, e.g. 'code', 'cursor', 'windows-terminal', 'custom'. */
  id: string;
  /** Display name, e.g. "Visual Studio Code". */
  name: string;
  /** Found on this machine (on PATH or in its usual install location). 'custom' is always true. */
  available: boolean;
}

export interface Launchers {
  editors: LauncherInfo[];
  terminals: LauncherInfo[];
}

/** Events Rust emits to the webview. */
export const EVENTS = {
  /** payload: string, the new catalog.json text. Debounced 150 ms; only when the text differs from what we last wrote. */
  catalogChanged: 'catalog-changed',
  /** payload: null. The global shortcut fired (window is already shown and focused): open the switcher. */
  globalSwitcher: 'global-switcher',
  /** payload: 'fetchAll' | 'pullAll' | 'scan' | 'switcher' | 'settings'. A tray menu item was clicked. */
  trayAction: 'tray-action',
} as const;

export type TrayAction = 'fetchAll' | 'pullAll' | 'scan' | 'switcher' | 'settings';

/** A newer release found by the updater. */
export interface UpdateInfo {
  version: string;
  currentVersion: string;
  /** Release notes (markdown or plain text); may be empty. */
  notes: string;
  /** Publication date as the updater reports it. */
  date?: string;
}

/** The Rust side of the app. `src/host/tauri.ts` implements it with `invoke`; `src/host/mock.ts` fakes it in a browser. */
export interface HostApi {
  /** Rust: platform_info() */
  platformInfo(): Promise<PlatformInfo>;

  // ── git (argument lists fixed in Rust) ─────────────────────────────────
  /** Rust: git_status(folder). Timeout 8 s per process. */
  gitStatus(folder: string): Promise<GitStatusRaw>;
  /** Rust: git_worktree_list(folder) → `worktree list --porcelain` with READ_FLAGS. */
  gitWorktreeList(folder: string): Promise<GitRun>;
  /** Rust: git_short_status(folder) → `status --porcelain=v2` (no --branch) with READ_FLAGS; used per worktree. */
  gitShortStatus(folder: string): Promise<GitRun>;
  /** Rust: git_fetch_background(folder) → READ_FLAGS + `fetch --quiet --no-tags --no-write-fetch-head`, 30 s timeout. */
  gitFetchBackground(folder: string): Promise<boolean>;
  /**
   * Rust: git_remote(folder, op) — a fetch / pull / push the user asked for. Runs like the user's own git
   * (hooks apply) with `-c core.fsmonitor=false -c core.quotepath=off`, non-interactive env, 180 s timeout.
   *   fetch: fetch --quiet   pull: pull --ff-only --quiet   push: push --quiet
   * Any other `op` is rejected.
   */
  gitRemote(folder: string, op: RemoteOp): Promise<GitRun>;

  // ── file system (read-only, bounded) ───────────────────────────────────
  /** Rust: path_kind(path) — lstat. */
  pathKind(path: string): Promise<PathKind>;
  /** Rust: git_dot_file(folder) — contents of `<folder>/.git` when it is a FILE (worktree / submodule), else null. Max 4 KiB. */
  gitDotFile(folder: string): Promise<string | null>;
  /** Rust: has_linked_worktrees(folder) — `<folder>/.git/worktrees` exists and is non-empty. */
  hasLinkedWorktrees(folder: string): Promise<boolean>;
  /** Rust: availability(path) — 'ok' if it exists; 'missing' if its root (drive / share / mount) exists; else 'offline'. */
  availability(path: string): Promise<Availability>;
  /**
   * Rust: discover_repos(roots, maxDepth, ignoreDirs) — breadth-first walk, same rules as the extension's
   * services/discovery.ts: stop at the first `.git` (dir or file), never follow symlinks/junctions, skip hidden
   * folders and ignoreDirs (case-insensitive), cap 20 000 dirs per root, dedupe (case-insensitive on Windows),
   * sorted. Returns absolute paths.
   */
  discoverRepos(roots: string[], maxDepth: number, ignoreDirs: string[]): Promise<string[]>;
  /**
   * Rust: scan_languages(folder, extensions, ignoreDirs, maxFiles) — the extension's scanLanguages walk
   * (breadth-first, max depth 10, skip hidden + ignoreDirs + symlinks). `extensions` maps a lowercase file
   * extension (without dot, may contain a dot like "blade.php") to a language name. Rust applies the special
   * file-name rules of languages.ts `languageForFile` (dockerfile, makefile, cmakelists.txt, blade.php, and the
   * excluded .min.js/.min.css/.d.ts/.g.cs/.designer.cs). Only files with a language count toward maxFiles.
   * Returns bytes per language name (each file counts at least 1 byte).
   */
  scanLanguages(folder: string, extensions: Record<string, string>, ignoreDirs: string[], maxFiles: number): Promise<Record<string, number>>;
  /** Rust: find_logo(folder) — first of the extension's LOGO_CANDIDATES that is a file of 1..=96 KiB, as a data: URI. */
  findLogo(folder: string): Promise<string | null>;

  // ── data files (text only; TypeScript owns the schema) ─────────────────
  /** Rust: read_data(name) — file text, or null when it does not exist. */
  readData(name: DataFile): Promise<string | null>;
  /** Rust: write_data(name, text) — atomic: write `<file>.<pid>.<ms>.tmp`, rename, retry up to 6× on PermissionDenied/busy (40 ms × attempt). Creates the folder. */
  writeData(name: DataFile, text: string): Promise<void>;
  /** Rust: backup_data(name) — copies the file to `<file>.broken-<ms>`; returns the backup path or null. */
  backupData(name: DataFile): Promise<string | null>;
  /** Rust: data_file_path(name) — absolute path of the file (it may not exist yet). */
  dataFilePath(name: DataFile): Promise<string>;
  /** Rust: watch_catalog() — starts (once) a watch on the catalog's folder; emits EVENTS.catalogChanged. */
  watchCatalog(): Promise<void>;

  // ── launching things ──────────────────────────────────────────────────
  /** Rust: list_launchers() — known editors and terminals for this OS, with availability. */
  listLaunchers(): Promise<Launchers>;
  /**
   * Rust: open_in_editor(path, editor, customCommand, newWindow). `editor` is a LauncherInfo id.
   * VS Code family (code, code-insiders, cursor, windsurf, codium): `-n` for a new window, `-r` to reuse.
   * 'custom': `customCommand` is split shell-style; `{path}` is replaced by the path as ONE argument
   * (appended when there is no placeholder). Never run through a shell. On Windows `.cmd` shims are resolved.
   */
  openInEditor(path: string, editor: string, customCommand: string, newWindow: boolean): Promise<void>;
  /** Rust: open_terminal(dir, terminal, customCommand) — 'auto' picks the best available terminal for the OS. */
  openTerminal(dir: string, terminal: string, customCommand: string): Promise<void>;
  /** Rust: reveal(path) — shows the item in Explorer / Finder / the file manager. */
  reveal(path: string): Promise<void>;
  /** Rust: open_url(url) — only http:// and https:// URLs; anything else is rejected. */
  openUrl(url: string): Promise<void>;
  /** Rust: open_data_file(name) — opens a data file with the OS default app. Errors when it does not exist (TS saves it first). */
  openDataFile(name: DataFile): Promise<void>;
  /** Rust: set_global_shortcut(accelerator) — replaces the registered global shortcut; '' unregisters. Errors when the accelerator is invalid or taken. */
  setGlobalShortcut(accelerator: string): Promise<void>;
  /** Rust: set_close_to_tray(enabled) — when true, closing the main window hides it instead of quitting (tray "Quit" exits). */
  setCloseToTray(enabled: boolean): Promise<void>;

  // ── provided by Tauri plugins on the JS side ──────────────────────────
  /** @tauri-apps/plugin-dialog `open({ directory: true, multiple })`. */
  pickFolders(options: { multiple: boolean; title: string }): Promise<string[]>;
  /** @tauri-apps/plugin-clipboard-manager `writeText`. */
  copyText(text: string): Promise<void>;
  /** @tauri-apps/api/event `listen`. Returns an unlisten function. */
  on<T>(event: string, handler: (payload: T) => void): Promise<() => void>;
  /** @tauri-apps/plugin-updater `check()`. null = up to date. Rejects when offline or no release is published. The found update is kept for `installUpdate`. */
  checkUpdate(): Promise<UpdateInfo | null>;
  /**
   * `downloadAndInstall` of the update found by the last `checkUpdate`, then `relaunch()` (plugin-process).
   * `total` is undefined when the server sends no length. Rejects on failure.
   */
  installUpdate(onProgress: (downloaded: number, total: number | undefined) => void): Promise<void>;
}
