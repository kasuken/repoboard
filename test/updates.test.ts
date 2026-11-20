import assert from 'node:assert/strict';
import { test } from 'node:test';
import { App } from '../src/core/app';
import { onHostMessage } from '../src/core/bridge';
import { handleAnswer } from '../src/core/notify';
import { sanitizeSettings } from '../src/core/settings';
import { releaseUrl, updateCheckDue } from '../src/core/updates';
import { setPlatform } from '../src/domain/pathlib';
import type { UpdateInfo } from '../src/host/api';
import type { HostMessage } from '../src/ui/protocol';
import { createFakeHost, type FakeHost } from './support/fakeHost';

setPlatform('linux');

const HOUR = 3_600_000;
const settle = () => new Promise<void>((r) => setTimeout(r, 15));
const NEW: UpdateInfo = { version: '1.3.0', currentVersion: '9.9.9', notes: 'Fixes', date: '2030-01-01' };

type Ask = Extract<HostMessage, { type: 'ask' }>;
type Progress = Extract<HostMessage, { type: 'progress' }>;
const asks = (m: HostMessage[]) => m.filter((x): x is Ask => x.type === 'ask');
const toasts = (m: HostMessage[]) => m.filter((x): x is Extract<HostMessage, { type: 'toast' }> => x.type === 'toast');
const tasks = (m: HostMessage[], title: string) => m.filter((x): x is Progress => x.type === 'progress' && x.task.title.startsWith(title));

async function makeApp(settings: Record<string, unknown> = {}, update: UpdateInfo | null = null): Promise<{ app: App; host: FakeHost; messages: HostMessage[]; stop: () => void }> {
  const host = createFakeHost();
  host.update = update;
  host.files.set('settings', JSON.stringify(settings));
  const app = new App(host);
  await app.init();
  const messages: HostMessage[] = [];
  const stop = onHostMessage((m) => messages.push(m));
  return { app, host, messages, stop };
}

test('settings: checkForUpdates defaults to on, is validated, and lastUpdateCheck is a non-negative number', () => {
  assert.equal(sanitizeSettings(undefined).checkForUpdates, true);
  assert.equal(sanitizeSettings({ checkForUpdates: false }).checkForUpdates, false);
  assert.equal(sanitizeSettings({ checkForUpdates: 'no' }).checkForUpdates, true);
  assert.equal(sanitizeSettings({ lastUpdateCheck: -5 }).lastUpdateCheck, 0);
  assert.equal(sanitizeSettings({ lastUpdateCheck: 'x' }).lastUpdateCheck, 0);
});

test('updateCheckDue: only when on and the last check is 24 h old or more', () => {
  const now = 1_000_000_000_000;
  assert.equal(updateCheckDue({ checkForUpdates: true, lastUpdateCheck: 0 }, now), true);
  assert.equal(updateCheckDue({ checkForUpdates: true, lastUpdateCheck: now - 23 * HOUR }, now), false);
  assert.equal(updateCheckDue({ checkForUpdates: true, lastUpdateCheck: now - 24 * HOUR }, now), true);
  assert.equal(updateCheckDue({ checkForUpdates: false, lastUpdateCheck: 0 }, now), false);
});

test('auto check: throttled to once per 24 h, and the time is persisted', async () => {
  const recent = await makeApp({ lastUpdateCheck: Date.now() - 23 * HOUR });
  await recent.app.autoCheckUpdates();
  assert.equal(recent.host.updateCalls.checks, 0, 'checked 23 h ago: skipped');
  recent.stop();

  const old = await makeApp({ lastUpdateCheck: Date.now() - 25 * HOUR });
  const before = Date.now();
  await old.app.autoCheckUpdates();
  assert.equal(old.host.updateCalls.checks, 1);
  assert.ok(old.app.settings.lastUpdateCheck >= before);
  const saved = JSON.parse(old.host.files.get('settings')!) as { lastUpdateCheck: number };
  assert.ok(saved.lastUpdateCheck >= before, 'persisted in settings.json');
  await old.app.autoCheckUpdates();
  assert.equal(old.host.updateCalls.checks, 1, 'a second call right away is throttled');
  old.stop();
});

test('auto check: checkForUpdates=false skips it', async () => {
  const { app, host, stop } = await makeApp({ checkForUpdates: false });
  await app.autoCheckUpdates();
  assert.equal(host.updateCalls.checks, 0);
  stop();
});

test('auto check: runs after ready once the delay has passed, silently when there is no update or it fails', async () => {
  const a = await makeApp();
  a.app.updateCheckDelayMs = 5;
  await a.app.handle({ type: 'ready' });
  assert.equal(a.host.updateCalls.checks, 0, 'not immediately');
  await settle();
  assert.equal(a.host.updateCalls.checks, 1);
  assert.equal(asks(a.messages).length + toasts(a.messages).length, 0, 'no update: silent');
  a.app.dispose();
  a.stop();

  const b = await makeApp();
  b.host.checkError = 'offline';
  await b.app.autoCheckUpdates();
  assert.equal(asks(b.messages).length + toasts(b.messages).length, 0, 'error: silent');
  assert.equal(b.app.settings.lastUpdateCheck, 0, 'a failed check does not count');
  b.stop();
});

test('auto check: an update is offered with Install / Release notes / Later', async () => {
  const { app, messages, stop } = await makeApp({}, NEW);
  await app.autoCheckUpdates();
  const [ask] = asks(messages);
  assert.ok(ask);
  assert.equal(ask.kind, 'info');
  assert.equal(ask.text, 'Repo Board 1.3.0 is available (you have 9.9.9).');
  assert.deepEqual(ask.actions, ['Install and restart', 'Release notes', 'Later']);
  handleAnswer(ask.id, 'Later');
  stop();
});

