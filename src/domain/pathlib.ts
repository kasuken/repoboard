/**
 * Tiny pure replacement for `node:path` (the webview has no Node). Handles absolute and relative paths
 * for both Windows and POSIX flavours; no filesystem access, so "relative" resolves against a fixed root.
 */

export type PlatformName = 'win32' | 'darwin' | 'linux';

const BS = '\\';

function detectPlatform(): PlatformName {
  const p = (globalThis as { process?: { platform?: string } }).process?.platform;
  return p === 'win32' || p === 'darwin' || p === 'linux' ? p : 'linux';
}

let platform: PlatformName = detectPlatform();

/** The platform paths are interpreted for. Defaults to the Node platform when there is one, else 'linux'. */
export function currentPlatform(): PlatformName {
  return platform;
}

/** The app calls this once at startup with the host's real platform. */
export function setPlatform(p: PlatformName): void {
  platform = p;
}

export interface PathApi {
  sep: string;
  resolve(...segments: string[]): string;
  normalize(input: string): string;
  join(...segments: string[]): string;
  dirname(input: string): string;
  basename(input: string): string;
  parse(input: string): { root: string };
}

interface Split {
  root: string;
  /** The root is complete (drive + slash, UNC share, or "/"), so resolving stops here. */
  absolute: boolean;
  rest: string;
}

function winSplit(p: string): Split {
  const unc = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)[\\/]*/.exec(p);
  if (unc) {
    return { root: `${BS}${BS}${unc[1]}${BS}${unc[2]}${BS}`, absolute: true, rest: p.slice(unc[0].length) };
  }
  const drive = /^([a-zA-Z]):([\\/]*)/.exec(p);
  if (drive) {
    const slash = drive[2]!.length > 0;
    return { root: `${drive[1]}:${slash ? BS : ''}`, absolute: slash, rest: p.slice(drive[0].length) };
  }
  if (/^[\\/]/.test(p)) {
    return { root: BS, absolute: false, rest: p.replace(/^[\\/]+/, '') };
  }
  return { root: '', absolute: false, rest: p };
}

function posixSplit(p: string): Split {
  if (p.startsWith('/')) {
    return { root: '/', absolute: true, rest: p.replace(/^\/+/, '') };
  }
  return { root: '', absolute: false, rest: p };
}

/** Collapses `.`, `..` and empty segments. `..` that would climb above a rooted path is dropped. */
function collapse(rest: string, rooted: boolean, separators: RegExp): string[] {
  const out: string[] = [];
  for (const part of rest.split(separators)) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!rooted) out.push('..');
    } else {
      out.push(part);
    }
  }
  return out;
}

function make(win: boolean): PathApi {
  const sep = win ? BS : '/';
  const split = win ? winSplit : posixSplit;
  const separators = win ? /[\\/]+/ : /\/+/;
  const cwdRoot = win ? `C:${BS}` : '/';

  const resolve = (...segments: string[]): string => {
    let root = '';
    const tails: string[] = [];
    for (let i = segments.length - 1; i >= 0 && !root; i--) {
      const seg = segments[i]!;
      if (!seg) continue;
      const s = split(seg);
      tails.unshift(s.rest);
      if (s.absolute) {
        root = s.root;
      } else if (win && s.root) {
        // "C:foo" (drive-relative) and "\foo" (drive-less) are both anchored to a drive.
        const earlier = segments
          .slice(0, i)
          .reverse()
          .map((x) => /^[a-zA-Z]:/.exec(x)?.[0])
          .find(Boolean);
        const drive = /^[a-zA-Z]:/.test(s.root) ? s.root.slice(0, 2) : earlier ?? 'C:';
        root = drive + BS;
      }
    }
    // Nothing absolute given: there is no cwd in a webview, so anchor at the filesystem root.
    return (root || cwdRoot) + collapse(tails.join(sep), true, separators).join(sep);
  };

  const normalize = (input: string): string => {
    if (!input) return '.';
    const s = split(input);
    const trailing = win ? /[\\/]$/.test(input) : input.endsWith('/');
    const parts = collapse(s.rest, !!s.root, separators);
    let body = parts.join(sep);
    if (!body && !s.root) return '.';
    if (body && trailing) body += sep;
    return s.root + body;
  };

  const join = (...segments: string[]): string => {
    const joined = segments.filter(Boolean).join(sep);
    return joined ? normalize(joined) : '.';
  };

  const dirname = (input: string): string => {
    const s = split(input);
    const parts = collapse(s.rest, !!s.root, separators);
    if (parts.length <= 1) return s.root || '.';
    return s.root + parts.slice(0, -1).join(sep);
  };

  const basename = (input: string): string => {
    const parts = split(input).rest.split(separators).filter(Boolean);
    return parts[parts.length - 1] ?? '';
  };

  return { sep, resolve, normalize, join, dirname, basename, parse: (input) => ({ root: split(input).root }) };
}

export const win32: PathApi = make(true);
export const posix: PathApi = make(false);

export function pathApi(p: string = platform): PathApi {
  return p === 'win32' ? win32 : posix;
}

export function sep(p: string = platform): string {
  return p === 'win32' ? BS : '/';
}
