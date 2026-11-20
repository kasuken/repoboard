import { send } from '../core/bridge';
import { cancelButton, dialog, field, h, icon, isMacPlatform } from './dom';
import type { AppSettings, BoardState } from './protocol';
import type { LauncherInfo } from '../host/api';

/** In-app Settings: every AppSettings field, saved as one object. Descriptions follow the extension's settings. */

let live: ((board: BoardState) => void) | undefined;

/** Feed board updates to an open dialog (the core adds scan folders picked through the OS dialog). */
export function refreshSettings(board: BoardState): void {
  live?.(board);
}

const SORT_OPTIONS: Array<[string, string]> = [
  ['manual', 'My order (drag and drop)'],
  ['recent', 'Last opened first'],
  ['name', 'Alphabetical'],
  ['commit', 'Most recent commit first'],
  ['changes', 'Most uncommitted or unsynced changes first'],
];

export function openSettings(board: BoardState): void {
  const s: AppSettings = structuredClone(board.appSettings);
  let coreRoots = [...board.appSettings.scanRoots];
  const mac = board.settings.platform === 'darwin' || isMacPlatform();

  // ── Scan folders ──
  const rootList = h('ul', { class: 'folder-list' });
  const paintRoots = () => {
    if (!s.scanRoots.length) {
      rootList.replaceChildren(h('li', { class: 'folder-empty muted', text: 'No folders yet. Add the folder that holds your projects.' }));
      return;
    }
    rootList.replaceChildren(
      ...s.scanRoots.map((r, i) =>
        h(
          'li',
          { class: 'folder' },
          icon('folder'),
          h('span', { class: 'folder-path', title: r, text: r }),
          h('button', { type: 'button', class: 'icon-btn', title: `Stop scanning ${r}`, 'aria-label': `Remove ${r}`, onclick: () => { s.scanRoots.splice(i, 1); paintRoots(); } }, icon('close')),
        ),
      ),
    );
  };
  paintRoots();
  live = (b) => {
    const next = b.appSettings.scanRoots;
    for (const r of next) if (!coreRoots.includes(r) && !s.scanRoots.includes(r)) s.scanRoots.push(r);
    coreRoots = [...next];
    paintRoots();
  };

  const depth = h('input', { class: 'input num', type: 'number', min: '1', max: '8', step: '1', value: String(s.scanDepth) });
  const ignore = h('textarea', { class: 'input mono', rows: '3', spellcheck: 'false' });
  ignore.value = s.ignoreDirs.join(', ');
  const worktrees = h(
    'select',
    { class: 'input' },
    h('option', { value: 'nested', text: 'Under their main repo', selected: s.worktrees === 'nested' }),
    h('option', { value: 'separate', text: 'As separate projects', selected: s.worktrees === 'separate' }),
  );

  // ── Editor & terminal ──
  const launcherSelect = (items: LauncherInfo[], current: string, extra: Array<[string, string]> = []) =>
    h(
      'select',
      { class: 'input' },
      ...extra.map(([v, t]) => h('option', { value: v, text: t, selected: v === current })),
      ...items
        .filter((l) => l.id !== 'custom')
        .map((l) => h('option', { value: l.id, text: l.available ? l.name : `${l.name} (not found)`, selected: l.id === current })),
      h('option', { value: 'custom', text: 'Custom command…', selected: current === 'custom' }),
    );
  const editor = launcherSelect(board.launchers.editors, s.editor);
  const editorCmd = h('input', { class: 'input mono', placeholder: 'myeditor {path}', value: s.editorCommand, spellcheck: 'false' });
  const terminal = launcherSelect(board.launchers.terminals, s.terminal, [['auto', 'Automatic (system default)']]);
  const terminalCmd = h('input', { class: 'input mono', placeholder: 'myterminal {path}', value: s.terminalCommand, spellcheck: 'false' });
  const sync = () => {
    editorCmd.hidden = editor.value !== 'custom';
    terminalCmd.hidden = terminal.value !== 'custom';
  };
  editor.addEventListener('change', () => { sync(); if (!editorCmd.hidden) editorCmd.focus(); });
  terminal.addEventListener('change', () => { sync(); if (!terminalCmd.hidden) terminalCmd.focus(); });
  sync();

  const check = (label: string, hint: string, value: boolean) => {
    const box = h('input', { type: 'checkbox', checked: value });
    return { box, el: h('label', { class: 'check' }, box, h('span', { class: 'check-text' }, h('span', { class: 'field-label', text: label }), h('span', { class: 'field-hint', text: hint }))) };
  };
  const newWindow = check('Open projects in a new editor window', 'Ctrl/Cmd+click on a project does the opposite.', s.openInNewWindow);
  const autoScan = check('Scan on start and when the app regains focus', 'At most every 10 minutes.', s.autoScan);
  const fetchOnOpen = check('Fetch when the app starts', 'Also when you refresh the whole board. Repos fetched in the last 10 minutes are skipped.', s.fetchOnOpen);
  const fetchInterval = h('input', { class: 'input num', type: 'number', min: '0', max: '1440', step: '1', value: String(s.fetchInterval) });
  const langs = check('Show a language bar on each project', 'A bounded, cached file scan.', s.detectLanguages);
  const updates = check('Check for updates automatically', 'Looks for a new version on GitHub when the app starts, at most once a day.', s.checkForUpdates);
  const tray = check('Closing the window keeps Repo Board in the tray', 'Off: closing the window quits the app.', s.closeToTray);

  const view = h('select', { class: 'input' }, h('option', { value: 'grid', text: 'Grid', selected: s.defaultView === 'grid' }), h('option', { value: 'list', text: 'List', selected: s.defaultView === 'list' }));
  const sort = h('select', { class: 'input' }, ...SORT_OPTIONS.map(([v, t]) => h('option', { value: v, text: t, selected: v === s.defaultSort })));
  const cache = h('input', { class: 'input num', type: 'number', min: '0', step: '1', value: String(s.cacheMinutes) });
  const maxFiles = h('input', { class: 'input num', type: 'number', min: '100', step: '100', value: String(s.maxFilesScanned) });
  const theme = h(
    'select',
    { class: 'input' },
    h('option', { value: 'system', text: 'Match the system', selected: s.theme === 'system' }),
    h('option', { value: 'dark', text: 'Dark', selected: s.theme === 'dark' }),
    h('option', { value: 'light', text: 'Light', selected: s.theme === 'light' }),
  );
  const shortcut = h('input', { class: 'input mono', value: s.globalShortcut, placeholder: 'CommandOrControl+Alt+Shift+P', spellcheck: 'false', autocomplete: 'off' });

  const section = (title: string, ...children: HTMLElement[]) => h('section', { class: 'set-section' }, h('h3', { class: 'set-title', text: title }), ...children);

  const body = h(
    'div',
    { class: 'settings-body' },
    section(
      'Projects',
      field('Folders to scan', h('div', { class: 'stack' }, rootList, h('div', {}, h('button', { type: 'button', class: 'btn', onclick: () => send({ type: 'pickScanRoots' }) }, icon('add'), 'Add folder…'))), 'Every git repo underneath is added to the board. “~” stands for your home folder.'),
      h('div', { class: 'field-row narrow' }, field('Scan depth', depth, 'Folder levels below each folder, 1 to 8.'), field('Linked worktrees', worktrees, 'Nested keeps agent and feature worktrees from crowding the board.')),
      field('Folders to skip', ignore, 'Folder names ignored by discovery and language detection. Separate with commas or new lines.'),
      autoScan.el,
    ),
    section(
      'Opening projects',
      field('Editor', h('div', { class: 'stack' }, editor, editorCmd), 'Used by Open on a tile. Custom commands run with {path} replaced by the project folder.'),
      field('Terminal', h('div', { class: 'stack' }, terminal, terminalCmd), 'Used by “Open terminal here”.'),
      newWindow.el,
    ),
    section(
      'Board',
      h('div', { class: 'field-row even' }, field('Default layout', view), field('Default sort', sort, 'Also orders the switcher.')),
      fetchOnOpen.el,
      field('Fetch in the background every', h('div', { class: 'inline-unit' }, fetchInterval, h('span', { class: 'muted', text: 'minutes' })), 'Keeps ahead/behind counts current. Repos fetched recently by any tool (git, VS Code, the Repo Board extension) are skipped. 0 turns it off.'),
      h('div', { class: 'field-row even' }, field('Reuse git status for (minutes)', cache, '0 reads it every time.'), field('Max files per project', maxFiles, 'Upper bound for language detection, at least 100.')),
      langs.el,
    ),
    section(
      'App',
      h('div', { class: 'field-row even' }, field('Theme', theme), field('Global shortcut', shortcut, mac ? 'Brings Repo Board forward with the switcher open. Example: Command+Alt+Shift+P. Empty turns it off.' : 'Brings Repo Board forward with the switcher open. Example: CommandOrControl+Alt+Shift+P. Empty turns it off.')),
      tray.el,
      updates.el,
    ),
  );

  const footer = h(
    'div',
    { class: 'set-data' },
    h('div', { class: 'set-data-text' }, h('span', { class: 'field-label', text: 'Shared data file' }), h('span', { class: 'path-hint', title: board.dataFile, text: board.dataFile })),
    h('button', { type: 'button', class: 'btn small', onclick: () => send({ type: 'openDataFile' }) }, 'Open data file'),
    h('button', { type: 'button', class: 'btn small', onclick: () => send({ type: 'revealDataFile' }) }, 'Reveal'),
  );

  const d = dialog(
    'Settings',
    [body, footer, h('p', { class: 'set-version muted small', text: `Repo Board ${board.version}` })],
    [h('span', { class: 'spacer' }), cancelButton(), h('button', { type: 'submit', class: 'btn primary', value: 'ok', text: 'Save' })],
    () => {
      const clampInt = (el: HTMLInputElement, min: number, max: number, fallback: number) => {
        const n = Math.round(Number(el.value));
        return Number.isFinite(n) && el.value.trim() !== '' ? Math.min(max, Math.max(min, n)) : fallback;
      };
      const next: AppSettings = {
        ...s,
        scanRoots: s.scanRoots,
        scanDepth: clampInt(depth, 1, 8, s.scanDepth),
        autoScan: autoScan.box.checked,
        ignoreDirs: ignore.value.split(/[,\n]/).map((x) => x.trim()).filter(Boolean),
        worktrees: worktrees.value as AppSettings['worktrees'],
        openInNewWindow: newWindow.box.checked,
        defaultView: view.value as AppSettings['defaultView'],
        defaultSort: sort.value as AppSettings['defaultSort'],
        fetchOnOpen: fetchOnOpen.box.checked,
        fetchInterval: clampInt(fetchInterval, 0, 1440, s.fetchInterval),
        cacheMinutes: clampInt(cache, 0, Number.MAX_SAFE_INTEGER, s.cacheMinutes),
        detectLanguages: langs.box.checked,
        maxFilesScanned: clampInt(maxFiles, 100, Number.MAX_SAFE_INTEGER, s.maxFilesScanned),
        editor: editor.value,
        editorCommand: editorCmd.value.trim(),
        terminal: terminal.value,
        terminalCommand: terminalCmd.value.trim(),
        globalShortcut: shortcut.value.trim(),
        theme: theme.value as AppSettings['theme'],
        closeToTray: tray.box.checked,
        checkForUpdates: updates.box.checked,
      };
      send({ type: 'saveSettings', settings: next });
    },
    'settings',
  );
  d.addEventListener('close', () => (live = undefined));
}
