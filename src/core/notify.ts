import type { ProgressTask } from '../ui/protocol';
import { post } from './bridge';

/**
 * Standalone replacements for vscode.window notifications. Buttons and progress are rendered by the UI;
 * answers come back through `handleAnswer` / `cancelTask`, which app.ts routes from the bridge.
 */
type Kind = 'info' | 'warning' | 'error';

let nextId = 1;
const asks = new Map<number, (action: string | undefined) => void>();
const cancelled = new Set<number>();

function ask(kind: Kind, text: string, actions: string[]): Promise<string | undefined> {
  if (actions.length === 0 && kind === 'info') {
    post({ type: 'toast', text, kind: 'info' });
    return Promise.resolve(undefined);
  }
  const id = nextId++;
  return new Promise((resolve) => {
    asks.set(id, resolve);
    post({ type: 'ask', id, text, kind, actions });
  });
}

/** Resolves with the clicked button, or undefined when dismissed (or when there are no buttons). */
export const info = (text: string, ...actions: string[]) => ask('info', text, actions);
export const warn = (text: string, ...actions: string[]) => ask('warning', text, actions);
export const error = (text: string, ...actions: string[]) => ask('error', text, actions);

export function toast(text: string, kind: 'info' | 'error' = 'info'): void {
  post({ type: 'toast', text, kind });
}

export function handleAnswer(id: number, action: string | undefined): void {
  const resolve = asks.get(id);
  if (resolve) {
    asks.delete(id);
    resolve(action);
  }
}

export function cancelTask(id: number): void {
  cancelled.add(id);
}

export interface CancellationToken {
  readonly isCancellationRequested: boolean;
}

export interface ProgressReporter {
  report(update: { message?: string; increment?: number }): void;
}

export async function progress<R>(
  title: string,
  cancellable: boolean,
  task: (reporter: ProgressReporter, token: CancellationToken) => Promise<R>,
): Promise<R> {
  const id = nextId++;
  let percent: number | undefined;
  let message: string | undefined;
  const snapshot = (): ProgressTask => ({
    id,
    title,
    cancellable,
    ...(message !== undefined ? { message } : {}),
    ...(percent !== undefined ? { percent } : {}),
  });
  const token: CancellationToken = {
    get isCancellationRequested() {
      return cancelled.has(id);
    },
  };
  post({ type: 'progress', task: snapshot() });
  try {
    return await task(
      {
        report: (update) => {
          if (update.message !== undefined) message = update.message;
          if (update.increment !== undefined) percent = Math.min(100, (percent ?? 0) + update.increment);
          post({ type: 'progress', task: snapshot() });
        },
      },
      token,
    );
  } finally {
    cancelled.delete(id);
    post({ type: 'progress', task: snapshot(), done: true });
  }
}
