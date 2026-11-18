import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyCatalog } from '../src/domain/model';
import { App, editorTarget } from '../src/core/app';
import { onHostMessage, onWebviewMessage, post, send } from '../src/core/bridge';
import { CatalogStore } from '../src/core/catalogStore';
import { handleAnswer } from '../src/core/notify';
import { sanitizeSettings, saveSettings, loadSettings } from '../src/core/settings';
import { setPlatform } from '../src/domain/pathlib';
import { DEFAULT_SETTINGS, type HostMessage, type WebviewMessage } from '../src/ui/protocol';
import { createFakeHost, type FakeHost, type FakeRepo } from './support/fakeHost';

setPlatform('linux');

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Collects everything the core posts to the UI. */
function capture(): { messages: HostMessage[]; stop: () => void } {
  const messages: HostMessage[] = [];
  const stop = onHostMessage((m) => messages.push(m));
  return { messages, stop };
}

const asks = (messages: HostMessage[]) => messages.filter((m): m is Extract<HostMessage, { type: 'ask' }> => m.type === 'ask');
const toasts = (messages: HostMessage[]) => messages.filter((m): m is Extract<HostMessage, { type: 'toast' }> => m.type === 'toast');

function catalogJson(paths: string[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    collections: [],
    projects: paths.map((p, i) => ({ id: `id${i}`, name: p.split('/').pop(), path: p, tags: [], source: 'manual', addedAt: 1 })),
    ignoredPaths: [],
    ...extra,
  });
}

async function makeApp(repos: Record<string, FakeRepo>, catalogPaths: string[], settings: Record<string, unknown> = {}): Promise<{ app: App; host: FakeHost }> {
  const host = createFakeHost(repos);
  host.files.set('catalog', catalogJson(catalogPaths));
  host.files.set('settings', JSON.stringify({ cacheMinutes: 0, scanRoots: ['/code'], ...settings }));
  const app = new App(host);
  await app.init();
  await app.projects.ensureLoaded();
  return { app, host };
}

// ── settings ────────────────────────────────────────────────────────────

test('settings: defaults for missing or junk input', () => {
  assert.deepEqual(sanitizeSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(sanitizeSettings('nope'), DEFAULT_SETTINGS);
  assert.deepEqual(sanitizeSettings([1, 2]), DEFAULT_SETTINGS);
});

test('settings: numbers are clamped, enums validated, arrays cleaned', () => {
  const s = sanitizeSettings({
    scanDepth: 99,
    cacheMinutes: -5,
    maxFilesScanned: 5,
    worktrees: 'weird',
    defaultView: 'list',
    defaultSort: 'nonsense',
    theme: 'dark',
    scanRoots: ['  ~/src ', 7, '', null, '/code'],
    ignoreDirs: 'not an array',
    autoScan: 'yes',
    editor: '   ',
    globalShortcut: '  Ctrl+Shift+K ',
  });
  assert.equal(s.scanDepth, 8);
  assert.equal(sanitizeSettings({ scanDepth: 0 }).scanDepth, 1);
  assert.equal(sanitizeSettings({ scanDepth: 2.6 }).scanDepth, 3);
  assert.equal(s.cacheMinutes, 0);
  assert.equal(s.maxFilesScanned, 100);
  assert.equal(s.worktrees, 'nested');
  assert.equal(s.defaultView, 'list');
  assert.equal(s.defaultSort, DEFAULT_SETTINGS.defaultSort);
  assert.equal(s.theme, 'dark');
  assert.deepEqual(s.scanRoots, ['~/src', '/code']);
  assert.deepEqual(s.ignoreDirs, DEFAULT_SETTINGS.ignoreDirs);
  assert.equal(s.autoScan, DEFAULT_SETTINGS.autoScan);
  assert.equal(s.editor, DEFAULT_SETTINGS.editor);
  assert.equal(s.globalShortcut, 'Ctrl+Shift+K');
  assert.equal(sanitizeSettings({ globalShortcut: '' }).globalShortcut, '', 'empty shortcut means "off" and is kept');
});

test('settings: saved to and loaded from the host, merged over defaults', async () => {
  const host = createFakeHost();
  assert.deepEqual(await loadSettings(host), DEFAULT_SETTINGS);
  await saveSettings(host, { ...DEFAULT_SETTINGS, scanDepth: 5, scanRoots: ['/a'] });
  const loaded = await loadSettings(host);
  assert.equal(loaded.scanDepth, 5);
  assert.deepEqual(loaded.scanRoots, ['/a']);
  host.files.set('settings', '{broken');
  assert.deepEqual(await loadSettings(host), DEFAULT_SETTINGS);
  assert.deepEqual(host.calls.backups, ['settings']);
});

// ── bridge ──────────────────────────────────────────────────────────────

test('bridge: messages sent before the core is ready are buffered, and everything is cloned', async () => {
  const received: WebviewMessage[] = [];
  const original: WebviewMessage = { type: 'pin', id: 'a', pinned: true };
  send(original);
  assert.equal(received.length, 0);
  onWebviewMessage((m) => received.push(m));
  await tick();
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], original);
  assert.notEqual(received[0], original, 'structured clone, not the same object');

  send({ type: 'refresh' });
  await tick();
  assert.equal(received.length, 2);

  const seen: HostMessage[] = [];
  const stop = onHostMessage((m) => seen.push(m));
  const msg: HostMessage = { type: 'toast', text: 'hi', kind: 'info' };
  post(msg);
  assert.deepEqual(seen, [msg]);
  assert.notEqual(seen[0], msg);
  stop();
  post(msg);
  assert.equal(seen.length, 1, 'unsubscribed listeners get nothing');
});

