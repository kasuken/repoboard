import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { open } from '@tauri-apps/plugin-dialog';
import { relaunch } from '@tauri-apps/plugin-process';
import { check, type Update } from '@tauri-apps/plugin-updater';
import type { Availability } from '../domain/model';
import type { DataFile, GitRun, GitStatusRaw, HostApi, Launchers, PathKind, PlatformInfo, RemoteOp, UpdateInfo } from './api';

/** The update found by the last `checkUpdate`, kept for `installUpdate`. */
let pendingUpdate: Update | null = null;

/** The real backend: every method is one Rust command (see api.ts for the contract). Arg keys are camelCase. */
export const tauriHost: HostApi = {
  platformInfo: () => invoke<PlatformInfo>('platform_info'),

  gitStatus: (folder) => invoke<GitStatusRaw>('git_status', { folder }),
  gitWorktreeList: (folder) => invoke<GitRun>('git_worktree_list', { folder }),
  gitShortStatus: (folder) => invoke<GitRun>('git_short_status', { folder }),
  gitFetchBackground: (folder) => invoke<GitRun>('git_fetch_background', { folder }),
  gitRemote: (folder: string, op: RemoteOp) => invoke<GitRun>('git_remote', { folder, op }),

  pathKind: (path) => invoke<PathKind>('path_kind', { path }),
  gitDotFile: (folder) => invoke<string | null>('git_dot_file', { folder }),
  hasLinkedWorktrees: (folder) => invoke<boolean>('has_linked_worktrees', { folder }),
  gitLastFetch: (folder) => invoke<number | null>('git_last_fetch', { folder }),
  availability: (path) => invoke<Availability>('availability', { path }),
  discoverRepos: (roots, maxDepth, ignoreDirs) => invoke<string[]>('discover_repos', { roots, maxDepth, ignoreDirs }),
  scanLanguages: (folder, extensions, ignoreDirs, maxFiles) =>
    invoke<Record<string, number>>('scan_languages', { folder, extensions, ignoreDirs, maxFiles }),
  findLogo: (folder) => invoke<string | null>('find_logo', { folder }),

  readData: (name: DataFile) => invoke<string | null>('read_data', { name }),
  writeData: (name, text) => invoke<void>('write_data', { name, text }),
  backupData: (name) => invoke<string | null>('backup_data', { name }),
  dataFilePath: (name) => invoke<string>('data_file_path', { name }),
  watchCatalog: () => invoke<void>('watch_catalog'),

  listLaunchers: () => invoke<Launchers>('list_launchers'),
  openInEditor: (path, editor, customCommand, newWindow) => invoke<void>('open_in_editor', { path, editor, customCommand, newWindow }),
  openTerminal: (dir, terminal, customCommand) => invoke<void>('open_terminal', { dir, terminal, customCommand }),
  reveal: (path) => invoke<void>('reveal', { path }),
  openUrl: (url) => invoke<void>('open_url', { url }),
  openDataFile: (name) => invoke<void>('open_data_file', { name }),
  setGlobalShortcut: (accelerator) => invoke<void>('set_global_shortcut', { accelerator }),
  setCloseToTray: (enabled) => invoke<void>('set_close_to_tray', { enabled }),

  async pickFolders({ multiple, title }) {
    const picked = await open({ directory: true, multiple, title });
    if (picked === null || picked === undefined) return [];
    return Array.isArray(picked) ? picked : [picked];
  },
  copyText: (text) => writeText(text),
  async on<T>(event: string, handler: (payload: T) => void) {
    return listen<T>(event, (e) => handler(e.payload));
  },

  async checkUpdate(): Promise<UpdateInfo | null> {
    const update = await check();
    pendingUpdate = update;
    if (!update) return null;
    return { version: update.version, currentVersion: update.currentVersion, notes: update.body ?? '', ...(update.date ? { date: update.date } : {}) };
  },
  async installUpdate(onProgress) {
    const update = pendingUpdate;
    if (!update) throw new Error('There is no update to install. Check for updates first.');
    let downloaded = 0;
    let total: number | undefined;
    await update.downloadAndInstall((event) => {
      if (event.event === 'Started') {
        total = event.data.contentLength;
        onProgress(0, total);
      } else if (event.event === 'Progress') {
        downloaded += event.data.chunkLength;
        onProgress(downloaded, total);
      }
    });
    pendingUpdate = null;
    // On Windows the installer ends the app by itself; elsewhere relaunching restarts into the new version.
    await relaunch();
  },
};
