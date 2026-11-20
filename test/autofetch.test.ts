import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AutoFetcher } from '../src/core/autoFetch';
import { GitClient } from '../src/core/git';
import { MetadataService } from '../src/core/metadata';
import { sanitizeSettings } from '../src/core/settings';
import { fetchDue, fetchFreshness, isFetchStale } from '../src/domain/freshness';
import { cleanFetchError, isConcurrentFetchError } from '../src/domain/gitParse';
import type { GitStatus, Project } from '../src/domain/model';
import { setPlatform } from '../src/domain/pathlib';
import { DEFAULT_SETTINGS } from '../src/ui/protocol';
import { createFakeHost, type FakeRepo } from './support/fakeHost';

setPlatform('linux');

const MIN = 60_000;
const NOW = 1_800_000_000_000;
const git = (extra: Partial<GitStatus> = {}): GitStatus => ({ branch: 'main', detached: false, ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicts: 0, stashes: 0, upstream: 'origin/main', ...extra });

test('cleanFetchError: picks the fatal line, strips credentials, caps the length', () => {
  assert.equal(cleanFetchError(''), '');
  assert.equal(cleanFetchError('remote: Something\nfatal: unable to access\n'), 'fatal: unable to access');
  assert.equal(cleanFetchError('hint: use x\nwarning: y\nfrom somewhere\n'), 'from somewhere');
  assert.equal(
    cleanFetchError("fatal: unable to access 'https://user:s3cret@github.com/a/b.git/': Could not resolve host"),
    "fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host",
  );
  assert.equal(cleanFetchError("fatal: Authentication failed for 'https://token123@dev.azure.com/acme/_git/x'"), "fatal: Authentication failed for 'https://dev.azure.com/acme/_git/x'");
  // A password that itself contains "@".
  const tricky = cleanFetchError('fatal: bad https://me:p@ss@host.example/x.git here');
  assert.ok(!tricky.includes('p@ss') && !tricky.includes('ss@') && !tricky.includes('me:'), tricky);
  assert.equal(tricky, 'fatal: bad https://host.example/x.git here');
  assert.equal(cleanFetchError('ssh://git:pw@host/x'), 'ssh://host/x');
  const long = cleanFetchError(`fatal: ${'x'.repeat(500)}`);
  assert.equal(long.length, 200);
  assert.ok(long.endsWith('…'));
});

test('fetchDue', () => {
  assert.equal(fetchDue(null, 30 * MIN, NOW), true);
  assert.equal(fetchDue(undefined, 30 * MIN, NOW), true);
  assert.equal(fetchDue(NOW - 10 * MIN, 30 * MIN, NOW), false);
  assert.equal(fetchDue(NOW - 30 * MIN, 30 * MIN, NOW), true);
  assert.equal(fetchDue(NOW - 29 * MIN - 59_000, 30 * MIN, NOW), false);
  assert.equal(fetchDue(null, 0, NOW), false);
});

test('fetchFreshness: failed takes precedence and mentions the last fetch', () => {
  const f = fetchFreshness(git({ fetchError: 'fatal: nope', lastFetchAt: NOW - 1000 }), NOW);
  assert.equal(f.kind, 'failed');
  assert.equal(f.label, 'fetch failed');
  assert.match(f.title, /^Fetch failed: fatal: nope\. Ahead\/behind counts are from .+\.$/);
  assert.match(fetchFreshness(git({ fetchError: 'x' }), NOW).title, /from an unknown time\.$/);
  assert.equal(isFetchStale(git({ fetchError: 'x', lastFetchAt: NOW - 1000 }), NOW), true);
  const { upstream: _u, ...local } = git({ fetchError: 'x' });
  assert.equal(fetchFreshness(local as GitStatus, NOW).kind, 'none');
  assert.equal(fetchFreshness(git({ fetchError: 'x', error: 'dubious' }), NOW).kind, 'none');
});

test('fetchInterval is sanitised: integer, 0-1440, default 30', () => {
  assert.equal(DEFAULT_SETTINGS.fetchInterval, 30);
  assert.equal(sanitizeSettings(undefined).fetchInterval, 30);
  assert.equal(sanitizeSettings({ fetchInterval: 0 }).fetchInterval, 0);
  assert.equal(sanitizeSettings({ fetchInterval: -5 }).fetchInterval, 0);
  assert.equal(sanitizeSettings({ fetchInterval: 99999 }).fetchInterval, 1440);
  assert.equal(sanitizeSettings({ fetchInterval: 12.6 }).fetchInterval, 13);
  assert.equal(sanitizeSettings({ fetchInterval: 'x' }).fetchInterval, 30);
});