// ── catalog store ───────────────────────────────────────────────────────

test('catalog store: broken JSON is backed up and replaced by an empty catalog', async () => {
  const host = createFakeHost();
  host.files.set('catalog', '{ this is not json');
  const store = new CatalogStore(host);
  const catalog = await store.load();
  assert.deepEqual(catalog, emptyCatalog());
  assert.deepEqual(host.calls.backups, ['catalog']);
  assert.equal(host.files.get('catalog'), '{ this is not json', 'the broken file itself is not touched by load');
});

test('catalog store: a missing file is an empty catalog without a backup', async () => {
  const host = createFakeHost();
  assert.deepEqual(await new CatalogStore(host).load(), emptyCatalog());
  assert.deepEqual(host.calls.backups, []);
});

test('catalog store: our own write coming back from the watcher is ignored, foreign changes are not', async () => {
  const host = createFakeHost();
  const store = new CatalogStore(host);
  await store.load();
  await store.startWatching();
  const changes: unknown[] = [];
  store.on('change', (c) => changes.push(c));

  const mine = { ...emptyCatalog(), ignoredPaths: ['/x'] };
  await store.save(mine);
  host.fileChanged(host.files.get('catalog')!); // the echo of our own write
  assert.equal(changes.length, 0);

  host.fileChanged(catalogJson(['/code/other']));
  assert.equal(changes.length, 1);
  assert.equal((changes[0] as { projects: unknown[] }).projects.length, 1);

  host.fileChanged(catalogJson(['/code/other'])); // same text again: already known
  assert.equal(changes.length, 1);
  host.fileChanged('{ half written'); // never throws, never emits
  assert.equal(changes.length, 1);
});

test('catalog store: writes are serialised in call order', async () => {
  const host = createFakeHost();
  const store = new CatalogStore(host);
  const slow = host.writeData.bind(host);
  host.writeData = async (name, text) => {
    if (text.includes('"first"')) await new Promise((r) => setTimeout(r, 20));
    return slow(name, text);
  };
  const a = store.save({ ...emptyCatalog(), ignoredPaths: ['first'] });
  const b = store.save({ ...emptyCatalog(), ignoredPaths: ['second'] });
  await Promise.all([a, b]);
  assert.equal(host.calls.writes.length, 2);
  assert.ok(host.calls.writes[0]!.text.includes('first'));
  assert.ok(host.files.get('catalog')!.includes('second'));
});

// ── bulk git ────────────────────────────────────────────────────────────

