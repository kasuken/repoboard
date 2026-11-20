import type { GitStatus } from './model';

/** A fetch older than this makes the ahead/behind numbers untrustworthy. */
export const FETCH_STALE_MS = 24 * 3_600_000;

export type FreshnessKind = 'none' | 'fresh' | 'stale' | 'never';

export interface Freshness {
  kind: FreshnessKind;
  label: string;
  title: string;
}

/** Compact relative time: just now, 5m ago, 3h ago, 3d ago, 2w ago, 4mo ago, 1y ago. */
export function shortRelativeTime(ms: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  if (days < 60) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** How trustworthy the ahead/behind counts are: when the remote was last fetched. 'none' = nothing to show. */
export function fetchFreshness(git: GitStatus | null | undefined, now = Date.now()): Freshness {
  if (!git || !git.upstream || git.error) {
    return { kind: 'none', label: '', title: '' };
  }
  if (!git.lastFetchAt) {
    return { kind: 'never', label: 'never fetched', title: 'This repo has never been fetched. Ahead/behind counts may be out of date.' };
  }
  const when = new Date(git.lastFetchAt);
  return {
    kind: now - git.lastFetchAt > FETCH_STALE_MS ? 'stale' : 'fresh',
    label: `fetched ${shortRelativeTime(git.lastFetchAt, now)}`,
    title: `Last fetched ${when.toLocaleDateString()} ${when.toLocaleTimeString()}. Ahead/behind counts are as of then.`,
  };
}

export function isFetchStale(git: GitStatus | null | undefined, now = Date.now()): boolean {
  const kind = fetchFreshness(git, now).kind;
  return kind === 'stale' || kind === 'never';
}