function setup(repos: Record<string, FakeRepo>, options: { minutes?: number; busy?: () => boolean } = {}) {
  const host = createFakeHost(repos);
  const meta = new MetadataService(new GitClient(host), host, { cacheMs: () => 0, detectLanguages: () => false, scanOptions: () => ({ ignoreDirs: [], maxFiles: 100 }) });
  const projects = Object.keys(repos).map((path, i) => ({ id: `p${i}`, name: path, path }) as unknown as Project);
  const offline: boolean[] = [];
  const fetcher = new AutoFetcher({
    host,
    meta,
    projects: () => projects,
    intervalMinutes: () => options.minutes ?? 30,
    busy: options.busy ?? (() => false),
    onOffline: (o) => offline.push(o),
    now: () => Date.now(),
  });
  return { host, meta, fetcher, projects, offline };
}

test('metadata stores, preserves and clears fetchError', async () => {
  const { host, meta } = setup({ '/r/a': { fetchError: "fatal: Authentication failed for 'https://u:p@h.example/x'" } });
  await meta.refresh(['/r/a'], { force: true });
  assert.equal(meta.get('/r/a')?.git?.fetchError, undefined);

  // A failed fetch through refresh stores the cleaned error.
  await meta.refresh(['/r/a'], { force: true, fetch: true });
  assert.equal(meta.get('/r/a')?.git?.fetchError, "fatal: Authentication failed for 'https://h.example/x'");
  assert.equal(host.calls.background.length, 1);

  // Plain status re-reads keep it.
  await meta.refresh(['/r/a'], { force: true });
  assert.equal(meta.get('/r/a')?.git?.fetchError, "fatal: Authentication failed for 'https://h.example/x'");

  // The user's own successful fetch clears it and stamps fetchedAt.
  meta.recordFetch('/r/a', { ok: true, message: '' });
  assert.equal(meta.get('/r/a')?.git?.fetchError, undefined);
  assert.ok((meta.get('/r/a')?.git?.fetchedAt ?? 0) > 0);
  await meta.refresh(['/r/a'], { force: true });
  assert.equal(meta.get('/r/a')?.git?.fetchError, undefined);

  // The user's failed fetch stores it again; a later background success clears it.
  meta.recordFetch('/r/a', { ok: false, message: 'fatal: nope' });
  assert.equal(meta.get('/r/a')?.git?.fetchError, 'fatal: nope');
  host.repos.get('/r/a')!.fetchError = undefined;
  const r = await meta.fetchInBackground('/r/a');
  assert.equal(r.outcome, 'ok');
  assert.equal(meta.get('/r/a')?.git?.fetchError, undefined);
});

test('wantsFetch uses the newest of lastFetchAt and fetchedAt', async () => {
  const { host, meta } = setup({ '/r/a': { lastFetch: Date.now() - MIN } });
  await meta.refresh(['/r/a'], { force: true });
  await meta.refresh(['/r/a'], { fetch: true });
  assert.equal(host.calls.background.length, 0, 'fetched one minute ago by another tool: no fetch');
});

test('scheduler: skips repos fetched recently (re-read from disk), fetches due ones', async () => {
  const { host, meta, fetcher } = setup({
    '/r/fresh': { lastFetch: Date.now() - 5 * MIN },
    '/r/due': { lastFetch: Date.now() - 2 * 3_600_000 },
    '/r/never': {},
    '/r/local': { upstream: '' },
  });
  await meta.refresh([...host.repos.keys()], { force: true });
  // Another tool fetches /r/due between our status read and the cycle.
  host.repos.get('/r/due')!.lastFetch = Date.now() - MIN;
  const r = await fetcher.runCycle();
  assert.deepEqual(host.calls.background, ['/r/never']);
  assert.equal(r?.fetched, 1);
  assert.equal(r?.failed, 0);
  assert.equal(r?.skipped, 2);
  assert.ok((meta.get('/r/never')?.git?.fetchedAt ?? 0) > 0);

  // The next cycle has nothing to do.
  host.calls.background.length = 0;
  assert.equal((await fetcher.runCycle())?.fetched, 0);
  assert.deepEqual(host.calls.background, []);
});