test('bulk pull: fast-forwards behind repos, skips conflicts, reports failures with a "Show log" action', async () => {
  const repos: Record<string, FakeRepo> = {
    '/code/ok': { behind: 2 },
    '/code/conflict': { behind: 1, conflicts: 1 },
    '/code/diverged': { behind: 3, pullError: 'fatal: Not possible to fast-forward, aborting.' },
    '/code/current': {},
    '/code/no-upstream': { upstream: undefined },
  };
  const { app, host } = await makeApp(repos, Object.keys(repos));
  const { messages, stop } = capture();

  await app.bulk('pull');

  const pulls = host.calls.remote.filter((c) => c.op === 'pull').map((c) => c.folder).sort();
  assert.deepEqual(pulls, ['/code/diverged', '/code/ok'], 'no pull for conflicts, current or upstream-less repos');
  const fetched = host.calls.remote.filter((c) => c.op === 'fetch').map((c) => c.folder).sort();
  assert.deepEqual(fetched, ['/code/conflict', '/code/current', '/code/diverged', '/code/ok'], 'no-upstream repos are not fetched');

  const summary = asks(messages).find((a) => a.text.startsWith('Pulled'));
  assert.ok(summary, 'a summary was shown');
  assert.equal(summary.kind, 'warning');
  assert.deepEqual(summary.actions, ['Show log']);
  assert.match(summary.text, /^Pulled 1 repo\./);
  assert.match(summary.text, /1 skipped \(conflicts\)\./);
  assert.match(summary.text, /2 still behind\./);
  assert.match(summary.text, /1 failed\.$/);

  const progress = messages.filter((m) => m.type === 'progress');
  assert.ok(progress.length >= 2);
  assert.equal((progress[0] as { task: { cancellable: boolean } }).task.cancellable, true);
  assert.equal((progress.at(-1) as { done?: boolean }).done, true);

  // "Show log" posts the log lines, which contain the failure.
  handleAnswer(summary.id, 'Show log');
  await tick();
  const logMessage = messages.find((m) => m.type === 'log') as Extract<HostMessage, { type: 'log' }> | undefined;
  assert.ok(logMessage);
  assert.ok(logMessage.lines.some((l) => l.includes('Not possible to fast-forward')));
  stop();
});

test('bulk fetch: plain summary without failures is an info toast', async () => {
  const { app } = await makeApp({ '/code/a': { behind: 1 }, '/code/b': { modified: 2 } }, ['/code/a', '/code/b']);
  const { messages, stop } = capture();
  await app.bulk('fetch');
  const t = toasts(messages).find((m) => m.text.startsWith('Fetched'));
  assert.equal(t?.text, 'Fetched 2/2 repos. 1 behind, 1 with local changes.');
  stop();
});

test('bulk: nothing to do without upstream repos', async () => {
  const { app } = await makeApp({ '/code/a': { upstream: undefined } }, ['/code/a']);
  const { messages, stop } = capture();
  await app.bulk('fetch');
  assert.equal(toasts(messages)[0]?.text, 'No repos with an upstream branch to fetch.');
  stop();
});

// ── scan ────────────────────────────────────────────────────────────────

test('scan: new repos are merged, known and removed-earlier ones are not added', async () => {
  const repos: Record<string, FakeRepo> = { '/code/a': {}, '/code/b': {}, '/code/c': {}, '/code/d': {} };
  const host = createFakeHost(repos);
  host.files.set('catalog', catalogJson(['/code/a'], { ignoredPaths: ['/code/b'] }));
  host.files.set('settings', JSON.stringify({ scanRoots: ['/code'] }));
  host.discovered = ['/code/a', '/code/b', '/code/c', '/code/d'];
  const app = new App(host);
  await app.init();
  const { messages, stop } = capture();

  const added = await app.scan({ notify: true });
  await tick();

  assert.equal(added, 2);
  assert.deepEqual(app.projects.projects.map((p) => p.path).sort(), ['/code/a', '/code/c', '/code/d']);
  assert.equal(app.projects.current.projects.find((p) => p.path === '/code/c')?.source, 'discovered');
  assert.deepEqual(app.projects.current.ignoredPaths, ['/code/b']);
  assert.equal(
    toasts(messages).find((t) => t.text.startsWith('Added'))?.text,
    'Added 2 repos to the board (4 found in total). 1 repo you removed earlier stayed off the board.',
  );
  assert.ok(messages.some((m) => m.type === 'scanning' && m.scanning), 'scanning flag raised');
  assert.equal((messages.filter((m) => m.type === 'scanning').at(-1) as { scanning: boolean }).scanning, false);
  assert.ok(host.files.get('catalog')!.includes('/code/c'), 'persisted');

  // Second scan: nothing new, but removed repos can be brought back.
  const again = capture();
  await app.scan({ notify: true });
  await tick();
  const ask = asks(again.messages).find((a) => a.text.includes('already on the board'));
  assert.ok(ask);
  assert.deepEqual(ask.actions, ['Bring removed repos back']);
  stop();
  again.stop();
});

test('scan: with no scan folders it offers to add one, and finds nothing to merge', async () => {
  const { app } = await makeApp({}, [], { scanRoots: [] });
  const { messages, stop } = capture();
  const pending = app.scan({ notify: true });
  await tick();
  const ask = asks(messages)[0]!;
  assert.deepEqual(ask.actions, ['Add folder to scan']);
  handleAnswer(ask.id, undefined);
  assert.equal(await pending, 0);
  stop();
});

