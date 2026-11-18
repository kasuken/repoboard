import type { HostApi, UpdateInfo } from '../host/api';
import { log } from './log';
import * as notify from './notify';

/** Wait after the UI is ready before the automatic check, so it never competes with the first board render. */
export const UPDATE_CHECK_DELAY_MS = 10_000;
/** The automatic check runs at most this often. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60_000;

export const releaseUrl = (version: string) => `https://github.com/kasuken/repoboard/releases/tag/v${version}`;

/** True when the automatic check is on and the last completed check is older than 24 h (or never happened). */
export function updateCheckDue(settings: { checkForUpdates: boolean; lastUpdateCheck: number }, now: number): boolean {
  return settings.checkForUpdates && !(now - settings.lastUpdateCheck < UPDATE_CHECK_INTERVAL_MS);
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e));

/** What the updater needs from the app. */
export interface UpdaterContext {
  host: HostApi;
  /** Persists the time of a completed check. */
  stampCheck(at: number): Promise<void>;
  showLog(): void;
}

/** Update check + install flow. One instance per app; overlapping checks and installs are ignored. */
export class Updater {
  private busy = false;

  constructor(private readonly ctx: UpdaterContext) {}

  /** Silent: errors and "up to date" only go to the log. Returns true when an update was found. */
  async checkSilently(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      const update = await this.ctx.host.checkUpdate();
      await this.ctx.stampCheck(Date.now());
      if (!update) {
        log('[update] up to date');
        this.busy = false;
        return false;
      }
      log(`[update] ${update.version} is available (current ${update.currentVersion})`);
      void this.offer(update);
      return true;
    } catch (e) {
      log(`[update] automatic check failed: ${errorText(e)}`);
      this.busy = false;
      return false;
    }
  }

  /** The "Check for updates…" command: always tells the user what happened. */
  async checkManually(currentVersion: string): Promise<void> {
    if (this.busy) {
      void notify.info('Repo Board is already checking for or installing an update.');
      return;
    }
    this.busy = true;
    let update: UpdateInfo | null;
    try {
      update = await notify.progress('Checking for updates…', false, () => this.ctx.host.checkUpdate());
      await this.ctx.stampCheck(Date.now());
    } catch (e) {
      this.busy = false;
      log(`[update] check failed: ${errorText(e)}`);
      void notify.error(`Could not check for updates: ${errorText(e)}`, 'Show log').then((c) => c && this.ctx.showLog());
      return;
    }
    if (!update) {
      this.busy = false;
      void notify.info(`Repo Board is up to date (version ${currentVersion}).`);
      return;
    }
    void this.offer(update);
  }

  /** Shows the update notification until the user installs or dismisses it; releases the busy flag when done. */
  private async offer(update: UpdateInfo): Promise<void> {
    try {
      for (;;) {
        const choice = await notify.info(
          `Repo Board ${update.version} is available (you have ${update.currentVersion}).`,
          'Install and restart',
          'Release notes',
          'Later',
        );
        if (choice === 'Release notes') {
          await this.ctx.host.openUrl(releaseUrl(update.version)).catch((e) => log(`[update] could not open the release notes: ${errorText(e)}`));
          continue;
        }
        if (choice === 'Install and restart') await this.install(update);
        return;
      }
    } finally {
      this.busy = false;
    }
  }

  private async install(update: UpdateInfo): Promise<void> {
    try {
      await notify.progress(`Downloading Repo Board ${update.version}`, false, async (reporter) => {
        let last = 0;
        await this.ctx.host.installUpdate((downloaded, total) => {
          if (!total || total <= 0) {
            reporter.report({ message: `${(downloaded / 1_048_576).toFixed(1)} MB` });
            return;
          }
          const percent = Math.min(100, Math.round((downloaded / total) * 100));
          if (percent > last) {
            reporter.report({ increment: percent - last, message: `${percent}%` });
            last = percent;
          }
        });
      });
    } catch (e) {
      log(`[update] install of ${update.version} failed: ${errorText(e)}`);
      void notify.error(`Could not install Repo Board ${update.version}: ${errorText(e)}`, 'Show log').then((c) => c && this.ctx.showLog());
    }
  }
}
