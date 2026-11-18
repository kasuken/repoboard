import type { HostApi } from './api';

/** True inside the Tauri webview; false when the UI runs in a plain browser (`npm run dev` + mock host). */
export const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** The backend: Tauri commands in the app, an in-memory fake with sample repos in a browser. */
export async function loadHost(): Promise<HostApi> {
  if (inTauri) {
    return (await import('./tauri')).tauriHost;
  }
  return (await import('./mock')).mockHost;
}