test('scheduler: a lone failure is stored per repo and retried once per interval', async () => {
  const { host, meta, fetcher, offline } = setup({ '/r/bad': { fetchError: 'fatal: Authentication failed' }, '/r/ok': { lastFetch: Date.now() - 5 * MIN } });
  await meta.refresh([...host.repos.keys()], { force: true });
  const r = await fetcher.runCycle();
  assert.equal(r?.failed, 1);
  assert.equal(r?.offline, false);
  assert.equal(meta.get('/r/bad')?.git?.fetchError, 'fatal: Authentication failed');
  assert.deepEqual(offline, []);
  host.calls.background.length = 0;
  await fetcher.runCycle();
  assert.deepEqual(host.calls.background, [], 'not retried a minute later');
});

test('scheduler: every fetch failing means offline, with no per-repo errors; a success clears it', async () => {
  const msg = 'fatal: unable to access: Could not resolve host';
  const { host, meta, fetcher, offline } = setup({ '/r/a': { fetchError: msg }, '/r/b': { fetchError: msg }, '/r/c': { fetchError: msg } });
  await meta.refresh([...host.repos.keys()], { force: true });
  const r = await fetcher.runCycle();
  assert.equal(r?.offline, true);
  assert.equal(r?.failed, 3);
  assert.equal(fetcher.isOffline, true);
  assert.deepEqual(offline, [true]);
  for (const p of ['/r/a', '/r/b', '/r/c']) assert.equal(meta.get(p)?.git?.fetchError, undefined);

  // Offline repos are retried on the next cycle; once the network is back the flag clears.
  for (const repo of host.repos.values()) repo.fetchError = undefined;
  const again = await fetcher.runCycle();
  assert.equal(again?.fetched, 3);
  assert.equal(fetcher.isOffline, false);
  assert.deepEqual(offline, [true, false]);
});

test('scheduler: a mix of success and failure is not offline', async () => {
  const { host, meta, fetcher } = setup({ '/r/a': { fetchError: 'fatal: x' }, '/r/b': { fetchError: 'fatal: y' }, '/r/c': {} });
  await meta.refresh([...host.repos.keys()], { force: true });
  const r = await fetcher.runCycle();
  assert.equal(r?.offline, false);
  assert.equal(meta.get('/r/a')?.git?.fetchError, 'fatal: x');
  assert.equal(meta.get('/r/b')?.git?.fetchError, 'fatal: y');
});

test('scheduler: interval 0, a busy bulk operation or an overlapping cycle means no cycle', async () => {
  const off = setup({ '/r/a': {} }, { minutes: 0 });
  await off.meta.refresh(['/r/a'], { force: true });
  assert.equal(await off.fetcher.runCycle(), undefined);
  off.fetcher.start();
  assert.equal(off.fetcher.timerActive, false);
  assert.equal(off.host.calls.background.length, 0);

  let bulk = true;
  const busy = setup({ '/r/a': {} }, { busy: () => bulk });
  await busy.meta.refresh(['/r/a'], { force: true });
  assert.equal(await busy.fetcher.runCycle(), undefined);
  bulk = false;
  const first = busy.fetcher.runCycle();
  assert.equal(await busy.fetcher.runCycle(), undefined, 'a second cycle while the first runs');
  assert.equal((await first)?.fetched, 1);
});

test('scheduler: timer follows the setting; never touches repos that are in flight', async () => {
  let minutes = 30;
  const host = createFakeHost({ '/r/a': {} });
  const meta = new MetadataService(new GitClient(host), host, { cacheMs: () => 0, detectLanguages: () => false, scanOptions: () => ({ ignoreDirs: [], maxFiles: 100 }) });
  const fetcher = new AutoFetcher({ host, meta, projects: () => [{ id: 'a', name: 'a', path: '/r/a' } as unknown as Project], intervalMinutes: () => minutes, busy: () => false, onOffline: () => {} });
  fetcher.start();
  assert.equal(fetcher.timerActive, true);
  minutes = 0;
  fetcher.sync();
  assert.equal(fetcher.timerActive, false);
  minutes = 15;
  fetcher.sync();
  assert.equal(fetcher.timerActive, true);
  fetcher.stop();
  assert.equal(fetcher.timerActive, false);

  await meta.refresh(['/r/a'], { force: true });
  const running = meta.refreshOne('/r/a', { force: true });
  assert.equal((await meta.fetchInBackground('/r/a')).outcome, 'skipped');
  await running;
});

