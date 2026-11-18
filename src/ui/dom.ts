/** DOM helpers shared by the board and the app's own dialogs. textContent only: every string from git or the user is untrusted. */

export type Child = Node | string | null | undefined | false;
export type Props = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = String(value);
    else if (key === 'text') el.textContent = String(value);
    else if (key === 'style' && typeof value === 'object') {
      for (const [prop, v] of Object.entries(value as Record<string, string>)) if (v !== undefined) el.style.setProperty(prop, v);
    } else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value as EventListener);
    else if (key in el && typeof value !== 'string') (el as unknown as Record<string, unknown>)[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) el.append(child);
  return el;
}

export const icon = (name: string, extra = '') => h('span', { class: `codicon codicon-${name} ${extra}`.trim(), 'aria-hidden': 'true' });

export function iconButton(name: string, label: string, onclick: (e: MouseEvent) => void, extra: Props = {}): HTMLButtonElement {
  return h('button', { class: 'icon-btn', type: 'button', title: label, 'aria-label': label, onclick, ...extra }, icon(name));
}

let afterDialogClose: () => void = () => undefined;
/** Where focus goes when a dialog closes (the board points it at the focused tile). */
export function setDialogCloseHook(fn: () => void): void {
  afterDialogClose = fn;
}

export function dialog(title: string, content: HTMLElement[], buttons: HTMLElement[], onSubmit?: () => void, extraClass = ''): HTMLDialogElement {
  const form = h('form', { method: 'dialog', class: 'dialog-form' }, h('h2', { class: 'dialog-title', text: title }), ...content, h('div', { class: 'dialog-buttons' }, ...buttons));
  const d = h('dialog', { class: `dialog ${extraClass}`.trim(), 'aria-label': title }, form);
  form.addEventListener('submit', (e) => {
    const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
    if (submitter?.value === 'ok' && onSubmit) onSubmit();
  });
  d.addEventListener('close', () => {
    d.remove();
    afterDialogClose();
  });
  document.body.append(d);
  d.showModal();
  return d;
}

/** Not a submit button: Enter in a field must submit the dialog's primary action, never Cancel. */
export function cancelButton(label = 'Cancel'): HTMLButtonElement {
  return h('button', { type: 'button', class: 'btn', text: label, onclick: (e: MouseEvent) => (e.currentTarget as HTMLElement).closest('dialog')?.close() });
}

export function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
  return h('label', { class: 'field' }, h('span', { class: 'field-label', text: label }), input, hint ? h('span', { class: 'field-hint', text: hint }) : null);
}

/** Shortcut label for the current platform, e.g. "Ctrl+P" / "⌘P". */
export const isMacPlatform = () => /Mac|iPhone|iPad/.test(navigator.platform);
