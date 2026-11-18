import { send } from '../core/bridge';
import { dialog, h, icon, isMacPlatform } from './dom';
import type { BoardState } from './protocol';

/** Setup guide: the extension's walkthrough, adapted to the app. A real sequence, so the steps are numbered. */

export interface GuideActions {
  openSwitcher: () => void;
  openSettings: () => void;
}

export function openGuide(board: BoardState | undefined, act: GuideActions): void {
  const mod = isMacPlatform() || board?.settings.isMac ? '⌘' : 'Ctrl';
  const global = board?.appSettings.globalShortcut;
  const hasRepos = (board?.projects.length ?? 0) > 0;

  const step = (done: boolean, title: string, text: string, ...actions: HTMLElement[]) =>
    h(
      'li',
      { class: `guide-step${done ? ' done' : ''}` },
      h('span', { class: 'guide-mark', 'aria-hidden': 'true' }, done ? icon('check') : null),
      h('div', { class: 'guide-text' }, h('h3', { text: title }), h('p', { text: text }), actions.length ? h('div', { class: 'guide-actions' }, ...actions) : null),
    );
  const go = (label: string, run: () => void, primary = false) => h('button', { type: 'button', class: `btn${primary ? ' primary' : ''}`, text: label, onclick: () => { d.close(); run(); } });

  const d = dialog(
    'Get started with Repo Board',
    [
      h('p', { class: 'dialog-text muted', text: 'Put every git repo on your machine on one board. Takes under a minute.' }),
      h(
        'ol',
        { class: 'guide' },
        step(hasRepos, 'Choose the folders that hold your repos', 'Pick one or more folders, such as C:\\code or ~/src. Every git repository inside them is added to the board, and repos you clone later show up by themselves.', go('Choose folders to scan', () => send({ type: 'pickScanRoots' }), !hasRepos)),
        step(false, 'See which repos need you', 'The board shows every repo with its branch, uncommitted changes, and commits to pull or push. Click a chip such as “with changes” or “behind” to narrow it down.'),
        step(
          false,
          `Jump to any repo with ${mod}+P`,
          `Press ${mod}+P (or ${mod}+K) in the app and type part of a name, path, branch or #tag. Pinned repos come first, then the ones you opened most recently.${global ? ` ${global} brings the app forward from anywhere.` : ' Set a global shortcut in Settings to reach it from other apps.'}`,
          go('Try the switcher', act.openSwitcher),
        ),
        step(false, 'Pick your editor and terminal', 'Choose which editor a project opens in, and which terminal “Open terminal here” uses. Repo Board lists the ones it finds on this machine.', go('Open Settings', act.openSettings)),
      ),
    ],
    [h('span', { class: 'spacer' }), h('button', { type: 'submit', class: 'btn primary', value: 'cancel', text: 'Done' })],
    undefined,
    'guide-dialog',
  );
}
