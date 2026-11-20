import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { LOG_FORMAT } from '../../src/domain/gitParse';
import type { GitRun, HostApi, PathKind } from '../../src/host/api';

/**
 * A HostApi backed by Node: real `git` processes (same flags as the Rust side) and real file system reads.
 * Only what GitClient and worktreeMainOf need is implemented; anything else throws.
 */
const READ_FLAGS = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.quotepath=off', '-c', 'color.ui=false'];

const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };

function run(cwd: string, args: string[], timeout = 8000): Promise<GitRun> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env: ENV }, (error, stdout, stderr) => {
      const missingGit = (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
      resolve({ ok: !error, stdout: stdout ?? '', stderr: stderr ?? (error?.message || ''), missingGit });
    });
  });
}

const unsupported = (name: string) => async (): Promise<never> => {
  throw new Error(`nodeHost: ${name} is not implemented`);
};

export function createNodeHost(): HostApi {
  const read = (folder: string, ...args: string[]) => run(folder, [...READ_FLAGS, ...args]);
  return {
    platformInfo: unsupported('platformInfo'),
    async gitStatus(folder) {
      const [status, log, stash, remotes] = await Promise.all([
        read(folder, 'status', '--porcelain=v2', '--branch'),
        read(folder, 'log', '-1', `--format=${LOG_FORMAT}`),
        read(folder, 'stash', 'list', '--format=%gd%x1f%ct%x1f%gs'),
        read(folder, 'remote', '-v'),
      ]);
      return { status, log, stash, remotes };
    },
    gitWorktreeList: (folder) => read(folder, 'worktree', 'list', '--porcelain'),
    gitShortStatus: (folder) => read(folder, 'status', '--porcelain=v2'),
    gitFetchBackground: (folder) => read(folder, 'fetch', '--quiet', '--no-tags'),
    gitRemote: (folder, op) => {
      const args = { fetch: ['fetch', '--quiet'], pull: ['pull', '--ff-only', '--quiet'], push: ['push', '--quiet'] }[op];
      return run(folder, ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off', ...args], 180_000);
    },

    async pathKind(p): Promise<PathKind> {
      try {
        const st = await fs.lstat(p);
        return st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file';
      } catch {
        return 'none';
      }
    },
    async gitDotFile(folder) {
      try {
        const file = path.join(folder, '.git');
        return (await fs.lstat(file)).isFile() ? await fs.readFile(file, 'utf8') : null;
      } catch {
        return null;
      }
    },
    async hasLinkedWorktrees(folder) {
      try {
        return (await fs.readdir(path.join(folder, '.git', 'worktrees'))).length > 0;
      } catch {
        return false;
      }
    },
    async gitLastFetch(folder) {
      const mtime = async (p: string) => {
        try {
          return (await fs.stat(p)).mtimeMs;
        } catch {
          return null;
        }
      };
      let gitdir = path.join(folder, '.git');
      let common = gitdir;
      try {
        if ((await fs.lstat(gitdir)).isFile()) {
          const m = /^gitdir:\s*(.+)$/m.exec(await fs.readFile(gitdir, 'utf8'));
          if (!m) return null;
          gitdir = path.resolve(folder, m[1]!.trim());
          common = gitdir;
          try {
            const c = (await fs.readFile(path.join(gitdir, 'commondir'), 'utf8')).trim();
            if (c) common = path.resolve(gitdir, c);
          } catch {
            /* no commondir */
          }
        }
      } catch {
        return null;
      }
      const times: Array<number | null> = [await mtime(path.join(gitdir, 'FETCH_HEAD')), await mtime(path.join(common, 'FETCH_HEAD'))];
      try {
        for (const w of await fs.readdir(path.join(common, 'worktrees'))) times.push(await mtime(path.join(common, 'worktrees', w, 'FETCH_HEAD')));
      } catch {
        /* none */
      }
      const walk = async (dir: string, depth: number): Promise<void> => {
        let entries;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (e.isDirectory()) {
            if (depth < 6) await walk(path.join(dir, e.name), depth + 1);
          } else if (e.isFile()) times.push(await mtime(path.join(dir, e.name)));
        }
      };
      await walk(path.join(common, 'logs', 'refs', 'remotes'), 0);
      const found = times.filter((t): t is number => t !== null);
      return found.length ? Math.max(...found) : null;
    },
    availability: unsupported('availability'),
    discoverRepos: unsupported('discoverRepos'),
    scanLanguages: unsupported('scanLanguages'),
    findLogo: unsupported('findLogo'),
    readData: unsupported('readData'),
    writeData: unsupported('writeData'),
    backupData: unsupported('backupData'),
    dataFilePath: unsupported('dataFilePath'),
    watchCatalog: unsupported('watchCatalog'),
    listLaunchers: unsupported('listLaunchers'),
    openInEditor: unsupported('openInEditor'),
    openTerminal: unsupported('openTerminal'),
    reveal: unsupported('reveal'),
    openUrl: unsupported('openUrl'),
    openDataFile: unsupported('openDataFile'),
    setGlobalShortcut: unsupported('setGlobalShortcut'),
    setCloseToTray: unsupported('setCloseToTray'),
    checkUpdate: unsupported('checkUpdate'),
    installUpdate: unsupported('installUpdate'),
    pickFolders: unsupported('pickFolders'),
    copyText: unsupported('copyText'),
    on: unsupported('on') as unknown as HostApi['on'],
  };
}