test('manual check: without an update says it is up to date, even with automatic checks off', async () => {
  const { app, host, messages, stop } = await makeApp({ checkForUpdates: false, lastUpdateCheck: Date.now() });
  await app.handle({ type: 'checkUpdates' });
  assert.equal(host.updateCalls.checks, 1);
  const progress = tasks(messages, 'Checking for updates');
  assert.equal(progress[0]?.task.title, 'Checking for updates…');
  assert.equal(progress[0]?.task.cancellable, false);
  assert.equal(progress.at(-1)?.done, true);
  assert.equal(toasts(messages).at(-1)?.text, 'Repo Board is up to date (version 9.9.9).');
  stop();
});

test('manual check: a failure is reported as an error with Show log', async () => {
  const { app, host, messages, stop } = await makeApp();
  host.checkError = 'no release yet';
  await app.handle({ type: 'checkUpdates' });
  const ask = asks(messages).at(-1)!;
  assert.equal(ask.kind, 'error');
  assert.equal(ask.text, 'Could not check for updates: no release yet');
  assert.deepEqual(ask.actions, ['Show log']);
  handleAnswer(ask.id, 'Show log');
  await settle();
  assert.ok(messages.some((m) => m.type === 'log' && m.lines.some((l) => l.includes('no release yet'))));
  stop();
});

test('manual check: with an update, Release notes opens the tag page and re-offers; Later ends it', async () => {
  const { app, host, messages, stop } = await makeApp({}, NEW);
  await app.handle({ type: 'checkUpdates' });
  const first = asks(messages).at(-1)!;
  handleAnswer(first.id, 'Release notes');
  await settle();
  assert.deepEqual(host.updateCalls.urls, ['https://github.com/kasuken/repoboard/releases/tag/v1.3.0']);
  assert.equal(releaseUrl('1.3.0'), host.updateCalls.urls[0]);
  const second = asks(messages).at(-1)!;
  assert.notEqual(second.id, first.id, 'offered again');
  handleAnswer(second.id, 'Later');
  await settle();
  assert.equal(host.updateCalls.installs, 0);
  // Free again: another manual check works.
  await app.handle({ type: 'checkUpdates' });
  assert.equal(host.updateCalls.checks, 2);
  stop();
});

test('install: shows a non-cancellable download task with percent, then ends', async () => {
  const { app, host, messages, stop } = await makeApp({}, NEW);
  await app.handle({ type: 'checkUpdates' });
  handleAnswer(asks(messages).at(-1)!.id, 'Install and restart');
  await settle();
  assert.equal(host.updateCalls.installs, 1);
  const download = tasks(messages, 'Downloading Repo Board 1.3.0');
  assert.ok(download.length >= 2);
  assert.equal(download[0]!.task.cancellable, false);
  assert.ok(download.some((t) => t.task.percent === 50));
  assert.equal(download.at(-1)!.done, true);
  assert.equal(asks(messages).filter((a) => a.kind === 'error').length, 0);
  stop();
});

test('install failure: reported as an error with Show log, and the app can check again', async () => {
  const { app, host, messages, stop } = await makeApp({}, NEW);
  host.installError = 'signature mismatch';
  await app.handle({ type: 'checkUpdates' });
  handleAnswer(asks(messages).at(-1)!.id, 'Install and restart');
  await settle();
  const err = asks(messages).find((a) => a.kind === 'error')!;
  assert.ok(err);
  assert.equal(err.text, 'Could not install Repo Board 1.3.0: signature mismatch');
  assert.deepEqual(err.actions, ['Show log']);
  assert.equal(tasks(messages, 'Downloading').at(-1)!.done, true, 'the progress task is closed');
  handleAnswer(err.id, 'Show log');
  await settle();
  assert.ok(messages.some((m) => m.type === 'log' && m.lines.some((l) => l.includes('signature mismatch'))));
  await app.handle({ type: 'checkUpdates' });
  assert.equal(host.updateCalls.checks, 2);
  stop();
});

test('saveSettings keeps the check time of the core even if the dialog sends an older one', async () => {
  const { app, stop } = await makeApp({ lastUpdateCheck: 12345 });
  await app.updateSettings({ ...app.settings, lastUpdateCheck: 0, checkForUpdates: false });
  assert.equal(app.settings.lastUpdateCheck, 12345);
  assert.equal(app.settings.checkForUpdates, false);
  stop();
});

test('a build without the update-signing key never checks and points the manual check at the releases page', async () => {
  const host = createFakeHost();
  host.platformInfo = async () => ({ platform: 'linux', home: '/home/me', sharedDir: '/shared', appDir: '/app', version: '0.2.0', updaterEnabled: false });
  host.files.set('settings', JSON.stringify({ lastUpdateCheck: 0 }));
  const app = new App(host);
  await app.init();
  const messages: HostMessage[] = [];
  const stop = onHostMessage((m) => messages.push(m));
  await app.autoCheckUpdates();
  assert.equal(host.updateCalls.checks, 0);
  const done = app.checkUpdates();
  await new Promise((r) => setTimeout(r, 0));
  const ask = messages.find((m): m is Extract<HostMessage, { type: 'ask' }> => m.type === 'ask');
  assert.ok(ask, 'an info notification');
  assert.match(ask.text, /can't update itself/);
  assert.deepEqual(ask.actions, ['Open releases page']);
  handleAnswer(ask.id, 'Open releases page');
  await done;
  assert.equal(host.updateCalls.checks, 0);
  assert.deepEqual(host.updateCalls.urls, ['https://github.com/kasuken/repoboard/releases']);
  stop();
});
