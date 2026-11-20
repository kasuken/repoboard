import { DEFAULT_SETTINGS, type AppSettings } from '../ui/protocol';
import { SORT_MODES } from '../domain/model';
import { expandHome } from '../domain/paths';
import type { HostApi } from '../host/api';
import { log } from './log';

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function num(value: unknown, fallback: number, min: number, max = Number.POSITIVE_INFINITY): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(min, Math.min(max, n));
}

function strings(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Coerces arbitrary JSON (hand-edited file, older version, the Settings dialog) into valid settings. */
export function sanitizeSettings(raw: unknown): AppSettings {
  const d = DEFAULT_SETTINGS;
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    scanRoots: strings(r['scanRoots'], d.scanRoots),
    scanDepth: num(r['scanDepth'], d.scanDepth, 1, 8),
    autoScan: bool(r['autoScan'], d.autoScan),
    ignoreDirs: strings(r['ignoreDirs'], d.ignoreDirs),
    worktrees: oneOf(r['worktrees'], ['nested', 'separate'] as const, d.worktrees),
    openInNewWindow: bool(r['openInNewWindow'], d.openInNewWindow),
    defaultView: oneOf(r['defaultView'], ['grid', 'list'] as const, d.defaultView),
    defaultSort: oneOf(r['defaultSort'], SORT_MODES, d.defaultSort),
    fetchOnOpen: bool(r['fetchOnOpen'], d.fetchOnOpen),
    fetchInterval: num(r['fetchInterval'], d.fetchInterval, 0, 1440),
    cacheMinutes: num(r['cacheMinutes'], d.cacheMinutes, 0),
    detectLanguages: bool(r['detectLanguages'], d.detectLanguages),
    maxFilesScanned: num(r['maxFilesScanned'], d.maxFilesScanned, 100),
    editor: str(r['editor'], d.editor).trim() || d.editor,
    editorCommand: str(r['editorCommand'], d.editorCommand),
    terminal: str(r['terminal'], d.terminal).trim() || d.terminal,
    terminalCommand: str(r['terminalCommand'], d.terminalCommand),
    globalShortcut: str(r['globalShortcut'], d.globalShortcut).trim(),
    theme: oneOf(r['theme'], ['system', 'light', 'dark'] as const, d.theme),
    closeToTray: bool(r['closeToTray'], d.closeToTray),
    checkForUpdates: bool(r['checkForUpdates'], d.checkForUpdates),
    lastUpdateCheck: num(r['lastUpdateCheck'], d.lastUpdateCheck, 0),
  };
}

export async function loadSettings(host: HostApi): Promise<AppSettings> {
  try {
    const text = await host.readData('settings');
    return sanitizeSettings(text ? JSON.parse(text) : undefined);
  } catch (e) {
    log(`[settings] could not read settings.json, using defaults: ${e instanceof Error ? e.message : String(e)}`);
    await host.backupData('settings').catch(() => undefined);
    return sanitizeSettings(undefined);
  }
}

export async function saveSettings(host: HostApi, settings: AppSettings): Promise<void> {
  await host.writeData('settings', JSON.stringify(settings, null, 2) + '\n');
}

/** Scan roots with `~` expanded (stored settings keep what the user typed). */
export function scanRootsOf(settings: AppSettings, home: string): string[] {
  return settings.scanRoots.map((r) => expandHome(r.trim(), home)).filter(Boolean);
}
