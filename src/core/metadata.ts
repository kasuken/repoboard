import type { Availability, GitStatus, LanguageShare, ProjectMeta } from '../domain/model';
import { LANGUAGE_EXTENSIONS, languageByName, toShares, type LanguageDef } from '../domain/languages';
import { folderOf, pathKey } from '../domain/paths';
import type { HostApi } from '../host/api';
import { Emitter } from './emitter';
import { GitClient } from './git';

/** Runs at most `size` async jobs at once. */
export class Limiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly size: number) {}

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.active >= this.size) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    try {
      return await job();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

export interface ScanOptions {
  ignoreDirs: Iterable<string>;
  maxFiles: number;
}

export interface MetadataOptions {
  cacheMs: () => number;
  detectLanguages: () => boolean;
  scanOptions: () => ScanOptions;
}

export interface RefreshOptions {
  /** Ignore the cache TTL. */
  force?: boolean;
  /** Also `git fetch` repos with an upstream (network) before counting ahead/behind. */
  fetch?: boolean;
}

const LANGUAGE_TTL_MS = 24 * 3_600_000;
const FETCH_MIN_INTERVAL_MS = 10 * 60_000;
const PERSIST_DEBOUNCE_MS = 1500;

type MetadataEvents = {
  /** key = pathKey(project.path) */
  update: [key: string, meta: ProjectMeta];
  busy: [key: string, busy: boolean];
};

/**
 * Derived per-project state (git, languages, logo), cached in the host's `meta-cache` file so the dashboard
 * renders instantly from the last known state while fresh data streams in.
 */
export class MetadataService extends Emitter<MetadataEvents> {
  private cache: Record<string, ProjectMeta> = {};
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly busy = new Set<string>();
  private readonly local = new Limiter(6);
  private readonly network = new Limiter(4);
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly git: GitClient, private readonly host: HostApi, private readonly options: MetadataOptions) {
    super();
  }

  async loadCache(): Promise<void> {
    try {
      const text = await this.host.readData('meta-cache');
      const parsed = text ? JSON.parse(text) : undefined;
      this.cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      this.cache = {};
    }
  }

  get(projectPath: string): ProjectMeta | undefined {
    return this.cache[pathKey(projectPath)];
  }

  isBusy(projectPath: string): boolean {
    return this.busy.has(pathKey(projectPath));
  }

  /** Refreshes many projects; resolves when all are done. Updates stream out as `update` events. */
  async refresh(paths: readonly string[], options: RefreshOptions = {}): Promise<void> {
    await Promise.all(paths.map((p) => this.refreshOne(p, options)));
  }

  refreshOne(projectPath: string, options: RefreshOptions = {}): Promise<void> {
    const key = pathKey(projectPath);
    const running = this.inFlight.get(key);
    if (running) {
      return running;
    }
    const job = this.doRefresh(projectPath, key, options).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, job);
    return job;
  }

  private async doRefresh(projectPath: string, key: string, options: RefreshOptions): Promise<void> {
    const previous = this.cache[key];
    const now = Date.now();
    const localFresh = previous && now - previous.updatedAt < this.options.cacheMs();
    const wantsFetch =
      options.fetch === true &&
      !!previous?.git?.upstream &&
      (options.force || now - (previous.git.fetchedAt ?? 0) > FETCH_MIN_INTERVAL_MS);

    if (localFresh && !options.force && !wantsFetch) {
      return;
    }
    this.setBusy(key, true);
    try {
      let meta = await this.local.run(() => this.readLocal(projectPath, previous));
      this.store(key, meta);

      if (options.fetch && meta.availability === 'ok' && meta.git?.upstream && (wantsFetch || !previous)) {
        const fetched = await this.network.run(() => this.git.fetch(folderOf(projectPath)));
        if (fetched) {
          const git = await this.local.run(() => this.git.status(folderOf(projectPath)));
          meta = { ...meta, git: git ? withFetchedAt(git, Date.now()) : null };
          this.store(key, meta);
        }
      }
    } catch {
      // A failing host call must not leave the tile busy forever or reject the whole refresh.
    } finally {
      this.setBusy(key, false);
    }
  }

  private async readLocal(projectPath: string, previous: ProjectMeta | undefined): Promise<ProjectMeta> {
    const availability = await this.availabilityOf(projectPath);
    const now = Date.now();
    if (availability !== 'ok') {
      // Keep the last known details so an unplugged drive still shows something useful.
      return {
        availability,
        git: previous?.git ?? null,
        languages: previous?.languages ?? [],
        ...(previous?.logo ? { logo: previous.logo } : {}),
        updatedAt: now,
        languagesAt: previous?.languagesAt ?? 0,
      };
    }
    const folder = folderOf(projectPath);

    const scanLangs = this.options.detectLanguages() && (!previous || now - previous.languagesAt > LANGUAGE_TTL_MS);
    const [git, languages, logo] = await Promise.all([
      this.git.status(folder),
      scanLangs ? this.scanLanguages(folder) : Promise.resolve(previous?.languages ?? []),
      this.host.findLogo(folder).catch(() => null),
    ]);
    if (git && previous?.git?.fetchedAt) {
      git.fetchedAt = previous.git.fetchedAt;
      if (git.upstream) git.lastFetchAt = Math.max(git.lastFetchAt ?? 0, git.fetchedAt);
    }
    const meta: ProjectMeta = {
      availability,
      git,
      languages: this.options.detectLanguages() ? languages : [],
      updatedAt: now,
      languagesAt: scanLangs ? now : previous?.languagesAt ?? 0,
    };
    if (logo) {
      meta.logo = logo;
    }
    return meta;
  }

  /** Bytes per language from Rust → GitHub-style shares. */
  private async scanLanguages(folder: string): Promise<LanguageShare[]> {
    const { ignoreDirs, maxFiles } = this.options.scanOptions();
    try {
      const raw = await this.host.scanLanguages(folder, LANGUAGE_EXTENSIONS, [...ignoreDirs], maxFiles);
      const bytes = new Map<LanguageDef, number>();
      for (const [name, n] of Object.entries(raw)) {
        const lang = languageByName(name);
        if (lang) bytes.set(lang, (bytes.get(lang) ?? 0) + n);
      }
      return toShares(bytes);
    } catch {
      return [];
    }
  }

  private async availabilityOf(projectPath: string): Promise<Availability> {
    try {
      return await this.host.availability(projectPath);
    } catch {
      return 'offline';
    }
  }

  private store(key: string, meta: ProjectMeta): void {
    this.cache[key] = meta;
    this.emit('update', key, meta);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.persist(), PERSIST_DEBOUNCE_MS);
  }

  private setBusy(key: string, busy: boolean): void {
    if (busy) {
      this.busy.add(key);
    } else {
      this.busy.delete(key);
    }
    this.emit('busy', key, busy);
  }

  /** Drops cache entries for projects that no longer exist in the catalog. */
  prune(keepPaths: readonly string[]): void {
    const keep = new Set(keepPaths.map((p) => pathKey(p)));
    for (const key of Object.keys(this.cache)) {
      if (!keep.has(key)) {
        delete this.cache[key];
      }
    }
  }

  async persist(): Promise<void> {
    clearTimeout(this.saveTimer);
    try {
      await this.host.writeData('meta-cache', JSON.stringify(this.cache));
    } catch {
      // The cache is disposable.
    }
  }
}

/** Records our own fetch; it counts as "last fetched" even when git did not write FETCH_HEAD. */
export function withFetchedAt(git: GitStatus, at: number): GitStatus {
  return { ...git, fetchedAt: at, ...(git.upstream ? { lastFetchAt: Math.max(git.lastFetchAt ?? 0, at) } : {}) };
}
