import { send } from '../core/bridge';
import { h, icon, iconButton } from './dom';
import type { HostMessage, ProgressTask } from './protocol';

/**
 * Bottom-right stack: progress tasks, notifications with buttons (`ask`), and the board's own toast (mounted
 * into the same stack by main.ts). A hairline along the top edge of the window shows that something is running.
 */

type Ask = Extract<HostMessage, { type: 'ask' }>;

const rail = h('div', { class: 'run-rail', 'aria-hidden': 'true', hidden: true });
const host = h('div', { class: 'notes' });
const tasks = new Map<number, HTMLElement>();
const asks = new Map<number, HTMLElement>();

export function mountNotifications(parent: HTMLElement, toastBox: HTMLElement): void {
  host.append(toastBox);
  parent.append(rail, host);
}

const KIND_ICON = { info: 'info', warning: 'warning', error: 'error' } as const;

export function showAsk(m: Ask): void {
  asks.get(m.id)?.remove();
  const answer = (action?: string) => {
    asks.get(m.id)?.remove();
    asks.delete(m.id);
    send({ type: 'answer', id: m.id, action });
  };
  const el = h(
    'div',
    { class: `note ${m.kind}`, role: m.kind === 'error' ? 'alert' : 'status' },
    icon(KIND_ICON[m.kind], 'note-icon'),
    h(
      'div',
      { class: 'note-main' },
      h('p', { class: 'note-text', text: m.text }),
      m.actions.length
        ? h('div', { class: 'note-actions' }, ...m.actions.map((a, i) => h('button', { type: 'button', class: `btn small${i === 0 ? ' primary' : ''}`, text: a, onclick: () => answer(a) })))
        : null,
    ),
    iconButton('close', 'Dismiss', () => answer(undefined)),
  );
  asks.set(m.id, el);
  host.append(el);
}

function railState(): void {
  rail.hidden = tasks.size === 0;
}

export function updateProgress(task: ProgressTask, done?: boolean): void {
  if (done) {
    tasks.get(task.id)?.remove();
    tasks.delete(task.id);
    railState();
    return;
  }
  let el = tasks.get(task.id);
  if (!el) {
    el = h('div', { class: 'task', role: 'status' });
    tasks.set(task.id, el);
    host.prepend(el);
  }
  const determinate = task.percent !== undefined;
  const pct = Math.max(0, Math.min(100, task.percent ?? 0));
  el.replaceChildren(
    h(
      'div',
      { class: 'task-row' },
      icon('loading', 'codicon-modifier-spin task-spin'),
      h('div', { class: 'task-text' }, h('span', { class: 'task-title', text: task.title }), task.message ? h('span', { class: 'task-msg muted small', text: task.message }) : null),
      determinate ? h('span', { class: 'task-pct muted small', text: `${Math.round(pct)}%` }) : null,
      task.cancellable ? h('button', { type: 'button', class: 'btn small', text: 'Cancel', onclick: () => send({ type: 'cancelTask', id: task.id }) }) : null,
    ),
    h(
      'div',
      {
        class: `task-bar${determinate ? '' : ' indeterminate'}`,
        role: 'progressbar',
        'aria-label': task.title,
        'aria-valuemin': determinate ? '0' : null,
        'aria-valuemax': determinate ? '100' : null,
        'aria-valuenow': determinate ? String(Math.round(pct)) : null,
      },
      h('span', { style: determinate ? { width: `${pct}%` } : {} }),
    ),
  );
  railState();
}
