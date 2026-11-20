import { fetchFreshness } from '../domain/freshness';
import { changedFiles, initialsFor } from '../domain/model';
import { fieldsOf, matchScore, sortProjects } from '../domain/search';
import { send } from '../core/bridge';
import { h, icon, isMacPlatform } from './dom';
import type { BoardState, ProjectView } from './protocol';

/**
 * Project switcher palette (Ctrl/Cmd+P, Ctrl/Cmd+K, the global shortcut). Same ordering as the extension's
 * quick pick: pinned first, then by the default sort ("recent" when that is manual). A query ranks by fuzzy
 * score over name, path, branch, collection and #tags; ties go to pinned, then most recently opened.
 */

const MAX_ROWS = 80;

let overlay: HTMLElement | undefined;
let rerender: (() => void) | undefined;
let restoreFocus: HTMLElement | null = null;

export const isSwitcherOpen = () => !!overlay;

/** Call when the board state changes while the palette is open, so rows stay live. */
export function refreshSwitcher(): void {
  rerender?.();
}

export function closeSwitcher(refocus = true): void {
  overlay?.remove();
  overlay = undefined;
  rerender = undefined;
  if (refocus) restoreFocus?.focus?.();
  restoreFocus = null;
}

export function openSwitcher(getBoard: () => BoardState | undefined): void {
  if (overlay) {
    overlay.querySelector<HTMLInputElement>('input')?.focus();
    return;
  }
  restoreFocus = document.activeElement as HTMLElement | null;
  let query = '';
  let active = 0;
  let shown: ProjectView[] = [];

  const input = h('input', {
    class: 'sw-input',
    type: 'text',
    role: 'combobox',
    'aria-expanded': 'true',
    'aria-controls': 'sw-list',
    'aria-label': 'Switch to a project',
    placeholder: 'Switch to a project: name, path, branch, #tag',
    spellcheck: 'false',
    autocomplete: 'off',
  });
  const list = h('div', { class: 'sw-list', id: 'sw-list', role: 'listbox' });
  const foot = h(
    'div',
    { class: 'sw-foot' },
    h('span', {}, h('kbd', { text: '↑' }), h('kbd', { text: '↓' }), ' move'),
    h('span', {}, h('kbd', { text: 'Enter' }), ' open'),
    h('span', {}, h('kbd', { text: `${isMacPlatform() ? '⌘' : 'Ctrl'}+Enter` }), ' other window'),
    h('span', {}, h('kbd', { text: 'Esc' }), ' close'),
  );
  const box = h('div', { class: 'sw-box', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Project switcher' }, h('div', { class: 'sw-head' }, icon('search', 'sw-icon'), input), list, foot);
  const self = h('div', { class: 'sw-overlay', onmousedown: (e: MouseEvent) => e.target === self && closeSwitcher() }, box);
  overlay = self;

  const open = (p: ProjectView, invert: boolean) => {
    const base = getBoard()?.settings.openInNewWindow ?? true;
    closeSwitcher(false);
    send({ type: 'open', id: p.id, newWindow: invert ? !base : base });
  };

  function compute(): ProjectView[] {
    const board = getBoard();
    if (!board) return [];
    const byRecent = board.settings.defaultSort === 'manual' ? 'recent' : board.settings.defaultSort;
    const sorted = sortProjects(board.projects, board.meta, byRecent) as ProjectView[];
    if (!query.trim()) return [...sorted.filter((p) => p.pinned), ...sorted.filter((p) => !p.pinned)];
    const name = (id?: string) => board.collections.find((c) => c.id === id)?.name;
    return sorted
      .map((p) => ({ p, s: matchScore(query, fieldsOf(p, board.meta[p.id], name(p.collectionId))) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || Number(!!b.p.pinned) - Number(!!a.p.pinned) || (b.p.lastOpenedAt ?? 0) - (a.p.lastOpenedAt ?? 0))
      .map((x) => x.p);
  }

  function row(p: ProjectView, i: number): HTMLElement {
    const board = getBoard()!;
    const meta = board.meta[p.id];
    const git = meta?.git;
    const color = p.color ?? board.collections.find((c) => c.id === p.collectionId)?.color;
    const status: HTMLElement[] = [];
    if (git) {
      status.push(h('span', { class: 'sw-branch' }, icon(git.detached ? 'git-commit' : 'git-branch'), git.branch));
      const changes = changedFiles(git);
      if (git.conflicts) status.push(h('span', { class: 'sw-badge b-conflict', title: 'Merge conflicts' }, icon('warning'), String(git.conflicts)));
      if (changes) status.push(h('span', { class: 'sw-badge b-dirty', title: `${changes} changed file(s)` }, h('span', { class: 'pip' }), String(changes)));
      if (git.behind) status.push(h('span', { class: 'sw-badge b-behind', title: `${git.behind} to pull` }, icon('arrow-down'), String(git.behind)));
      if (git.ahead) status.push(h('span', { class: 'sw-badge b-ahead', title: `${git.ahead} to push` }, icon('arrow-up'), String(git.ahead)));
      if (git.stashes) status.push(h('span', { class: 'sw-badge b-stash', title: `${git.stashes} stash${git.stashes === 1 ? '' : 'es'}` }, icon('archive'), String(git.stashes)));
      if (git.worktrees?.length) status.push(h('span', { class: 'sw-badge', title: 'Linked worktrees' }, icon('repo-forked'), String(git.worktrees.length)));
      // Before you pick a repo to start work in: are its ahead/behind numbers trustworthy?
      const fresh = fetchFreshness(git);
      if (fresh.kind === 'stale' || fresh.kind === 'never' || fresh.kind === 'failed') {
        status.push(h('span', { class: 'sw-badge fetched warn', title: fresh.title }, icon(fresh.kind === 'failed' ? 'warning' : 'history'), fresh.label));
      }
    }
    if (meta?.availability === 'missing') status.push(h('span', { class: 'sw-badge b-missing' }, icon('warning'), 'folder missing'));
    if (meta?.availability === 'offline') status.push(h('span', { class: 'sw-badge b-missing' }, icon('debug-disconnect'), 'drive not connected'));
    const coll = board.collections.find((c) => c.id === p.collectionId);
    if (coll) status.push(h('span', { class: 'sw-badge' }, icon('folder-library'), coll.name));
    for (const t of p.tags.slice(0, 3)) status.push(h('span', { class: 'sw-tag', text: `#${t}` }));

    const avatar =
      !p.icon && meta?.logo
        ? h('span', { class: 'avatar img', 'aria-hidden': 'true' }, h('img', { src: meta.logo, alt: '' }))
        : h('span', { class: `avatar${p.icon ? ' emoji' : ''}`, 'aria-hidden': 'true', style: color ? { '--accent': color } : {}, text: p.icon || initialsFor(p.name) });
    const btn = (name: string, label: string, run: () => void) =>
      h(
        'button',
        {
          type: 'button',
          class: `icon-btn${name === 'pinned' ? ' on' : ''}`,
          tabindex: '-1',
          title: label,
          'aria-label': label,
          onmousedown: (e: MouseEvent) => e.preventDefault(),
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            run();
          },
        },
        icon(name),
      );

    return h(
      'div',
      {
        class: `sw-row${i === active ? ' active' : ''}${meta?.availability && meta.availability !== 'ok' ? ' dim' : ''}`,
        role: 'option',
        id: `sw-opt-${i}`,
        'aria-selected': String(i === active),
        onmousemove: () => active !== i && setActive(i),
        onclick: (e: MouseEvent) => open(p, e.ctrlKey || e.metaKey),
      },
      avatar,
      h(
        'div',
        { class: 'sw-main' },
        h('div', { class: 'sw-line' }, p.pinned ? icon('pinned', 'sw-pinned') : null, h('span', { class: 'sw-name', text: p.name })),
        h('div', { class: 'sw-path', title: p.path, text: p.displayPath }),
      ),
      h('div', { class: 'sw-status' }, ...status),
      h(
        'div',
        { class: 'sw-actions' },
        btn('empty-window', 'Open in the other window', () => {
          closeSwitcher(false);
          send({ type: 'open', id: p.id, newWindow: true });
        }),
        btn('terminal', 'Open terminal here', () => {
          closeSwitcher(false);
          send({ type: 'terminal', id: p.id });
        }),
        btn(p.pinned ? 'pinned' : 'pin', p.pinned ? 'Unpin' : 'Pin to top', () => send({ type: 'pin', id: p.id, pinned: !p.pinned })),
      ),
    );
  }

  function setActive(i: number): void {
    active = i;
    list.querySelectorAll('.sw-row').forEach((el, n) => {
      el.classList.toggle('active', n === i);
      el.setAttribute('aria-selected', String(n === i));
    });
    input.setAttribute('aria-activedescendant', `sw-opt-${i}`);
  }

  function render(): void {
    const board = getBoard();
    const previous = shown[active]?.id;
    shown = compute().slice(0, MAX_ROWS);
    const keep = previous ? shown.findIndex((p) => p.id === previous) : -1;
    if (keep >= 0) active = keep;
    active = Math.min(active, Math.max(shown.length - 1, 0));
    if (!board || board.projects.length === 0) {
      list.replaceChildren(
        h(
          'div',
          { class: 'sw-empty' },
          h('p', { text: 'No repos on the board yet.' }),
          h(
            'button',
            {
              type: 'button',
              class: 'btn primary',
              onclick: () => {
                closeSwitcher(false);
                send({ type: 'addScanRoot' });
              },
            },
            icon('radio-tower'),
            'Scan a folder for repos',
          ),
        ),
      );
      return;
    }
    if (shown.length === 0) {
      list.replaceChildren(h('div', { class: 'sw-empty' }, h('p', { text: `No repo matches “${query.trim()}”.` })));
      return;
    }
    const rows: HTMLElement[] = [];
    let heading = '';
    shown.forEach((p, i) => {
      if (!query.trim()) {
        const group = p.pinned ? 'Pinned' : 'Recent';
        if (group !== heading) {
          heading = group;
          rows.push(h('div', { class: 'sw-group', role: 'presentation', text: group }));
        }
      }
      rows.push(row(p, i));
    });
    list.replaceChildren(...rows);
    input.setAttribute('aria-activedescendant', `sw-opt-${active}`);
    list.querySelector('.sw-row.active')?.scrollIntoView({ block: 'nearest' });
  }
  rerender = render;

  input.addEventListener('input', () => {
    query = input.value;
    active = 0;
    render();
  });
  self.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeSwitcher();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!shown.length) return;
      setActive((active + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length);
      list.querySelector('.sw-row.active')?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      if ((e.target as HTMLElement).closest('.sw-empty button')) return;
      e.preventDefault();
      const p = shown[active];
      if (p) open(p, e.ctrlKey || e.metaKey);
    } else if (e.key === 'Tab') {
      e.preventDefault();
    }
  });
  document.body.append(self);
  render();
  input.focus();
}
