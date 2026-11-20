import { fetchDue } from '../domain/freshness';
import type { Project } from '../domain/model';
import { folderOf } from '../domain/paths';
import type { HostApi } from '../host/api';
import { log } from './log';
import type { MetadataService } from './metadata';

/** How often the scheduler wakes up. Each wake-up only fetches the repos that are actually due. */
export const AUTO_FETCH_TICK_MS = 60_000;

export interface AutoFetchDeps {
  host: HostApi;
  meta: MetadataService;
  projects: () => readonly Project[];
  /** Minutes between fetches of each repo; 0 = off. */
  intervalMinutes: () => number;
  /** True while Fetch all / Pull all runs: a cycle must not start then. */
  busy: () => boolean;
  /** Called when the "every attempted fetch failed" condition appears or clears. */
  onOffline: (offline: boolean) => void;
  now?: () => number;
}

export interface CycleResult {
  fetched: number;
  failed: number;
  skipped: number;
  offline: boolean;
}

/**
 * Keeps ahead/behind counts current: every minute it looks for repos whose last fetch (by ANY tool: the timestamp
 * is re-read from disk) is older than the configured interval and fetches them through the metadata service.
 */
export class AutoFetcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private active = false;
  private running = false;
  private offline = false;
  /** When we last tried each repo, so a repo that keeps failing is retried once per interval, not once a minute. */
  private readonly attempts = new Map<string, number>();

  constructor(private readonly deps: AutoFetchDeps) {}

  get isOffline(): boolean {
    return this.offline;
  }

  get timerActive(): boolean {
    return this.timer !== undefined;
  }

  /** Begins scheduling (the first cycle runs one tick from now). */
  start(): void {
    this.active = true;
    this.sync();
  }

  /** Applies the current setting: timer on when started and the interval is > 0, otherwise off (and "offline" forgotten). */
  sync(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (!this.active || this.deps.intervalMinutes() <= 0) {
      this.setOffline(false);
      return;
    }
    this.timer = setInterval(() => void this.runCycle().catch((e) => log(`[auto-fetch] ${e instanceof Error ? e.message : String(e)}`)), AUTO_FETCH_TICK_MS);
    // Never keep a Node process (tests) alive for this timer.
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    this.active = false;
    this.sync();
  }

  /** A fetch the user ran succeeded, so the network works. */
  noteOnline(): void {
    this.setOffline(false);
  }

  private setOffline(offline: boolean): void {
    if (this.offline === offline) return;
    this.offline = offline;
    this.deps.onOffline(offline);
  }

  /**
   * One scheduler pass. Returns undefined when it did not run (off, or another cycle / bulk operation is running).
   * `minAgeMs` overrides the interval setting for one pass (fetch on start-up, the board's refresh button), so those
   * fetches get the same dedupe and the same offline handling even when the scheduled fetch is turned off.
   */
  async runCycle(options: { minAgeMs?: number } = {}): Promise<CycleResult | undefined> {
    const minutes = this.deps.intervalMinutes();
    const scheduled = options.minAgeMs === undefined;
    if ((scheduled && minutes <= 0) || this.running || this.deps.busy()) return undefined;
    this.running = true;
    try {
      const now = (this.deps.now ?? Date.now)();
      const intervalMs = scheduled ? minutes * 60_000 : options.minAgeMs!;
      const { meta, host } = this.deps;
      const candidates = this.deps.projects().filter((p) => {
        const m = meta.get(p.path);
        return m?.availability === 'ok' && !!m.git?.upstream && !m.git.error && !meta.isBusy(p.path);
      });
      let fetched = 0;
      let skipped = 0;
      const failures: Array<{ path: string; message: string }> = [];
      await Promise.all(
        candidates.map(async (p) => {
          // Another window, the VS Code extension or the CLI may have fetched since our last status read.
          const onDisk = await host.gitLastFetch(folderOf(p.path)).catch(() => null);
          const cached = meta.get(p.path)?.git;
          const last = Math.max(onDisk ?? 0, cached?.lastFetchAt ?? 0, cached?.fetchedAt ?? 0, this.attempts.get(p.path) ?? 0);
          // fetchDue treats 0 as "off"; a one-off pass with minAgeMs 0 means "fetch everything now".
          if (!(scheduled ? fetchDue(last, intervalMs, now) : intervalMs <= 0 || fetchDue(last, intervalMs, now))) {
            skipped++;
            // Someone else fetched since we last looked: their fetch may have moved ahead/behind, so re-read the status
            // (local only, no network) and the tile shows the new counts and time.
            if ((onDisk ?? 0) > (cached?.lastFetchAt ?? 0)) await meta.refreshOne(p.path, { force: true });
            return;
          }
          this.attempts.set(p.path, now);
          const r = await meta.fetchInBackground(p.path, { quietFailure: true });
          if (r.outcome === 'ok') fetched++;
          else if (r.outcome === 'skipped' || r.outcome === 'concurrent') skipped++; // concurrent: someone else is fetching it right now
          else failures.push({ path: p.path, message: r.message });
        }),
      );
      const offline = failures.length >= 2 && fetched === 0;
      if (offline) {
        // One condition, not N errors; try again on the next tick.
        for (const f of failures) this.attempts.delete(f.path);
        this.setOffline(true);
      } else {
        for (const f of failures) meta.recordFetch(f.path, { ok: false, message: f.message });
        if (fetched > 0) this.setOffline(false);
      }
      log(`[auto-fetch] fetched ${fetched}, failed ${failures.length}, skipped ${skipped} (fresh)`);
      return { fetched, failed: failures.length, skipped, offline };
    } finally {
      this.running = false;
    }
  }
}
