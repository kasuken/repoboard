import type { Availability } from '../../src/domain/model';
import type { DataFile, GitRun, HostApi, RemoteOp, UpdateInfo } from '../../src/host/api';

export interface FakeRepo {
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  modified?: number;
  conflicts?: number;
  /** Stash entries, newest first. */
  stash?: Array<{ message: string; time?: number }>;
  availability?: Availability;
  /** `git pull` fails with this message. */
  pullError?: string;
  /** What `gitLastFetch` returns (ms); null/absent = never fetched. */
  lastFetch?: number | null;
  /** `git fetch` fails with this message. */
  fetchError?: string;
}

const ok = (stdout = ''): GitRun => ({ ok: true, stdout, stderr: '', missingGit: false });
const fail = (stderr: string): GitRun => ({ ok: false, stdout: '', stderr, missingGit: false });

export interface FakeHost extends HostApi {
  repos: Map<string, FakeRepo>;
  files: Map<DataFile, string>;
  calls: { remote: Array<{ folder: string; op: RemoteOp }>; background: string[]; backups: DataFile[]; writes: Array<{ name: DataFile; text: string }>; opened: string[][]; [k: string]: unknown };
  /** Paths `discoverRepos` returns. */
  discovered: string[];
  /** What `checkUpdate` returns, or rejects with when `checkError` is set. */
  update: UpdateInfo | null;
  /** When set, every background fetch waits until `release()` is called (to fill the network limiter in tests). */
  holdFetches?: { waiting: Array<() => void> };
  checkError?: string;
  /** `installUpdate` rejects with this message. */
  installError?: string;
  /** Progress reported by `installUpdate` before it finishes. */
  installProgress: Array<[number, number | undefined]>;
  updateCalls: { checks: number; installs: number; urls: string[] };
  emit(event: string, payload?: unknown): void;
  /** Simulates the file watcher delivering `text`. */
  fileChanged(text: string): void;
}

/** In-memory HostApi for core tests: git state per repo path, data files in a Map, events by hand. */
export function createFakeHost(repos: Record<string, FakeRepo> = {}, platform: 'linux' | 'win32' | 'darwin' = 'linux'): FakeHost {
  const repoMap = new Map(Object.entries(repos));
  const listeners = new Map<string, Set<(p: never) => void>>();
  const host: FakeHost = {
    repos: repoMap,
    files: new Map(),
    calls: { remote: [], background: [], backups: [], writes: [], opened: [] },
    discovered: [],
    update: null,
    installProgress: [[0, 1000], [500, 1000], [1000, 1000]],
    updateCalls: { checks: 0, installs: 0, urls: [] },
    emit(event, payload = null) {
      for (const l of listeners.get(event) ?? []) (l as (p: unknown) => void)(payload);
    },
    fileChanged(text) {
      host.emit('catalog-changed', text);
    },

    async platformInfo() {
      return { platform, home: platform === 'win32' ? 'C:\\Users\\me' : '/home/me', sharedDir: '/shared', appDir: '/app', version: '9.9.9', updaterEnabled: true };
    },
    async gitStatus(folder) {
      const r = repoMap.get(folder);
      if (!r) {
        const none = fail('fatal: not a git repository');
        return { status: none, log: none, stash: none, remotes: none };
      }
      const lines = [`# branch.oid ${'a'.repeat(40)}`, `# branch.head ${r.branch ?? 'main'}`];
      const upstream = 'upstream' in r ? r.upstream : 'origin/main';
      if (upstream) lines.push(`# branch.upstream ${upstream}`, `# branch.ab +${r.ahead ?? 0} -${r.behind ?? 0}`);
      for (let i = 0; i < (r.modified ?? 0); i++) lines.push(`1 .M N... 100644 100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} f${i}.ts`);
      for (let i = 0; i < (r.conflicts ?? 0); i++) lines.push(`u UU N... 100644 100644 100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} ${'c'.repeat(40)} c${i}.ts`);
      return { status: ok(lines.join('\n') + '\n'), log: ok(`abc1234\x1fsubject\x1fme\x1f1700000000\n`), stash: ok((r.stash ?? []).map((e, i) => `stash@{${i}}\x1f${e.time ?? 1700000000}\x1f${e.message}\n`).join('')), remotes: ok('origin\thttps://github.com/x/y.git (fetch)\n') };
    },
    async gitWorktreeList() {
      return ok();
    },
    async gitShortStatus() {
      return ok();
    },
    async gitFetchBackground(folder) {
      host.calls.background.push(folder);
      const hold = host.holdFetches;
      if (hold) await new Promise<void>((resolve) => hold.waiting.push(resolve));
      const r = repoMap.get(folder);
      if (!r) return fail('fatal: not a git repository');
      return r.fetchError ? fail(r.fetchError) : ok();
    },
    async gitRemote(folder, op) {
      host.calls.remote.push({ folder, op });
      const r = repoMap.get(folder);
      if (!r) return fail('not a repo');
      if (op === 'fetch') return r.fetchError ? fail(r.fetchError) : ok();
      if (op === 'pull') {
        if (r.pullError) return fail(r.pullError);
        r.behind = 0;
      }
      return ok();
    },

    async pathKind(path) {
      const m = /^(.*)[\\/]\.git$/.exec(path);
      return m && repoMap.has(m[1]!) ? 'dir' : 'none';
    },
    async gitDotFile() {
      return null;
    },
    async hasLinkedWorktrees() {
      return false;
    },
    async gitLastFetch(folder) {
      return repoMap.get(folder)?.lastFetch ?? null;
    },
    async availability(path) {
      return repoMap.get(path)?.availability ?? 'ok';
    },
    async discoverRepos() {
      return [...host.discovered];
    },
    async scanLanguages() {
      return {};
    },
    async findLogo() {
      return null;
    },

    async readData(name) {
      return host.files.get(name) ?? null;
    },
    async writeData(name, text) {
      host.calls.writes.push({ name, text });
      host.files.set(name, text);
    },
    async backupData(name) {
      host.calls.backups.push(name);
      return `/backup/${name}.broken`;
    },
    async dataFilePath(name) {
      return `/data/${name}.json`;
    },
    async watchCatalog() {},

    async listLaunchers() {
      return { editors: [{ id: 'code', name: 'Visual Studio Code', available: true }, { id: 'custom', name: 'Custom command', available: true }], terminals: [] };
    },
    async openInEditor(path, editor, customCommand, newWindow) {
      host.calls.opened.push([path, editor, customCommand, String(newWindow)]);
    },
    async openTerminal() {},
    async reveal() {},
    async openUrl(url) {
      host.updateCalls.urls.push(url);
    },
    async openDataFile() {},
    async setGlobalShortcut() {},
    async setCloseToTray() {},

    async pickFolders() {
      return [];
    },
    async copyText() {},
    async on<T>(event: string, handler: (payload: T) => void) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(handler as (p: never) => void);
      return () => {
        set.delete(handler as (p: never) => void);
      };
    },

    async checkUpdate() {
      host.updateCalls.checks++;
      if (host.checkError) throw new Error(host.checkError);
      return host.update;
    },
    async installUpdate(onProgress) {
      host.updateCalls.installs++;
      for (const [done, total] of host.installProgress) onProgress(done, total);
      if (host.installError) throw new Error(host.installError);
    },
  };
  return host;
}
