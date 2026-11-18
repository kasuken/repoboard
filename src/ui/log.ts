import { send } from '../core/bridge';
import { dialog, h, icon } from './dom';

/** Log viewer: asks the core for the log (`showLog`) and fills in the `log` answer. */

let target: HTMLElement | undefined;
let linesNow: string[] = [];

export function openLog(request = true): void {
  const pre = h('pre', { class: 'log', tabindex: '0', 'aria-label': 'Log output', text: 'Loading…' });
  target = pre;
  linesNow = [];
  const copy = h('button', { type: 'button', class: 'btn', onclick: async () => {
    try {
      await navigator.clipboard.writeText(linesNow.join('\n'));
      copy.replaceChildren(icon('check'), 'Copied');
    } catch {
      copy.textContent = 'Copy failed';
    }
    setTimeout(() => copy.replaceChildren(icon('copy'), 'Copy'), 1600);
  } }, icon('copy'), 'Copy');
  const d = dialog('Log', [pre], [copy, h('button', { type: 'button', class: 'btn', onclick: () => send({ type: 'showLog' }) }, icon('refresh'), 'Reload'), h('span', { class: 'spacer' }), h('button', { type: 'submit', class: 'btn primary', value: 'cancel', text: 'Close' })], undefined, 'log-dialog');
  d.addEventListener('close', () => (target = undefined));
  if (request) send({ type: 'showLog' });
}

export function setLog(lines: string[]): void {
  // The core can push the log unasked ("Show log" on a notification): open the viewer then.
  if (!target) openLog(false);
  linesNow = lines;
  if (!target) return;
  const atBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 24;
  target.textContent = lines.length ? lines.join('\n') : 'Nothing has been logged yet.';
  if (atBottom || target.scrollTop === 0) target.scrollTop = target.scrollHeight;
}
