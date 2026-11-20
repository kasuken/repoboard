/**
 * In-memory fake of the Rust backend, for running the UI in a normal browser (`npm run dev`).
 * It speaks the same raw git output the real backend returns, so the real parsers in src/domain/gitParse.ts
 * turn it into dirty / behind / ahead / conflict / missing / offline / worktree / error states.
 * Sample data is fictional (ported from dev/fixtures.js). The catalog and settings persist in localStorage.
 */
import type { Availability } from '../domain/model';
import type { DataFile, GitRun, GitStatusRaw, HostApi, Launchers, PathKind, PlatformInfo, RemoteOp, UpdateInfo } from './api';

const BS = '\\';
const HOME = `C:${BS}Users${BS}dev`;
const CODE = `${HOME}${BS}code`;
const key = (p: string) => p.replace(/[\\/]+$/, '').replace(/\//g, BS).toLowerCase();
const codePath = (name: string) => `${CODE}${BS}${name}`;

interface WorktreeSpec {
  /** Forward slashes, as git reports them on Windows. */
  path: string;
  branch: string;
  changes: number;
  prunable?: boolean;
  locked?: boolean;
}

interface RepoSpec {
  path: string;
  availability: Availability;
  /** Folder exists but is not a git repository. */
  noGit?: boolean;
  /** `git status` fails with this stderr (e.g. dubious ownership). */
  gitError?: string;
  branch: string;
  upstream: string | undefined;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  untracked: number;
  conflicts: number;
  stashes: number;
  commit: { subject: string; secondsAgo: number };
  remote: string | undefined;
  worktrees: WorktreeSpec[];
  /** Language name → bytes. */
  languages: Record<string, number>;
  logo?: string;
  /** Last fetch, ms ago. null = never fetched; undefined = a few minutes ago. */
  fetchedMsAgo?: number | null;
  /** Pull / push fail with this message (simulates a diverged branch or a rejected push). */
  remoteError?: string;
  /** Every fetch (background or user) fails with this message. */
  fetchError?: string;
}

const H = 3600;
const D = 86400;

function repo(name: string, extra: Partial<RepoSpec> = {}): RepoSpec {
  return {
    path: codePath(name),
    availability: 'ok',
    branch: 'main',
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    staged: 0,
    modified: 0,
    untracked: 0,
    conflicts: 0,
    stashes: 0,
    commit: { subject: 'Update dependencies', secondsAgo: 2 * D },
    remote: `git@github.com:acme/${name}.git`,
    worktrees: [],
    languages: {},
    ...extra,
  };
}

const langs = (...pairs: Array<[string, number]>): Record<string, number> => Object.fromEntries(pairs.map(([n, pct]) => [n, Math.round(pct * 1000)]));

function logoSvg(letter: string, color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${color}"/><text x="32" y="43" font-family="Segoe UI,Arial,sans-serif" font-size="32" font-weight="700" text-anchor="middle" fill="#fff">${letter}</text></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

const SPECS: RepoSpec[] = [
  repo('storefront', {
    modified: 3,
    untracked: 1,
    commit: { subject: 'Cache product pages at the edge', secondsAgo: 1 * H },
    worktrees: [
      { path: 'C:/Users/dev/code/worktrees/storefront/agent-fix-checkout-total', branch: 'agent/fix-checkout-total', changes: 6 },
      { path: 'C:/Users/dev/code/worktrees/storefront/agent-a11y-audit', branch: 'agent/a11y-audit', changes: 0 },
      { path: 'C:/Users/dev/code/worktrees/storefront/review-pr-412', branch: 'review/pr-412', changes: 0, prunable: true },
    ],
    languages: langs(['TypeScript', 78.4], ['CSS', 14.1], ['HTML', 7.5]),
    logo: logoSvg('S', '#539bf5'),
  }),
  repo('design-system', {
    ahead: 2,
    commit: { subject: 'Add Toast and Popover components', secondsAgo: 4 * H },
    languages: langs(['TypeScript', 61.2], ['SCSS', 32.3], ['HTML', 6.5]),
    logo: logoSvg('D', '#57ab5a'),
  }),
  repo('payments-api', {
    fetchedMsAgo: 3 * D * 1000,
    behind: 4,
    commit: { subject: 'Retry webhooks with exponential backoff', secondsAgo: 1 * D },
    remote: 'git@ssh.dev.azure.com:v3/acme/commerce/payments-api',
    languages: langs(['C#', 88.6], ['Bicep', 11.4]),
  }),
  repo('checkout-web', {
    branch: 'feature/apple-pay',
    upstream: 'origin/feature/apple-pay',
    staged: 2,
    modified: 5,
    ahead: 1,
    behind: 2,
    stashes: 1,
    commit: { subject: 'WIP: Apple Pay sheet', secondsAgo: 2 * D },
    languages: langs(['Vue', 54], ['TypeScript', 39], ['CSS', 7]),
    remoteError: 'fatal: Not possible to fast-forward, aborting.',
  }),
  repo('acme-infra', {
    fetchedMsAgo: 14 * D * 1000,
    fetchError: "fatal: Authentication failed for 'https://dev.azure.com/acme/_git/acme-infra'",
    commit: { subject: 'Scale staging down at night', secondsAgo: 5 * D },
    languages: langs(['HCL', 64], ['Bicep', 30], ['Shell', 6]),
  }),
  repo('tiny-router', {
    conflicts: 2,
    modified: 1,
    commit: { subject: 'Merge branch main into v3', secondsAgo: 3 * D },
    languages: langs(['TypeScript', 100]),
  }),
  repo('nightfall-theme', {
    fetchedMsAgo: null,
    commit: { subject: 'Softer selection background', secondsAgo: 20 * D },
    languages: langs(['JavaScript', 100]),
  }),
  repo('md-lint-action', {
    upstream: undefined,
    remote: undefined,
    commit: { subject: 'Initial commit', secondsAgo: 12 * H },
    languages: langs(['TypeScript', 92], ['Shell', 8]),
  }),
  repo('rust-raytracer', {
    untracked: 6,
    modified: 2,
    commit: { subject: 'Soft shadows, finally', secondsAgo: 6 * H },
    languages: langs(['Rust', 100]),
  }),
  repo('habit-tracker-ios', {
    behind: 1,
    commit: { subject: 'Lock-screen widget', secondsAgo: 9 * D },
    languages: langs(['Swift', 100]),
  }),
  repo('blog', {
    commit: { subject: 'Post: what I learned shipping a desktop app', secondsAgo: 2 * D },
    languages: langs(['Astro', 58], ['TypeScript', 24], ['CSS', 18]),
    logo: logoSvg('B', '#986ee2'),
  }),
  repo('dotfiles', { noGit: true, languages: langs(['Shell', 100]) }),
  repo('photo-archive', {
    path: `E:${BS}backup${BS}photo-archive`,
    availability: 'offline',
    commit: { subject: 'Deduplicate by hash', secondsAgo: 70 * D },
    languages: langs(['Python', 100]),
  }),
  repo('legacy-cms', { availability: 'missing' }),
  repo('android-companion', {
    commit: { subject: 'Archive', secondsAgo: 300 * D },
    languages: langs(['Kotlin', 100]),
  }),
  repo('vendor-sdk', {
    path: `D:${BS}shared${BS}vendor-sdk`,
    gitError: "fatal: detected dubious ownership in repository at 'D:/shared/vendor-sdk'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory D:/shared/vendor-sdk",
    languages: langs(['C', 70], ['C++', 30]),
  }),
  // Found by "Scan", not on the board yet.
  repo('new-experiment', { untracked: 2, commit: { subject: 'Scaffold', secondsAgo: 30 * 60 }, languages: langs(['Go', 100]) }),
  repo('cli-playground', { commit: { subject: 'Add completions', secondsAgo: 11 * D }, languages: langs(['Go', 82], ['Shell', 18]) }),
];

const specs = new Map<string, RepoSpec>(SPECS.map((s) => [key(s.path), s]));

/** `folder` may be a worktree path (forward slashes); worktrees are not specs of their own. */
const specOf = (folder: string): RepoSpec | undefined => specs.get(key(folder));

const delay = (min = 15, spread = 70) => new Promise<void>((r) => setTimeout(r, min + Math.random() * spread));

const ok = (stdout = ''): GitRun => ({ ok: true, stdout, stderr: '', missingGit: false });
const fail = (stderr: string): GitRun => ({ ok: false, stdout: '', stderr, missingGit: false });

function fakeHash(seed: string, n = 40): string {
  let h = 2166136261;
  let out = '';
  for (let i = 0; out.length < n; i++) {
    h = Math.imul(h ^ (seed.charCodeAt(i % seed.length) + i), 16777619) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, n);
}

function porcelain(s: RepoSpec, withBranch: boolean): string {
  const lines: string[] = [];
  if (withBranch) {
    lines.push(`# branch.oid ${fakeHash(s.path)}`, `# branch.head ${s.branch}`);
    if (s.upstream) lines.push(`# branch.upstream ${s.upstream}`, `# branch.ab +${s.ahead} -${s.behind}`);
  }
  const tail = (i: number) => `N... 100644 100644 100644 ${fakeHash('a' + i, 40)} ${fakeHash('b' + i, 40)} src/file${i}.ts`;
  for (let i = 0; i < s.staged; i++) lines.push(`1 M. ${tail(i)}`);
  for (let i = 0; i < s.modified; i++) lines.push(`1 .M ${tail(100 + i)}`);
  for (let i = 0; i < s.conflicts; i++) lines.push(`u UU N... 100644 100644 100644 100644 ${fakeHash('c' + i, 40)} ${fakeHash('d' + i, 40)} ${fakeHash('e' + i, 40)} src/conflict${i}.ts`);
  for (let i = 0; i < s.untracked; i++) lines.push(`? notes-${i}.md`);
  return lines.join('\n') + (lines.length ? '\n' : '');
}

function worktreeList(s: RepoSpec): string {
  const blocks = [`worktree ${s.path.replace(/\\/g, '/')}\nHEAD ${fakeHash(s.path)}\nbranch refs/heads/${s.branch}\n`];
  for (const w of s.worktrees) {
    let block = `worktree ${w.path}\nHEAD ${fakeHash(w.path)}\nbranch refs/heads/${w.branch}\n`;
    if (w.locked) block += 'locked\n';
    if (w.prunable) block += 'prunable gitdir file points to non-existent location\n';
    blocks.push(block);
  }
  return blocks.join('\n');
}

function gitStatusRaw(folder: string): GitStatusRaw {
  const s = specOf(folder);
  const none = fail('fatal: not a git repository (or any of the parent directories): .git');
  if (!s || s.noGit || s.availability !== 'ok') return { status: none, log: none, stash: none, remotes: none };
  if (s.gitError) {
    const err = fail(s.gitError);
    return { status: err, log: err, stash: err, remotes: err };
  }
  const c = s.commit;
  const unit = String.fromCharCode(0x1f);
  const when = Math.round(Date.now() / 1000 - c.secondsAgo);
  return {
    status: ok(porcelain(s, true)),
    log: ok(`${fakeHash(c.subject, 7)}${unit}${c.subject}${unit}You${unit}${when}\n`),
    stash: ok(`${s.stashes}\n`),
    remotes: ok(s.remote ? `origin\t${s.remote} (fetch)\norigin\t${s.remote} (push)\n` : ''),
  };
}

/** autoScan off: the two undiscovered sample repos only appear when the user presses Scan. */
const DEFAULT_SEED_SETTINGS = { scanRoots: [CODE], autoScan: false, editor: 'code' };

function seedCatalog(): string {
  const now = Date.now();
  const project = (id: string, name: string, extra: Record<string, unknown> = {}) => {
    const spec = [...specs.values()].find((s) => s.path.toLowerCase().endsWith(BS + name.toLowerCase()));
    return { id, name, path: spec?.path ?? codePath(name), tags: [], source: 'discovered', addedAt: now - 60 * D * 1000, ...extra };
  };
  const ago = (seconds: number) => now - seconds * 1000;
  const catalog = {
    version: 1,
    collections: [
      { id: 'acme', name: 'Acme Commerce', color: '#539bf5' },
      { id: 'oss', name: 'Open source', color: '#57ab5a' },
      { id: 'side', name: 'Side projects', color: '#986ee2' },
      { id: 'arch', name: 'Archive', color: '#768390', collapsed: true },
    ],
    projects: [
      project('storefront', 'storefront', { pinned: true, icon: '🛍️', description: 'Customer-facing web shop, Next.js on the edge', tags: ['acme', 'web'], collectionId: 'acme', lastOpenedAt: ago(1 * H), source: 'manual' }),
      project('design', 'design-system', { pinned: true, icon: '🎨', description: 'Tokens, components and docs shared by every app', tags: ['web', 'oss'], collectionId: 'oss', lastOpenedAt: ago(4 * H) }),
      project('payments', 'payments-api', { description: 'Payment orchestration service, .NET 10', tags: ['acme', 'dotnet'], collectionId: 'acme', lastOpenedAt: ago(1 * D) }),
      project('checkout', 'checkout-web', { description: 'One-page checkout with Apple Pay and Klarna', tags: ['acme', 'web'], collectionId: 'acme', lastOpenedAt: ago(2 * D) }),
      project('infra', 'acme-infra', { icon: '☁️', description: 'Terraform and Bicep for every environment', tags: ['acme', 'infra'], collectionId: 'acme', lastOpenedAt: ago(5 * D) }),
      project('router', 'tiny-router', { description: 'A 2 kB client-side router', tags: ['oss'], collectionId: 'oss', lastOpenedAt: ago(3 * D) }),
      project('theme', 'nightfall-theme', { icon: '🌙', description: 'A calm dark editor theme', tags: ['oss', 'theme'], collectionId: 'oss', lastOpenedAt: ago(20 * D) }),
      project('lint', 'md-lint-action', { description: 'GitHub Action that lints Markdown in pull requests', tags: ['oss'], collectionId: 'oss' }),
      project('ray', 'rust-raytracer', { icon: '🦀', description: 'Weekend ray tracer, slowly becoming a month-long one', tags: ['fun'], collectionId: 'side', lastOpenedAt: ago(6 * H) }),
      project('habit', 'habit-tracker-ios', { description: 'SwiftUI habit tracker with widgets', tags: ['mobile', 'fun'], collectionId: 'side', lastOpenedAt: ago(9 * D) }),
      project('blog', 'blog', { icon: '✍️', description: 'Personal site and blog, built with Astro', tags: ['web'], lastOpenedAt: ago(2 * D) }),
      project('dotfiles', 'dotfiles', { description: 'Shell, git and editor config', lastOpenedAt: ago(30 * D) }),
      project('photos', 'photo-archive', { description: 'Scripts for the NAS photo library', lastOpenedAt: ago(70 * D) }),
      project('legacy', 'legacy-cms', { description: 'Replaced by storefront', lastOpenedAt: ago(200 * D) }),
      project('kotlin', 'android-companion', { collectionId: 'arch', tags: ['mobile'] }),
      project('vendor', 'vendor-sdk', { description: 'Cloned by another Windows user', tags: ['vendor'], source: 'manual' }),
    ],
    ignoredPaths: [],
  };
  return JSON.stringify(catalog, null, 2) + '\n';
}

const DATA_PATHS: Record<DataFile, string> = {
  catalog: `${HOME}${BS}AppData${BS}Roaming${BS}repoboard${BS}catalog.json`,
  settings: `${HOME}${BS}AppData${BS}Roaming${BS}repoboard${BS}app${BS}settings.json`,
  'meta-cache': `${HOME}${BS}AppData${BS}Roaming${BS}repoboard${BS}app${BS}meta-cache.json`,
};

/** localStorage, with an in-memory fallback (private windows, blocked storage). */
const memory = new Map<string, string>();
function storageGet(name: string): string | null {
  try {
    return localStorage.getItem(`repoboard:${name}`);
  } catch {
    return memory.get(name) ?? null;
  }
}
function storageSet(name: string, text: string): void {
  try {
    localStorage.setItem(`repoboard:${name}`, text);
  } catch {
    memory.set(name, text);
  }
}

const listeners = new Map<string, Set<(payload: never) => void>>();
function emit(event: string, payload: unknown = null): void {
  for (const l of listeners.get(event) ?? []) (l as (p: unknown) => void)(payload);
}

/** Dev helper: `__repoboardMock.emit('global-switcher')`, `.emit('tray-action', 'settings')` in the browser console. */
(globalThis as { __repoboardMock?: unknown }).__repoboardMock = { emit, reset: () => ['catalog', 'settings', 'meta-cache'].forEach((n) => { try { localStorage.removeItem(`repoboard:${n}`); } catch { /* ignore */ } memory.delete(n); }) };

const info = (what: string, ...args: unknown[]) => console.info(`[mock host] ${what}`, ...args);

export const mockHost: HostApi = {
  async platformInfo(): Promise<PlatformInfo> {
    await delay();
    return {
      platform: 'win32',
      home: HOME,
      sharedDir: `${HOME}${BS}AppData${BS}Roaming${BS}repoboard`,
      appDir: `${HOME}${BS}AppData${BS}Roaming${BS}repoboard${BS}app`,
      version: '0.1.0-dev',
    };
  },

  async gitStatus(folder) {
    await delay(40, 160);
    return gitStatusRaw(folder);
  },
  async gitWorktreeList(folder) {
    await delay();
    const s = specOf(folder);
    return s && !s.noGit ? ok(worktreeList(s)) : fail('fatal: not a git repository');
  },
  async gitShortStatus(folder) {
    await delay();
    const wt = SPECS.flatMap((s) => s.worktrees).find((w) => key(w.path) === key(folder));
    if (!wt) return fail('fatal: not a git repository');
    return ok(Array.from({ length: wt.changes }, (_, i) => `? scratch-${i}.txt`).join('\n') + (wt.changes ? '\n' : ''));
  },
  async gitFetchBackground(folder) {
    await delay(300, 700);
    const s = specOf(folder);
    if (!s || s.noGit || s.gitError) return fail('fatal: not a git repository');
    if (s.fetchError) return fail(s.fetchError);
    return ok();
  },
  async gitRemote(folder: string, op: RemoteOp) {
    await delay(500, 900);
    const s = specOf(folder);
    if (!s || s.noGit || s.availability !== 'ok') return fail(`${folder} is not a git repository`);
    if (op === 'fetch') return s.fetchError ? fail(s.fetchError) : ok();
    if (s.remoteError && (op === 'pull' || op === 'push')) return fail(s.remoteError);
    if (op === 'pull') s.behind = 0;
    else s.ahead = 0;
    return ok();
  },

  async pathKind(path): Promise<PathKind> {
    await delay(2, 10);
    const m = /^(.*)[\\/]\.git$/.exec(path);
    if (!m) return 'none';
    const s = specOf(m[1]!);
    return s && !s.noGit && s.availability === 'ok' ? 'dir' : 'none';
  },
  async gitDotFile() {
    await delay(2, 10);
    return null;
  },
  async hasLinkedWorktrees(folder) {
    await delay(2, 10);
    return (specOf(folder)?.worktrees.length ?? 0) > 0;
  },
  async gitLastFetch(folder) {
    await delay(2, 10);
    const s = specOf(folder);
    if (!s || s.noGit || !s.upstream || s.fetchedMsAgo === null) return null;
    return Date.now() - (s.fetchedMsAgo ?? (5 + (s.path.length % 50)) * 60_000);
  },
  async availability(path): Promise<Availability> {
    await delay(2, 20);
    return specOf(path)?.availability ?? 'ok';
  },
  async discoverRepos(roots, _maxDepth, _ignoreDirs) {
    await delay(500, 900);
    const rootKeys = roots.map(key);
    return SPECS.filter((s) => !s.noGit && s.availability === 'ok' && rootKeys.some((r) => key(s.path) === r || key(s.path).startsWith(r + BS))).map((s) => s.path).sort();
  },
  async scanLanguages(folder) {
    await delay(30, 200);
    return { ...(specOf(folder)?.languages ?? {}) };
  },
  async findLogo(folder) {
    await delay(5, 30);
    return specOf(folder)?.logo ?? null;
  },

  async readData(name) {
    await delay(2, 15);
    const stored = storageGet(name);
    if (stored !== null) return stored;
    if (name === 'catalog') {
      const seeded = seedCatalog();
      storageSet(name, seeded);
      return seeded;
    }
    if (name === 'settings') return JSON.stringify(DEFAULT_SEED_SETTINGS);
    return null;
  },
  async writeData(name, text) {
    await delay(2, 15);
    storageSet(name, text);
  },
  async backupData(name) {
    info('backupData', name);
    return null;
  },
  async dataFilePath(name) {
    return DATA_PATHS[name];
  },
  async watchCatalog() {
    // Nothing else writes the catalog in a browser.
  },

  async listLaunchers(): Promise<Launchers> {
    await delay();
    return {
      editors: [
        { id: 'code', name: 'Visual Studio Code', available: true },
        { id: 'code-insiders', name: 'VS Code Insiders', available: false },
        { id: 'cursor', name: 'Cursor', available: true },
        { id: 'windsurf', name: 'Windsurf', available: false },
        { id: 'codium', name: 'VSCodium', available: false },
        { id: 'custom', name: 'Custom command', available: true },
      ],
      terminals: [
        { id: 'windows-terminal', name: 'Windows Terminal', available: true },
        { id: 'powershell', name: 'PowerShell', available: true },
        { id: 'cmd', name: 'Command Prompt', available: true },
        { id: 'custom', name: 'Custom command', available: true },
      ],
    };
  },
  async openInEditor(path, editor, customCommand, newWindow) {
    info('openInEditor', { path, editor, customCommand, newWindow });
  },
  async openTerminal(dir, terminal, customCommand) {
    info('openTerminal', { dir, terminal, customCommand });
  },
  async reveal(path) {
    info('reveal', path);
  },
  async openUrl(url) {
    info('openUrl', url);
  },
  async openDataFile(name) {
    info('openDataFile', name);
  },
  async setGlobalShortcut(accelerator) {
    info('setGlobalShortcut', accelerator);
  },
  async setCloseToTray(enabled) {
    info('setCloseToTray', enabled);
  },

  async pickFolders({ multiple, title }) {
    info('pickFolders', { multiple, title });
    return multiple ? [CODE] : [codePath('new-experiment')];
  },
  async copyText(text) {
    info('copyText', text);
    try {
      await navigator.clipboard?.writeText(text);
    } catch {
      // Clipboard may be blocked outside a user gesture.
    }
  },
  async on<T>(event: string, handler: (payload: T) => void) {
    let set = listeners.get(event);
    if (!set) listeners.set(event, (set = new Set()));
    set.add(handler as (payload: never) => void);
    return () => {
      set.delete(handler as (payload: never) => void);
    };
  },

  /** Returns a fake 9.9.9 update only when `localStorage['repoboard.mockUpdate'] === '1'`. */
  async checkUpdate(): Promise<UpdateInfo | null> {
    let enabled = false;
    try {
      enabled = localStorage.getItem('repoboard.mockUpdate') === '1';
    } catch {
      // Storage blocked: no update.
    }
    info('checkUpdate', enabled);
    return enabled ? { version: '9.9.9', currentVersion: '0.0.0-mock', notes: 'Fictional release for trying the update flow.', date: '2030-01-01T00:00:00Z' } : null;
  },
  async installUpdate(onProgress) {
    const total = 5_000_000;
    for (let done = 0; done <= total; done += 500_000) {
      onProgress(done, total);
      await new Promise((r) => setTimeout(r, 150));
    }
    info('installUpdate', 'simulated; the mock does not restart');
  },
};
