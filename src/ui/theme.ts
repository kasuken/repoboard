import type { AppSettings } from './protocol';

const query = window.matchMedia('(prefers-color-scheme: dark)');
let current: AppSettings['theme'] = 'system';

function apply(): void {
  const dark = current === 'dark' || (current === 'system' && query.matches);
  document.documentElement.dataset['theme'] = dark ? 'dark' : 'light';
  // dashboard.css keys a few light-theme tweaks off these body classes.
  document.body.classList.toggle('vscode-dark', dark);
  document.body.classList.toggle('vscode-light', !dark);
}

/** 'system' follows the OS and updates live. */
export function setTheme(theme: AppSettings['theme']): void {
  current = theme;
  apply();
}

query.addEventListener('change', () => current === 'system' && apply());
apply();