test('scheduler: a one-off pass (start-up / refresh) runs with the schedule off and still treats an outage as offline', async () => {
  const msg = 'fatal: unable to access: Could not resolve host';
  const { host, meta, fetcher, offline } = setup({ '/r/a': { fetchError: msg }, '/r/b': { fetchError: msg } }, { minutes: 0 });
  await meta.refresh([...host.repos.keys()], { force: true });
  assert.equal(await fetcher.runCycle(), undefined, 'the schedule itself is off');
  const r = await fetcher.runCycle({ minAgeMs: 0 });
  assert.equal(r?.failed, 2);
  assert.equal(r?.offline, true);
  assert.deepEqual(offline, [true]);
  for (const p of ['/r/a', '/r/b']) assert.equal(meta.get(p)?.git?.fetchError, undefined);
});

test('scheduler: a repo fetched by another tool is skipped but its status is re-read', async () => {
  const { host, meta, fetcher } = setup({ '/r/a': { lastFetch: Date.now() - 2 * 3_600_000 } });
  await meta.refresh(['/r/a'], { force: true });
  const shownBefore = meta.get('/r/a')?.git?.lastFetchAt;
  host.repos.get('/r/a')!.lastFetch = Date.now() - 1000; // e.g. `git fetch` in a terminal
  const r = await fetcher.runCycle();
  assert.equal(r?.skipped, 1);
  assert.equal(host.calls.background.length, 0);
  assert.ok((meta.get('/r/a')?.git?.lastFetchAt ?? 0) > (shownBefore ?? 0));
});

test('isConcurrentFetchError: lock collisions are recognised, network and credential failures are not', () => {
  assert.equal(isConcurrentFetchError("error: cannot lock ref 'refs/remotes/origin/main': is at 1a2b but expected 3c4d"), true);
  assert.equal(isConcurrentFetchError("fatal: Unable to create '/r/a/.git/refs/remotes/origin/main.lock': File exists.\n\nAnother git process seems to be running"), true);
  assert.equal(isConcurrentFetchError("error: unable to update local ref 'refs/remotes/origin/main'"), true);
  assert.equal(isConcurrentFetchError("FATAL: UNABLE TO CREATE '/r/a/.git/FETCH_HEAD.lock': FILE EXISTS."), true);
  assert.equal(isConcurrentFetchError(''), false);
  assert.equal(isConcurrentFetchError('fatal: unable to access: Could not resolve host'), false);
  assert.equal(isConcurrentFetchError("fatal: Authentication failed for 'https://h.example/x'"), false);
  assert.equal(isConcurrentFetchError("fatal: Unable to create '/r/a/.git/index.lock': Permission denied"), false);
});

test('a fetch that collided with another process is not a failure and not offline', async () => {
  const lock = "error: cannot lock ref 'refs/remotes/origin/main': is at 1a2b but expected 3c4d";
  const { host, meta, fetcher, offline } = setup({ '/r/a': { fetchError: lock }, '/r/b': { fetchError: lock }, '/r/c': { fetchError: lock } });
  await meta.refresh([...host.repos.keys()], { force: true });
  const r = await fetcher.runCycle();
  assert.equal(r?.failed, 0);
  assert.equal(r?.fetched, 0);
  assert.equal(r?.skipped, 3);
  assert.equal(r?.offline, false);
  assert.deepEqual(offline, []);
  for (const p of ['/r/a', '/r/b', '/r/c']) assert.equal(meta.get(p)?.git?.fetchError, undefined);

  // The same through the metadata service's other paths.
  assert.equal((await meta.fetchInBackground('/r/a')).outcome, 'concurrent');
  await meta.refresh(['/r/a'], { force: true, fetch: true });
  meta.recordFetch('/r/a', { ok: false, message: lock });
  assert.equal(meta.get('/r/a')?.git?.fetchError, undefined);
  // A genuine failure afterwards is still recorded.
  meta.recordFetch('/r/a', { ok: false, message: 'fatal: nope' });
  assert.equal(meta.get('/r/a')?.git?.fetchError, 'fatal: nope');
});
