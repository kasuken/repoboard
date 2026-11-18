/** Minimal typed event emitter (no node:events in the webview). */
type AnyFn = (...args: never[]) => void;

export class Emitter<Events extends { [K in keyof Events]: unknown[] }> {
  private readonly listeners = new Map<keyof Events, Set<AnyFn>>();

  on<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener as unknown as AnyFn);
    return () => this.off(event, listener);
  }

  off<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): void {
    this.listeners.get(event)?.delete(listener as unknown as AnyFn);
  }

  protected emit<K extends keyof Events>(event: K, ...args: Events[K]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      (listener as unknown as (...a: Events[K]) => void)(...args);
    }
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}
