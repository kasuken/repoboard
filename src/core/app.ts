import { dropNestedWorktrees, groupWorktrees, markOpened, mergeDiscovered, removeProject, togglePin } from '../domain/catalog';
import * as C from '../domain/catalog';
import { Project, ProjectMeta, changedFiles } from '../domain/model';
import { currentPlatform, setPlatform, sep } from '../domain/pathlib';
import { displayPath, folderOf, pathKey } from '../domain/paths';
import { EVENTS, type HostApi, type Launchers, type PlatformInfo, type TrayAction } from '../host/api';
import type { AppSettings, BoardState, WebviewMessage, WorktreeAction } from '../ui/protocol';
import { onWebviewMessage, post } from './bridge';
import { AutoFetcher } from './autoFetch';
import { CatalogStore } from './catalogStore';
import { GitClient, RemoteOp, worktreeMainOf } from './git';
import { getLog, log } from './log';
import { FETCH_MIN_INTERVAL_MS, Limiter, MetadataService } from './metadata';
import * as notify from './notify';
import { ProjectService } from './projectService';
import { loadSettings, sanitizeSettings, saveSettings, scanRootsOf } from './settings';
import { UPDATE_CHECK_DELAY_MS, Updater, updateCheckDue } from './updates';

const AUTO_SCAN_INTERVAL_MS = 10 * 60_000;

/**
 * Composition root and shared actions (port of the extension's App + DashboardPanel). The board, the tray and the
 * shortcuts all go through this one object, so behaviour (open, pin, scan, bulk git) is identical everywhere.
 */
export class App {
  readonly git: GitClient;
  readonly projects: ProjectService;
  readonly meta: MetadataService;
  settings: AppSettings = sanitizeSettings(undefined);
  launchers: Launchers = { editors: [], terminals: [] };
  platform: PlatformInfo = { platform: 'linux', home: '', sharedDir: '', appDir: '', version: '' };
  dataFile = '';
  /** Delay between the UI being ready and the automatic update check. Tests shrink it. */
  updateCheckDelayMs = UPDATE_CHECK_DELAY_MS;

  private readonly updater: Updater;
  readonly autoFetch: AutoFetcher;
  /** True while Fetch all / Pull all runs; the scheduled fetch waits. */
  private bulkRunning = false;
  private fetchOffline = false;
  private updateTimer: ReturnType<typeof setTimeout> | undefined;
  private scanning = false;
  private lastAutoScan = 0;
  private started = false;
  private shortcutTried: string | undefined;
  private closeToTrayApplied: boolean | undefined;
  private readonly disposers: Array<() => void> = [];

