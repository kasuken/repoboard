import type { HostMessage, WebviewMessage } from '../ui/protocol';

/**
 * In-process replacement for the VS Code webview message channel. The UI and the core run in the same
 * JS context, but they still talk only through these messages, so neither can reach into the other's state.
 * Every message is structured-cloned: the UI mutates what it receives (e.g. `board.meta[id] = …`).
 */
type HostListener = (message: HostMessage) => void;
type CoreHandler = (message: WebviewMessage) => void;

const uiListeners = new Set<HostListener>();
let coreHandler: CoreHandler | undefined;
const pending: WebviewMessage[] = [];

/** UI → core. Buffered until the core registers its handler. */
export function send(message: WebviewMessage): void {
  const copy = structuredClone(message);
  if (!coreHandler) {
    pending.push(copy);
    return;
  }
  const handler = coreHandler;
  queueMicrotask(() => handler(copy));
}

/** UI side: receive core messages. */
export function onHostMessage(listener: HostListener): () => void {
  uiListeners.add(listener);
  return () => uiListeners.delete(listener);
}

/** Core → UI. */
export function post(message: HostMessage): void {
  for (const listener of uiListeners) {
    listener(structuredClone(message));
  }
}

/** Core side: handle UI messages. Flushes anything the UI sent before the core was ready. */
export function onWebviewMessage(handler: CoreHandler): void {
  coreHandler = handler;
  for (const message of pending.splice(0)) {
    queueMicrotask(() => handler(message));
  }
}
