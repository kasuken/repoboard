/**
 * CONTRACT between the board UI (src/ui) and the app core (src/core).
 *
 * This is the extension's webview protocol (vscode-repoboard/src/webview/protocol.ts), kept so the
 * extension's dashboard code ports over almost unchanged. Both sides now live in the same JS context:
 * the UI calls `send(message)`; the core answers through `post(message)` (see src/core/bridge.ts).
 *
 * Changes from the extension:
 *  - VS Code-only messages are gone: addCurrent, startPage, openSettings (settings are in-app now).
 *  - Notifications with buttons (`ask`), progress with cancel (`progress`), the log, the switcher,
 *    in-app settings and the data-file commands are new.
 */
import type { Launchers, Platform } from '../host/api';
import type { Collection, Project, ProjectMeta, SortMode, ViewMode, WorktreeMode } from '../domain/model';

export type RemoteOp = 'fetch' | 'pull' | 'push';

/** Every user-configurable setting. Stored as JSON in `<appDir>/settings.json`. */
export interface AppSettings {
  /** Folders scanned for git repositories. `~` works. */
  scanRoots: string[];
  /** 1–8. */
  scanDepth: number;
  /** Re-scan when the app starts / regains focus, at most every 10 minutes. */
  autoScan: boolean;
  ignoreDirs: string[];
  worktrees: WorktreeMode;
  /** Open projects in a new editor window by default (Ctrl/Cmd+click does the opposite). */
  openInNewWindow: boolean;
  defaultView: ViewMode;
  defaultSort: SortMode;
  /** Background `git fetch` when the app starts or the board is refreshed. */
  fetchOnOpen: boolean;
  /** Minutes git status is reused (≥ 0). */
  cacheMinutes: number;
  detectLanguages: boolean;
  /** ≥ 100. */
  maxFilesScanned: number;
  /** Launcher id from `Launchers.editors`, or 'custom'. */
  editor: string;
  /** Used when editor = 'custom'. `{path}` is the project folder. */
  editorCommand: string;
  /** Launcher id from `Launchers.terminals`, 'auto', or 'custom'. */
  terminal: string;
  /** Used when terminal = 'custom'. `{path}` is the folder. */
  terminalCommand: string;
  /** Tauri accelerator that brings the app forward with the switcher open, e.g. "CommandOrControl+Alt+Shift+P". '' = off. */
  globalShortcut: string;
  theme: 'system' | 'light' | 'dark';
  /** Closing the window hides it to the tray instead of quitting. */
  closeToTray: boolean;
  /** Look for a new version on GitHub when the app starts, at most once a day. */
  checkForUpdates: boolean;
  /** Epoch ms of the last completed update check. Kept by the core, not shown in Settings. */
  lastUpdateCheck: number;
}

export const DEFAULT_IGNORE_DIRS: readonly string[] = [
  'node_modules', 'bower_components', 'vendor', 'bin', 'obj', 'dist', 'out', 'build', 'target', '.venv', 'venv',
  '__pycache__', '.next', '.nuxt', '.gradle', '.idea', '.vs', '.vscode', 'Library', 'Pods', 'DerivedData',
  '.dart_tool', '.cache', 'coverage',
];

export const DEFAULT_SETTINGS: AppSettings = {
  scanRoots: [],
  scanDepth: 3,
  autoScan: true,
  ignoreDirs: [...DEFAULT_IGNORE_DIRS],
  worktrees: 'nested',
  openInNewWindow: true,
  defaultView: 'grid',
  defaultSort: 'recent',
  fetchOnOpen: true,
  cacheMinutes: 5,
  detectLanguages: true,
  maxFilesScanned: 10000,
  editor: 'code',
  editorCommand: '',
  terminal: 'auto',
  terminalCommand: '',
  globalShortcut: 'CommandOrControl+Alt+Shift+P',
  theme: 'system',
  closeToTray: false,
  checkForUpdates: true,
  lastUpdateCheck: 0,
};

/** Project as the UI sees it. Metadata is sent separately, keyed by project id. */
export interface ProjectView extends Project {
  displayPath: string;
  /** Always false in the standalone app (there is no "current folder"); kept so the ported UI compiles. */
  isCurrent: boolean;
}

export interface BoardSettings {
  openInNewWindow: boolean;
  defaultView: ViewMode;
  defaultSort: SortMode;
  hasScanRoots: boolean;
  isMac: boolean;
  platform: Platform;
}