  constructor(readonly host: HostApi) {
    this.git = new GitClient(host);
    this.projects = new ProjectService(new CatalogStore(host));
    this.updater = new Updater({
      host,
      stampCheck: (at) => this.stampUpdateCheck(at),
      showLog: () => this.showLog(),
    });
    this.meta = new MetadataService(this.git, host, {
      cacheMs: () => this.settings.cacheMinutes * 60_000,
      detectLanguages: () => this.settings.detectLanguages,
      scanOptions: () => ({ ignoreDirs: this.settings.ignoreDirs, maxFiles: this.settings.maxFilesScanned }),
    });
    this.autoFetch = new AutoFetcher({
      host,
      meta: this.meta,
      projects: () => this.projects.projects,
      intervalMinutes: () => this.settings.fetchInterval,
      busy: () => this.bulkRunning,
      onOffline: (offline) => {
        this.fetchOffline = offline;
        if (this.started) this.postState();
      },
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /** Reads platform, settings, launchers and the metadata cache, then wires events. Does not touch the catalog. */
  async init(): Promise<void> {
    // The platform decides how every path is parsed, so it comes before anything else.
    this.platform = await this.host.platformInfo();
    setPlatform(this.platform.platform);
    this.settings = await loadSettings(this.host);
    this.launchers = await this.host.listLaunchers().catch(() => ({ editors: [], terminals: [] }));
    this.dataFile = await this.host.dataFilePath('catalog').catch(() => '');
    await this.meta.loadCache();

    this.projects.on('change', () => this.postState());
    this.meta.on('update', (key, meta) => {
      const project = this.projects.projects.find((p) => pathKey(p.path) === key);
      if (project) post({ type: 'meta', id: project.id, meta });
    });
    this.meta.on('busy', (key, busy) => {
      const project = this.projects.projects.find((p) => pathKey(p.path) === key);
      if (project) post({ type: 'busy', id: project.id, busy });
    });

    await this.subscribeHostEvents();
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      const onFocus = () => this.onFocus();
      window.addEventListener('focus', onFocus);
      this.disposers.push(() => window.removeEventListener('focus', onFocus));
    }
    await this.applyHostSettings();
  }

  private async subscribeHostEvents(): Promise<void> {
    const sub = async <T>(event: string, handler: (payload: T) => void) => {
      try {
        this.disposers.push(await this.host.on<T>(event, handler));
      } catch (e) {
        log(`[host] could not listen to ${event}: ${errorText(e)}`);
      }
    };
    await sub<null>(EVENTS.globalSwitcher, () => post({ type: 'switcher' }));
    await sub<TrayAction>(EVENTS.trayAction, (action) => {
      const run = (p: Promise<unknown>) => void p.catch((e) => notify.toast(errorText(e), 'error'));
      switch (action) {
        case 'switcher':
          post({ type: 'switcher' });
          break;
        case 'settings':
          post({ type: 'openSettings' });
          break;
        case 'fetchAll':
          run(this.bulk('fetch'));
          break;
        case 'pullAll':
          run(this.bulk('pull'));
          break;
        case 'scan':
          run(this.scan({ notify: true }));
          break;
      }
    });
  }

  /** Registers the global shortcut and the close-to-tray behaviour; only calls Rust when the value changed. */
  private async applyHostSettings(): Promise<void> {
    const shortcut = this.settings.globalShortcut;
    if (this.shortcutTried !== shortcut) {
      this.shortcutTried = shortcut;
      try {
        await this.host.setGlobalShortcut(shortcut);
      } catch (e) {
        // Keep the setting: the other app holding it may quit, and the user can pick another one.
        void notify.warn(`Could not register the global shortcut "${shortcut}": ${errorText(e)}`);
      }
    }
    if (this.closeToTrayApplied !== this.settings.closeToTray) {
      this.closeToTrayApplied = this.settings.closeToTray;
      await this.host.setCloseToTray(this.settings.closeToTray).catch((e) => log(`[tray] ${errorText(e)}`));
    }
  }

  private onFocus(): void {
    if (!this.started) return;
    this.refreshVisible(false);
    this.autoScanIfDue();
  }

  dispose(): void {
    clearTimeout(this.updateTimer);
    this.autoFetch.stop();
    void this.meta.persist();
    this.projects.dispose();
    for (const d of this.disposers.splice(0)) d();
  }

  // ── State ──────────────────────────────────────────────────────────────

  get isScanning(): boolean {
    return this.scanning;
  }

  private get roots(): string[] {
    return scanRootsOf(this.settings, this.platform.home);
  }

  private editorName(): string {
    const id = this.settings.editor;
    if (id === 'custom') return 'custom command';
    return this.launchers.editors.find((e) => e.id === id)?.name ?? id;
  }

  state(): BoardState {
    const catalog = this.projects.current;
    const home = this.platform.home;
    const meta: Record<string, ProjectMeta> = {};
    const busy: string[] = [];
    for (const p of catalog.projects) {
      const m = this.meta.get(p.path);
      if (m) meta[p.id] = m;
      if (this.meta.isBusy(p.path)) busy.push(p.id);
    }
    const s = this.settings;
    return {
      projects: catalog.projects.map((p) => ({ ...p, displayPath: displayPath(p.path, home), isCurrent: false })),
      collections: catalog.collections,
      meta,
      busy,
      settings: {
        openInNewWindow: s.openInNewWindow,
        defaultView: s.defaultView,
        defaultSort: s.defaultSort,
        hasScanRoots: s.scanRoots.length > 0,
        isMac: this.platform.platform === 'darwin',
        platform: this.platform.platform,
      },
      appSettings: s,
      launchers: this.launchers,
      editorName: this.editorName(),
      scanning: this.scanning,
      fetchOffline: this.fetchOffline,
      gitAvailable: this.git.available,
      ignoredCount: catalog.ignoredPaths.length,
      dataFile: this.dataFile,
      version: this.platform.version,
    };
  }

  postState(): void {
    post({ type: 'state', state: this.state() });
  }

  /** Refreshes stale local state; with `fetch`, also fetches remotes. */
  private refreshVisible(fetch: boolean): void {
    void this.meta.refresh(this.projects.projects.map((p) => p.path), { fetch });
  }

  // ── Settings ───────────────────────────────────────────────────────────

  async updateSettings(next: AppSettings): Promise<void> {
    // The check time belongs to the core; the dialog's copy may be stale.
    this.settings = sanitizeSettings({ ...next, lastUpdateCheck: this.settings.lastUpdateCheck });
    await saveSettings(this.host, this.settings);
    await this.applyHostSettings();
    this.autoFetch.sync();
    this.postState();
  }

  // ── Opening ────────────────────────────────────────────────────────────

  /** `newWindow` is absolute; leave it undefined to follow the `openInNewWindow` setting. `editor` overrides the configured one. */
  async open(project: Project, newWindow: boolean = this.settings.openInNewWindow, editor?: string): Promise<void> {
    const availability = this.meta.get(project.path)?.availability;
    if (availability === 'offline' || availability === 'missing') {
      const choice = await notify.warn(
        availability === 'offline' ? `The drive holding "${project.name}" is not connected.` : `The folder of "${project.name}" was deleted or moved.`,
        'Open anyway',
        'Remove from board',
      );
      if (choice === 'Remove from board') {
        await this.remove(project);
        return;
      }
      if (choice !== 'Open anyway') {
        return;
      }
    }
    await this.projects.update((c) => markOpened(c, project.id));
    const chosen = editor ?? this.settings.editor;
    await this.host.openInEditor(editorTarget(project.path, chosen), chosen, this.settings.editorCommand, newWindow);
  }

  /**
   * Opens one of a project's linked worktrees. Only paths git reported for that project are accepted,
   * so the UI can never make the host open an arbitrary folder.
   */
  async openWorktree(project: Project, worktreePath: string, action: WorktreeAction): Promise<void> {
    const wt = this.meta.get(project.path)?.git?.worktrees?.find((w) => pathKey(w.path) === pathKey(worktreePath));
    if (!wt) {
      return;
    }
    if (wt.prunable) {
      void notify.info(`The worktree folder ${wt.path} no longer exists. Run "git worktree prune" in ${project.name} to clean it up.`);
      return;
    }
    if (action === 'terminal') {
      await this.host.openTerminal(wt.path, this.settings.terminal, this.settings.terminalCommand);
    } else if (action === 'reveal') {
      await this.host.reveal(wt.path);
    } else {
      const newWindow = action === 'newWindow' ? true : this.settings.openInNewWindow;
      await this.host.openInEditor(wt.path, this.settings.editor, this.settings.editorCommand, newWindow);
    }
  }

  async terminal(project: Project): Promise<void> {
    await this.host.openTerminal(folderOf(project.path), this.settings.terminal, this.settings.terminalCommand);
  }

  async reveal(project: Project): Promise<void> {
    await this.host.reveal(project.path);
  }

  async openRemote(project: Project): Promise<void> {
    const url = this.meta.get(project.path)?.git?.webUrl;
    if (!url) {
      void notify.info(`"${project.name}" has no remote that can be opened in a browser.`);
      return;
    }
    await this.host.openUrl(url);
  }

  async remove(project: Project): Promise<void> {
    await this.projects.update((c) => removeProject(c, project.id));
  }

  async setPinned(project: Project, pinned: boolean): Promise<void> {
    await this.projects.update((c) => togglePin(c, project.id, pinned));
  }

  // ── Adding ─────────────────────────────────────────────────────────────

  async addPath(folder: string): Promise<Project> {
    await this.projects.ensureLoaded();
    const existing = this.projects.byPath(folder);
    if (existing) {
      return existing;
    }
    const project = await this.projects.add({ path: folder });
    void this.meta.refreshOne(project.path, { force: true });
    return project;
  }

  async pickFolder(): Promise<string | undefined> {
    const picked = await this.host.pickFolders({ multiple: false, title: 'Add to Repo Board' });
    return picked[0];
  }

  async addScanRoot(): Promise<void> {
    const picked = await this.host.pickFolders({ multiple: true, title: 'Scan for repos' });
    if (!picked.length) {
      return;
    }
    const keys = new Set(this.roots.map((r) => pathKey(r)));
    const added = picked.filter((p) => {
      const key = pathKey(p);
      if (keys.has(key)) return false;
      keys.add(key);
      return true;
    });
    if (added.length) {
      await this.updateSettings({ ...this.settings, scanRoots: [...this.settings.scanRoots, ...added] });
    }
    await this.scan({ notify: true, picked, alreadyScanned: added.length === 0 });
  }

  // ── Discovery ──────────────────────────────────────────────────────────

  /** Re-scans the scan roots when auto-scan is on and the last scan is older than 10 minutes. */
  autoScanIfDue(): void {
    if (this.settings.autoScan && this.roots.length && Date.now() - this.lastAutoScan > AUTO_SCAN_INTERVAL_MS) {
      void this.scan({ notify: false }).catch((e) => log(`[scan] ${errorText(e)}`));
    }
  }

  /**
   * Scans every scan root. With `notify`, progress is shown while it runs and the result is always
   * reported, including "nothing new" and repos skipped because the user removed them earlier.
   */
  async scan(options: { notify: boolean; picked?: string[]; alreadyScanned?: boolean }): Promise<number> {
    const s = this.settings;
    const roots = this.roots;
    if (!roots.length) {
      if (options.notify) {
        const choice = await notify.info('No scan folders yet. Pick folders that contain your repos (e.g. C:\\code).', 'Add folder to scan');
        if (choice) {
          await this.addScanRoot();
        }
      }
      return 0;
    }
    if (this.scanning) {
      if (options.notify) {
        void notify.info('Repo Board is already scanning. New repos appear on the board as soon as it finishes.');
      }
      return 0;
    }
    this.lastAutoScan = Date.now();
    this.setScanning(true);
    try {
      await this.projects.ensureLoaded();
      const run = () => this.host.discoverRepos(roots, s.scanDepth, s.ignoreDirs);
      const discovered = options.notify ? await notify.progress(`Scanning ${describeRoots(roots)} for git repos…`, false, run) : await run();
      // Linked worktrees belong to their main repo; they only get a tile of their own in `separate` mode.
      const nested = s.worktrees === 'nested';
      const mainOf = nested ? await this.worktreeParents([...discovered, ...this.projects.projects.map((p) => p.path)]) : new Map<string, string>();
      const { repos: found, grouped } = nested ? groupWorktrees(this.projects.current, discovered, mainOf) : { repos: discovered, grouped: [] as string[] };
      let added: Project[] = [];
      let dropped = 0;
      await this.projects.update((c) => {
        const result = mergeDiscovered(c, found);
        added = result.added;
        if (!nested) return result.catalog;
        const cleaned = dropNestedWorktrees(result.catalog, new Map([...mainOf].map(([k, v]) => [pathKey(k), v])));
        dropped = cleaned.dropped;
        return cleaned.catalog;
      });
      if (grouped.length || dropped) {
        log(`[scan] ${grouped.length} worktrees shown under their main repo${dropped ? `; ${dropped} worktree tiles removed` : ''}`);
      }
      const ignored = new Set(this.projects.current.ignoredPaths);
      const skipped = found.filter((p) => ignored.has(pathKey(p))).length;
      log(`[scan] ${found.length} repos under ${roots.join(', ')}; ${added.length} new; ${skipped} skipped (removed earlier)`);
      if (added.length) {
        void this.meta.refresh(added.map((p) => p.path), { fetch: false });
      }
      if (options.notify) {
        // Right after picking folders, report on those folders only, not on every scan root.
        const relevant = options.picked ? found.filter((p) => options.picked!.some((root) => isInside(p, root))) : found;
        const relevantSkipped = relevant.filter((p) => ignored.has(pathKey(p))).length;
        void this.reportScan(relevant.length, added.length, relevantSkipped, options);
      }
      return added.length;
    } finally {
      this.setScanning(false);
    }
  }

  private async reportScan(found: number, added: number, skipped: number, options: { picked?: string[]; alreadyScanned?: boolean }): Promise<void> {
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
    if (found === 0) {
      const choice = await notify.warn(
        `No git repositories found in ${describeRoots(options.picked ?? this.roots)} (searched ${this.settings.scanDepth} folder levels deep).`,
        'Search deeper',
        'Pick another folder',
      );
      if (choice === 'Search deeper') {
        await this.updateSettings({ ...this.settings, scanDepth: Math.min(8, this.settings.scanDepth + 2) });
        await this.scan({ notify: true });
      } else if (choice === 'Pick another folder') {
        await this.addScanRoot();
      }
      return;
    }
    const skippedNote = skipped ? ` ${plural(skipped, 'repo')} you removed earlier stayed off the board.` : '';
    if (added > 0) {
      void notify.info(`Added ${plural(added, 'repo')} to the board (${found} found in total).${skippedNote}`);
      return;
    }
    const prefix = options.alreadyScanned ? 'That folder is already scanned. ' : '';
    const choice = await notify.info(
      `${prefix}All ${plural(found - skipped, 'repo')} found are already on the board.${skippedNote}`,
      ...(skipped ? ['Bring removed repos back'] : []),
    );
    if (choice) {
      await this.resetIgnored();
      await this.scan({ notify: true });
    }
  }

  private setScanning(scanning: boolean): void {
    this.scanning = scanning;
    post({ type: 'scanning', scanning });
  }

  /** Maps each folder that is a linked worktree to its main repo's folder (one small file read each). */
  private async worktreeParents(folders: readonly string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const limiter = new Limiter(16);
    await Promise.all(
      [...new Set(folders)].map((f) =>
        limiter.run(async () => {
          const main = await worktreeMainOf(this.host, f);
          if (main) map.set(f, main);
        }),
      ),
    );
    return map;
  }

  // ── Git ────────────────────────────────────────────────────────────────

  async gitOp(project: Project, op: RemoteOp): Promise<boolean> {
    const result = await notify.progress(`git ${op} · ${project.name}`, false, () => this.git.remote(folderOf(project.path), op));
    // A failed pull is usually not a network failure (not fast-forwardable), so only fetches record an error.
    if (op === 'fetch' || (op === 'pull' && result.ok)) this.noteFetch(project, result);
    if (!result.ok) {
      log(`[${op}] ${project.path}\n${result.message}`);
      void notify.error(`git ${op} failed for "${project.name}": ${firstLine(result.message)}`, 'Show log').then((c) => c && this.showLog());
    }
    await this.meta.refreshOne(project.path, { force: true });
    return result.ok;
  }

  private noteFetch(project: Project, result: { ok: boolean; message: string }): void {
    this.meta.recordFetch(project.path, result);
    if (result.ok) this.autoFetch.noteOnline();
  }

  /**
   * Fetches every repo with an upstream (4 at a time, cancellable), then optionally fast-forwards
   * the ones that are behind and have no conflicts. There is deliberately no "push all".
   */
  async bulk(op: 'fetch' | 'pull'): Promise<void> {
    this.bulkRunning = true;
    try {
      await this.bulkRun(op);
    } finally {
      this.bulkRunning = false;
    }
  }

  private async bulkRun(op: 'fetch' | 'pull'): Promise<void> {
    await this.projects.ensureLoaded();
    // Read local state first for projects never seen, so non-repos and repos without upstream are skipped.
    await this.meta.refresh(this.projects.projects.filter((p) => !this.meta.get(p.path)).map((p) => p.path));
    const candidates = this.projects.projects.filter((p) => {
      const m = this.meta.get(p.path);
      return m?.availability === 'ok' && !!m.git?.upstream;
    });
    if (!candidates.length) {
      void notify.info('No repos with an upstream branch to fetch.');
      return;
    }
    const failures: Array<{ project: Project; message: string }> = [];
    let pulled = 0;
    let skippedDirty = 0;

    await notify.progress(op === 'fetch' ? 'Fetching repos' : 'Updating repos', true, async (progress, token) => {
      const limiter = new Limiter(4);
      let done = 0;
      const step = 100 / candidates.length;
      await Promise.all(
        candidates.map((project) =>
          limiter.run(async () => {
            if (token.isCancellationRequested) {
              return;
            }
            const fetched = await this.git.remote(folderOf(project.path), 'fetch');
            this.noteFetch(project, fetched);
            if (!fetched.ok) {
              failures.push({ project, message: fetched.message });
            }
            await this.meta.refreshOne(project.path, { force: true });
            const git = this.meta.get(project.path)?.git;
            if (op === 'pull' && fetched.ok && git && git.behind > 0 && !token.isCancellationRequested) {
              if (git.conflicts > 0) {
                skippedDirty++;
              } else {
                const res = await this.git.remote(folderOf(project.path), 'pull');
                if (res.ok) {
                  this.noteFetch(project, res);
                  pulled++;
                } else {
                  failures.push({ project, message: res.message });
                }
                await this.meta.refreshOne(project.path, { force: true });
              }
            }
            done++;
            progress.report({ increment: step, message: `${done}/${candidates.length} · ${project.name}` });
          }),
        ),
      );
    });

    for (const f of failures) {
      log(`[${op}] ${f.project.path}\n  ${f.message.replace(/\n/g, '\n  ')}`);
    }
    const behind = this.projects.projects.filter((p) => (this.meta.get(p.path)?.git?.behind ?? 0) > 0).length;
    const dirty = this.projects.projects.filter((p) => changedFiles(this.meta.get(p.path)?.git) > 0).length;
    const summary =
      op === 'fetch'
        ? `Fetched ${candidates.length - failures.length}/${candidates.length} repos. ${behind} behind, ${dirty} with local changes.`
        : `Pulled ${pulled} repo${pulled === 1 ? '' : 's'}.${skippedDirty ? ` ${skippedDirty} skipped (conflicts).` : ''} ${behind} still behind.`;
    if (failures.length) {
      void notify.warn(`${summary} ${failures.length} failed.`, 'Show log').then((c) => c && this.showLog());
    } else {
      void notify.info(summary);
    }
  }

  // ── Updates ────────────────────────────────────────────────────────────

  private async stampUpdateCheck(at: number): Promise<void> {
    this.settings = { ...this.settings, lastUpdateCheck: at };
    await saveSettings(this.host, this.settings).catch((e) => log(`[update] could not save the check time: ${errorText(e)}`));
  }

  /** Schedules the silent startup check (once). */
  private scheduleUpdateCheck(): void {
    if (this.updateTimer) return;
    this.updateTimer = setTimeout(() => void this.autoCheckUpdates(), this.updateCheckDelayMs);
    // Never keep a Node process (tests) alive for this timer.
    (this.updateTimer as { unref?: () => void }).unref?.();
  }

  /** Checks silently when the setting is on and the last check is older than 24 h. */
  async autoCheckUpdates(): Promise<void> {
    if (!updateCheckDue(this.settings, Date.now())) return;
    await this.updater.checkSilently();
  }

  /** "Check for updates…": ignores the setting and the throttle, and always reports. */
  async checkUpdates(): Promise<void> {
    await this.updater.checkManually(this.platform.version);
  }

  // ── Housekeeping commands ──────────────────────────────────────────────

  /** Removes projects whose folder is gone. Projects on disconnected drives ('offline') are kept. */
  async removeMissing(): Promise<void> {
    await this.projects.ensureLoaded();
    await this.meta.refresh(this.projects.projects.map((p) => p.path), { force: true });
    const missing = this.projects.projects.filter((p) => this.meta.get(p.path)?.availability === 'missing');
    if (!missing.length) {
      void notify.info('Every project folder still exists. (Projects on disconnected drives are kept.)');
      return;
    }
    const list = missing.slice(0, 10).map((p) => `• ${p.name} — ${p.path}`);
    if (missing.length > 10) list.push(`• … and ${missing.length - 10} more`);
    const ok = await notify.warn(
      `Remove ${missing.length} project${missing.length === 1 ? '' : 's'} whose folder no longer exists?\n${list.join('\n')}`,
      'Remove',
    );
    if (ok) {
      const ids = new Set(missing.map((p) => p.id));
      await this.projects.update((c) => ({ ...c, projects: c.projects.filter((p) => !ids.has(p.id)) }));
    }
  }

  async resetIgnored(): Promise<void> {
    await this.projects.ensureLoaded();
    const count = this.projects.current.ignoredPaths.length;
    await this.projects.update((c) => ({ ...c, ignoredPaths: [] }));
    void notify.info(`Forgot ${count} removed repo${count === 1 ? '' : 's'}; the next scan may add them again.`);
  }

  /** Makes sure catalog.json exists on disk (the OS cannot open a file that is not there yet). */
  private async ensureDataFile(): Promise<void> {
    await this.projects.ensureLoaded();
    if ((await this.host.readData('catalog')) === null) {
      await this.projects.store.save(this.projects.current);
    }
  }

  async openDataFile(): Promise<void> {
    await this.ensureDataFile();
    await this.host.openDataFile('catalog');
  }

  async revealDataFile(): Promise<void> {
    await this.ensureDataFile();
    await this.host.reveal(this.dataFile || (await this.host.dataFilePath('catalog')));
  }

  showLog(): void {
    post({ type: 'log', lines: getLog() });
  }

  // ── UI messages ────────────────────────────────────────────────────────

  async handle(m: WebviewMessage): Promise<void> {
    const project = 'id' in m && typeof m.id === 'string' ? this.projects.byId(m.id) : undefined;
    switch (m.type) {
      case 'ready':
        await this.projects.ensureLoaded();
        this.started = true;
        this.postState();
        // Local state first; the start-up fetch then goes through the scheduler so that being offline is one note,
        // not a 'fetch failed' on every repo.
        void this.meta
          .refresh(this.projects.projects.map((p) => p.path))
          .then(() => (this.settings.fetchOnOpen ? this.autoFetch.runCycle({ minAgeMs: FETCH_MIN_INTERVAL_MS }) : undefined))
          .catch((e) => log(`[fetch] ${errorText(e)}`));
        this.autoFetch.start();
        this.autoScanIfDue();
        this.scheduleUpdateCheck();
        return;
      case 'open':
        if (project) await this.open(project, m.newWindow);
        return;
      case 'openWith':
        if (project) await this.open(project, this.settings.openInNewWindow, m.editor);
        return;
      case 'terminal':
        if (project) await this.terminal(project);
        return;
      case 'reveal':
        if (project) await this.reveal(project);
        return;
      case 'openRemote':
        if (project) await this.openRemote(project);
        return;
      case 'copyPath':
        if (project) {
          await this.host.copyText(project.path);
          notify.toast('Path copied');
        }
        return;
      case 'pin':
        if (project) await this.setPinned(project, m.pinned);
        return;
      case 'saveProject':
        if (project) {
          await this.projects.update((c) => C.updateProject(c, project.id, { ...m.edit }));
        }
        return;
      case 'removeProject':
        if (project) {
          await this.remove(project);
          notify.toast(`Removed "${project.name}" from the board`);
        }
        return;
      case 'moveProject':
        await this.projects.update((c) => C.moveProject(c, m.id, m.collectionId ?? undefined, m.index));
        return;
      case 'saveCollection':
        await this.projects.update((c) => C.saveCollection(c, { ...(m.id ? { id: m.id } : {}), name: m.name, ...(m.color ? { color: m.color } : {}) }).catalog);
        return;
      case 'removeCollection':
        await this.projects.update((c) => C.removeCollection(c, m.id));
        return;
      case 'moveCollection':
        await this.projects.update((c) => C.moveCollection(c, m.id, m.index));
        return;
      case 'collapse':
        await this.projects.update((c) => C.setCollapsed(c, m.id, m.collapsed));
        return;
      case 'git':
        if (project) {
          const ok = await this.gitOp(project, m.op);
          if (ok) notify.toast(`git ${m.op} · ${project.name} ✓`);
        }
        return;
      case 'refresh':
        if (project) {
          await this.meta.refreshOne(project.path, { force: true, fetch: true });
        } else {
          void this.meta
            .refresh(this.projects.projects.map((p) => p.path), { force: true })
            .then(() => (this.settings.fetchOnOpen ? this.autoFetch.runCycle({ minAgeMs: 0 }) : undefined))
            .catch((e) => log(`[fetch] ${errorText(e)}`));
          void this.scan({ notify: false }).catch((e) => log(`[scan] ${errorText(e)}`));
        }
        return;
      case 'addFolder': {
        const folder = await this.pickFolder();
        if (folder) {
          const added = await this.addPath(folder);
          post({ type: 'edit', id: added.id });
        }
        return;
      }
      case 'scan':
        await this.scan({ notify: true });
        return;
      case 'addScanRoot':
      case 'pickScanRoots':
        await this.addScanRoot();
        return;
      case 'fetchAll':
        await this.bulk('fetch');
        return;
      case 'pullAll':
        await this.bulk('pull');
        return;
      case 'worktree':
        if (project) await this.openWorktree(project, m.path, m.action);
        return;
      case 'saveSettings':
        await this.updateSettings(m.settings);
        return;
      case 'removeMissing':
        await this.removeMissing();
        return;
      case 'resetIgnored':
        await this.resetIgnored();
        return;
      case 'openDataFile':
        await this.openDataFile();
        return;
      case 'revealDataFile':
        await this.revealDataFile();
        return;
      case 'showLog':
        this.showLog();
        return;
      case 'answer':
        notify.handleAnswer(m.id, m.action);
        return;
      case 'cancelTask':
        notify.cancelTask(m.id);
        return;
      case 'checkUpdates':
        await this.checkUpdates();
        return;
      case 'openUrl':
        // Only web links: the UI must never be able to make the host open arbitrary schemes.
        if (/^https?:\/\//i.test(m.url)) await this.host.openUrl(m.url);
        return;
    }
  }
}

/** Creates the core, registers its message handler on the bridge and loads settings. The UI's `ready` starts the rest. */
export async function startCore(host: HostApi): Promise<App> {
  const app = new App(host);
  await app.init();
  onWebviewMessage((message) => {
    // `answer` and `cancelTask` must not wait behind a long-running handler (a dialog awaiting its own answer).
    app.handle(message).catch((e) => {
      log(`[error] ${message.type}: ${errorText(e)}`);
      notify.toast(errorText(e), 'error');
    });
  });
  return app;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e);
}

/** Editors that open a `.code-workspace` file as a workspace. The custom command gets the path as stored too. */
const WORKSPACE_EDITORS = new Set(['code', 'code-insiders', 'cursor', 'windsurf', 'codium', 'custom']);

/** What to hand the editor: workspace files stay files for VS Code-family editors, every other editor gets the folder. */
export function editorTarget(projectPath: string, editor: string): string {
  return WORKSPACE_EDITORS.has(editor) ? projectPath : folderOf(projectPath);
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((l) => l.trim())?.slice(0, 200) ?? text;
}

/** "C:\code" or "3 folders", for progress and result messages. */
function describeRoots(roots: readonly string[]): string {
  return roots.length === 1 ? roots[0]! : `${roots.length} folders`;
}

/** True when `child` is `root` itself or somewhere below it. */
function isInside(child: string, root: string): boolean {
  const c = pathKey(child);
  const r = pathKey(root);
  const s = sep(currentPlatform());
  return c === r || c.startsWith(r.endsWith(s) ? r : r + s);
}

