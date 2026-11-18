import * as C from '../domain/catalog';
import { Catalog, Project, emptyCatalog } from '../domain/model';
import { Emitter } from './emitter';
import type { CatalogStore } from './catalogStore';

type ProjectEvents = { change: [catalog: Catalog] };

/**
 * In-memory catalog backed by the shared JSON file. Every mutation goes through `update()`,
 * which applies a pure function, saves, and emits `change`. Changes from other processes arrive
 * through the store's watcher and are emitted the same way.
 */
export class ProjectService extends Emitter<ProjectEvents> {
  private catalog: Catalog = emptyCatalog();
  private loading: Promise<void> | undefined;

  constructor(readonly store: CatalogStore) {
    super();
    store.on('change', (catalog) => {
      this.catalog = catalog;
      this.emit('change', catalog);
    });
  }

  ensureLoaded(): Promise<void> {
    this.loading ??= this.store.load().then(async (catalog) => {
      this.catalog = catalog;
      await this.store.startWatching();
    });
    return this.loading;
  }

  get current(): Catalog {
    return this.catalog;
  }

  get projects(): readonly Project[] {
    return this.catalog.projects;
  }

  byId(id: string): Project | undefined {
    return this.catalog.projects.find((p) => p.id === id);
  }

  byPath(path: string): Project | undefined {
    return C.findByPath(this.catalog, path);
  }

  async update(fn: (catalog: Catalog) => Catalog): Promise<void> {
    await this.ensureLoaded();
    const next = fn(this.catalog);
    if (next === this.catalog) {
      return;
    }
    this.catalog = next;
    this.emit('change', next);
    await this.store.save(next);
  }

  async add(input: Parameters<typeof C.addProject>[1]): Promise<Project> {
    await this.ensureLoaded();
    let project!: Project;
    await this.update((catalog) => {
      const result = C.addProject(catalog, input);
      project = result.project;
      return result.catalog;
    });
    return project;
  }

  dispose(): void {
    this.store.stopWatching();
    this.removeAllListeners();
  }
}