export interface BoardState {
  projects: ProjectView[];
  collections: Collection[];
  meta: Record<string, ProjectMeta>;
  busy: string[];
  settings: BoardSettings;
  /** Full settings, for the Settings dialog. */
  appSettings: AppSettings;
  /** Editors / terminals found on this machine, for the Settings dialog and "Open with…". */
  launchers: Launchers;
  /** Name of the selected editor, e.g. "Visual Studio Code" (menu label "Open in Visual Studio Code"). */
  editorName: string;
  scanning: boolean;
  gitAvailable: boolean;
  /** Number of paths the user removed and discovery skips ("Forget removed repos" is enabled when > 0). */
  ignoredCount: number;
  /** Absolute path of catalog.json, shown in Settings. */
  dataFile: string;
  version: string;
}

export interface ProgressTask {
  id: number;
  title: string;
  message?: string;
  /** 0–100; undefined = indeterminate. */
  percent?: number;
  cancellable: boolean;
}

export type HostMessage =
  | { type: 'state'; state: BoardState }
  | { type: 'meta'; id: string; meta: ProjectMeta }
  | { type: 'busy'; id: string; busy: boolean }
  | { type: 'scanning'; scanning: boolean }
  | { type: 'edit'; id: string }
  | { type: 'focusSearch' }
  | { type: 'toast'; text: string; kind: 'info' | 'error' }
  /**
   * A notification with buttons (replaces vscode.window.showInformationMessage(msg, ...items)).
   * The UI shows it until a button is clicked or it is dismissed, then answers with `{ type: 'answer', id, action }`
   * (`action` undefined when dismissed). Shown in a stack at the bottom right; does not block the board.
   */
  | { type: 'ask'; id: number; text: string; kind: 'info' | 'warning' | 'error'; actions: string[] }
  /** Start / update a progress task (`task`), or end it (`done: true`). Several may run at once. */
  | { type: 'progress'; task: ProgressTask; done?: boolean }
  /** Open the project switcher (global shortcut, tray menu). */
  | { type: 'switcher' }
  /** Open the Settings dialog (tray menu). */
  | { type: 'openSettings' }
  /** Answer to `showLog`. */
  | { type: 'log'; lines: string[] };

export interface ProjectEdit {
  name: string;
  description: string;
  icon: string;
  color: string;
  collectionId: string | null;
  tags: string;
}

export type WorktreeAction = 'open' | 'newWindow' | 'terminal' | 'reveal';

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'open'; id: string; newWindow: boolean }
  | { type: 'terminal'; id: string }
  | { type: 'reveal'; id: string }
  | { type: 'openRemote'; id: string }
  | { type: 'copyPath'; id: string }
  | { type: 'pin'; id: string; pinned: boolean }
  | { type: 'saveProject'; id: string; edit: ProjectEdit }
  | { type: 'removeProject'; id: string }
  | { type: 'moveProject'; id: string; collectionId: string | null; index: number }
  | { type: 'saveCollection'; id?: string; name: string; color?: string }
  | { type: 'removeCollection'; id: string }
  | { type: 'moveCollection'; id: string; index: number }
  | { type: 'collapse'; id: string; collapsed: boolean }
  | { type: 'git'; id: string; op: RemoteOp }
  | { type: 'refresh'; id?: string }
  | { type: 'addFolder' }
  | { type: 'scan' }
  | { type: 'addScanRoot' }
  | { type: 'fetchAll' }
  | { type: 'pullAll' }
  | { type: 'worktree'; id: string; path: string; action: WorktreeAction }
  // ── new in the standalone app ──
  /** Open the project with a specific editor instead of the configured one ("Open with…"). */
  | { type: 'openWith'; id: string; editor: string }
  /** Save the whole settings object (Settings dialog). The core validates/clamps and re-registers the global shortcut. */
  | { type: 'saveSettings'; settings: AppSettings }
  /** Folder picker for the Settings dialog's scan-folder list: picks, adds, scans. */
  | { type: 'pickScanRoots' }
  | { type: 'removeMissing' }
  | { type: 'resetIgnored' }
  | { type: 'openDataFile' }
  | { type: 'revealDataFile' }
  | { type: 'showLog' }
  | { type: 'answer'; id: number; action?: string }
  | { type: 'cancelTask'; id: number }
  | { type: 'openUrl'; url: string }
  /** "Check for updates…" in the board menu: checks now and always reports the result. */
  | { type: 'checkUpdates' };
