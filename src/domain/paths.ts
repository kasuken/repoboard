import { PlatformName, currentPlatform, pathApi, sep } from './pathlib';

type Platform = PlatformName | string;

/**
 * Identity key for a path. `Uri.fsPath` yields `c:\code\x` while users type `C:\Code\x\`, so every
 * comparison (dedupe, discovery merge, "currently open") goes through this one function.
 * Windows paths are case-folded; POSIX paths are kept case-sensitive.
 */
export function pathKey(input: string, platform: Platform = currentPlatform()): string {
  const win = platform === 'win32';
  const p = pathApi(platform);
  let resolved = p.resolve(input.trim());
  const root = p.parse(resolved).root;
  while (resolved.length > root.length && (resolved.endsWith('/') || resolved.endsWith('\\'))) {
    resolved = resolved.slice(0, -1);
  }
  return win ? resolved.toLowerCase() : resolved;
}

export function samePath(a: string, b: string, platform: Platform = currentPlatform()): boolean {
  return pathKey(a, platform) === pathKey(b, platform);
}

/** Shortens a path for display: the home directory becomes `~`. */
export function displayPath(input: string, home: string, platform: Platform = currentPlatform()): string {
  if (!home) {
    return input;
  }
  const key = pathKey(input, platform);
  const homeKey = pathKey(home, platform);
  if (key === homeKey) {
    return '~';
  }
  if (key.startsWith(homeKey + sep(platform))) {
    return '~' + input.slice(home.replace(/[\\/]+$/, '').length);
  }
  return input;
}

/** Expands a leading `~` so settings like `~/src` work everywhere. */
export function expandHome(input: string, home: string): string {
  if (input === '~') {
    return home;
  }
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return pathApi().join(home, input.slice(2));
  }
  return input;
}

/** The folder git and terminals run in: a `.code-workspace` file's directory, else the path itself. */
export function folderOf(projectPath: string): string {
  return projectPath.toLowerCase().endsWith('.code-workspace') ? pathApi().dirname(projectPath) : projectPath;
}
