import { sanitizeCatalog } from '../domain/catalog';
import { Catalog, emptyCatalog } from '../domain/model';
import { EVENTS, type HostApi } from '../host/api';
import { Emitter } from './emitter';
import { log } from './log';

type StoreEvents = { change: [catalog: Catalog] };

/**
 * JSON persistence for the catalog over the host's text files, with live sync from other processes
 * (the VS Code extension shares the file). Emits `change` when the file was rewritten by someone else.
 */
export class CatalogStore extends Emitter<StoreEvents> {
  private lastWritten: string | undefined;
  private writeChain: Promise<void> = Promise.resolve();
  private unlisten: (() => void) | undefined;
  private watching: Promise<void> | undefined;

  constructor(private readonly host: HostApi) {
    super();
  }

  /** Absolute path of catalog.json. */
  file(): Promise<string> {
    return this.host.dataFilePath('catalog');
  }

  async load(): Promise<Catalog> {
    const text = await this.host.readData('catalog');
    if (text === null) {
      return emptyCatalog();
    }
    try {
      const catalog = sanitizeCatalog(JSON.parse(text));
      this.lastWritten = text;
      return catalog;
    } catch {
      // Keep the broken file for the user instead of silently overwriting it.
      const backup = await this.host.backupData('catalog').catch(() => null);
      log(`[catalog] catalog.json is not valid JSON; ${backup ? `copied to ${backup}` : 'could not back it up'}; starting empty`);
      return emptyCatalog();
    }
  }

  /** Writes are serialised so two quick edits can never interleave on disk. */
  save(catalog: Catalog): Promise<void> {
    const text = JSON.stringify(catalog, null, 2) + '\n';
    this.writeChain = this.writeChain
      .then(async () => {
        // Set before the write: the watcher's echo may arrive before writeData resolves.
        this.lastWritten = text;
        await this.host.writeData('catalog', text);
      })
      .catch((e) => {
        log(`[catalog] save failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    return this.writeChain;
  }

  startWatching(): Promise<void> {
    this.watching ??= (async () => {
      this.unlisten = await this.host.on<string>(EVENTS.catalogChanged, (text) => this.onChangedText(text));
      await this.host.watchCatalog();
    })().catch(() => undefined);
    return this.watching;
  }

  stopWatching(): void {
    this.unlisten?.();
    this.unlisten = undefined;
    this.watching = undefined;
  }

  /** Handles the text Rust read after a file change. Our own writes come back identical and are ignored. */
  private onChangedText(text: string): void {
    if (text === this.lastWritten) {
      return;
    }
    try {
      const catalog = sanitizeCatalog(JSON.parse(text));
      this.lastWritten = text;
      this.emit('change', catalog);
    } catch {
      // Half-written by an editor; the next event will carry the full file.
    }
  }
}