test('scan: expands ~ in scan roots and nests linked worktrees only in nested mode', async () => {
  const host = createFakeHost({ '/code/main': {}, '/code/wt': {} });
  host.files.set('catalog', catalogJson([]));
  host.files.set('settings', JSON.stringify({ scanRoots: ['~/code'] }));
  host.discovered = ['/code/main', '/code/wt'];
  const seenRoots: string[][] = [];
  host.discoverRepos = async (roots) => {
    seenRoots.push(roots);
    return ['/code/main', '/code/wt'];
  };
  host.gitDotFile = async (folder) => (folder === '/code/wt' ? 'gitdir: /code/main/.git/worktrees/wt\n' : null);
  const app = new App(host);
  await app.init();
  await app.scan({ notify: false });
  assert.deepEqual(seenRoots[0], ['/home/me/code']);
  assert.deepEqual(app.projects.projects.map((p) => p.path), ['/code/main'], 'worktree folded under its main repo');

  const separate = createFakeHost({});
  separate.files.set('catalog', catalogJson([]));
  separate.files.set('settings', JSON.stringify({ scanRoots: ['/code'], worktrees: 'separate' }));
  separate.discoverRepos = async () => ['/code/main', '/code/wt'];
  separate.gitDotFile = host.gitDotFile;
  const app2 = new App(separate);
  await app2.init();
  await app2.scan({ notify: false });
  assert.equal(app2.projects.projects.length, 2);
});

// ── housekeeping commands ───────────────────────────────────────────────

test('removeMissing removes projects whose folder is gone and keeps offline ones', async () => {
  const repos: Record<string, FakeRepo> = {
    '/code/fine': {},
    '/code/gone': { availability: 'missing' },
    '/mnt/usb/away': { availability: 'offline' },
  };
  const { app } = await makeApp(repos, Object.keys(repos));
  const { messages, stop } = capture();

  const pending = app.removeMissing();
  await tick();
  await tick();
  const ask = asks(messages)[0]!;
  assert.ok(ask, 'asks before removing');
  assert.match(ask.text, /^Remove 1 project whose folder no longer exists\?/);
  assert.match(ask.text, /gone/);
  assert.doesNotMatch(ask.text, /away/);
  handleAnswer(ask.id, 'Remove');
  await pending;

  assert.deepEqual(app.projects.projects.map((p) => p.path).sort(), ['/code/fine', '/mnt/usb/away']);
  assert.deepEqual(app.projects.current.ignoredPaths, []);
  stop();
});

test('removeMissing: nothing missing says so and changes nothing', async () => {
  const { app } = await makeApp({ '/code/a': {}, '/x/b': { availability: 'offline' } }, ['/code/a', '/x/b']);
  const { messages, stop } = capture();
  await app.removeMissing();
  assert.match(toasts(messages)[0]!.text, /^Every project folder still exists/);
  assert.equal(app.projects.projects.length, 2);
  stop();
});

test('resetIgnored forgets removed paths', async () => {
  const { app, host } = await makeApp({}, []);
  await app.projects.update((c) => ({ ...c, ignoredPaths: ['/a', '/b'] }));
  const { messages, stop } = capture();
  await app.resetIgnored();
  assert.deepEqual(app.projects.current.ignoredPaths, []);
  assert.equal(toasts(messages)[0]!.text, 'Forgot 2 removed repos; the next scan may add them again.');
  assert.ok(host.files.get('catalog')!.includes('"ignoredPaths": []'));
  stop();
});

// ── messages and state ──────────────────────────────────────────────────

test('open: uses the configured editor, the absolute newWindow flag, and stamps lastOpenedAt', async () => {
  const { app, host } = await makeApp({ '/code/a': {} }, ['/code/a'], { openInNewWindow: true, editor: 'code' });
  await app.meta.refresh(['/code/a']);
  await app.handle({ type: 'open', id: 'id0', newWindow: false });
  assert.deepEqual(host.calls.opened[0], ['/code/a', 'code', '', 'false']);
  assert.ok((app.projects.byId('id0')?.lastOpenedAt ?? 0) > 0);
  await app.handle({ type: 'openWith', id: 'id0', editor: 'custom' });
  assert.deepEqual(host.calls.opened[1], ['/code/a', 'custom', '', 'true'], 'openWith follows the openInNewWindow setting');
});

test('openUrl only passes http(s) links to the host', async () => {
  const { app, host } = await makeApp({}, []);
  const urls: string[] = [];
  host.openUrl = async (u) => void urls.push(u);
  await app.handle({ type: 'openUrl', url: 'file:///etc/passwd' });
  await app.handle({ type: 'openUrl', url: 'javascript:alert(1)' });
  await app.handle({ type: 'openUrl', url: 'https://example.com/x' });
  assert.deepEqual(urls, ['https://example.com/x']);
});

test('ready posts the full state; saveSettings re-posts it and registers the shortcut', async () => {
  const { app, host } = await makeApp({ '/code/a': {} }, ['/code/a']);
  const shortcuts: string[] = [];
  host.setGlobalShortcut = async (s) => void shortcuts.push(s);
  const { messages, stop } = capture();
  await app.handle({ type: 'ready' });
  const state = (messages.find((m) => m.type === 'state') as Extract<HostMessage, { type: 'state' }>).state;
  assert.equal(state.projects.length, 1);
  assert.equal(state.projects[0]!.isCurrent, false);
  assert.equal(state.editorName, 'Visual Studio Code');
  assert.equal(state.dataFile, '/data/catalog.json');
  assert.equal(state.version, '9.9.9');
  assert.equal(state.ignoredCount, 0);
  assert.equal(state.settings.hasScanRoots, true);
  assert.equal(state.gitAvailable, true);

  await app.handle({ type: 'saveSettings', settings: { ...state.appSettings, scanDepth: 50, globalShortcut: 'Ctrl+Alt+K', editor: 'custom' } });
  assert.deepEqual(shortcuts, ['Ctrl+Alt+K']);
  const last = (messages.filter((m) => m.type === 'state').at(-1) as Extract<HostMessage, { type: 'state' }>).state;
  assert.equal(last.appSettings.scanDepth, 8);
  assert.equal(last.editorName, 'custom command');
  assert.ok(host.files.get('settings')!.includes('"scanDepth": 8'));

  await app.handle({ type: 'saveSettings', settings: last.appSettings });
  assert.deepEqual(shortcuts, ['Ctrl+Alt+K'], 'unchanged shortcut is not re-registered');
  stop();
});

test('a shortcut that cannot be registered warns but keeps the setting', async () => {
  const host = createFakeHost();
  host.files.set('settings', JSON.stringify({ globalShortcut: 'Ctrl+Q' }));
  host.setGlobalShortcut = async () => {
    throw new Error('already registered');
  };
  const { messages, stop } = capture();
  const app = new App(host);
  await app.init();
  await tick();
  assert.match(asks(messages)[0]!.text, /^Could not register the global shortcut "Ctrl\+Q": already registered/);
  assert.equal(app.settings.globalShortcut, 'Ctrl+Q');
  stop();
});

test('host events: tray actions and the global shortcut reach the UI or run commands', async () => {
  const { app, host } = await makeApp({}, []);
  const { messages, stop } = capture();
  host.emit('global-switcher');
  host.emit('tray-action', 'switcher');
  host.emit('tray-action', 'settings');
  assert.deepEqual(messages.map((m) => m.type), ['switcher', 'switcher', 'openSettings']);
  host.emit('tray-action', 'fetchAll');
  await tick();
  await tick();
  assert.ok(toasts(messages).some((t) => t.text.startsWith('No repos with an upstream')));
  stop();
  app.dispose();
});

test('catalog changes made elsewhere update the board state', async () => {
  const { app, host } = await makeApp({}, ['/code/a']);
  const { messages, stop } = capture();
  host.fileChanged(catalogJson(['/code/a', '/code/b']));
  const state = (messages.filter((m) => m.type === 'state').at(-1) as Extract<HostMessage, { type: 'state' }>).state;
  assert.deepEqual(state.projects.map((p) => p.path), ['/code/a', '/code/b']);
  assert.equal(app.projects.projects.length, 2);
  stop();
});

test('editorTarget: VS Code-family editors get .code-workspace files as they are, other editors get the folder', () => {
  setPlatform('win32');
  const ws = String.raw`C:\code\shop\shop.code-workspace`;
  const dir = String.raw`C:\code\shop`;
  for (const editor of ['code', 'code-insiders', 'cursor', 'windsurf', 'codium', 'custom']) assert.equal(editorTarget(ws, editor), ws);
  assert.equal(editorTarget(ws, 'zed'), dir);
  assert.equal(editorTarget(dir, 'zed'), dir);
});
