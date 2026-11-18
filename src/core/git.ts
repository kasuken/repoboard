import { describeGitError, parseLogLine, parsePorcelainV2, parseWorktreeList, pickRemoteUrl, remoteToWebUrl, worktreeMainFromGitFile } from '../domain/gitParse';
import type { GitStatus, WorktreeInfo } from '../domain/model';
import { pathApi } from '../domain/pathlib';
import type { HostApi, RemoteOp } from '../host/api';

export type { RemoteOp };

/**
 * When `folder` is a linked worktree, returns its main repository's folder. One small file read in Rust;
 * undefined for normal repos, submodules and non-repos.
 */
export async function worktreeMainOf(host: HostApi, folder: string): Promise<string | undefined> {
  try {
    const contents = await host.gitDotFile(folder);
    if (contents === null) return undefined;
    return worktreeMainFromGitFile(contents, folder, (from, to) => pathApi().resolve(from, to));
  } catch {
    return undefined;
  }
}

/** True when `folder` has a `.git` directory or `.git` file (worktree / submodule). One stat, no process. */
export async function isRepo(host: HostApi, folder: string): Promise<boolean> {
  try {
    return (await host.pathKind(pathApi().join(folder, '.git'))) !== 'none';
  } catch {
    return false;
  }
}

/** Git reads and remote operations over the Rust host. Same results and error handling as the extension's GitClient. */
export class GitClient {
  private gitMissing = false;

  constructor(private readonly host: HostApi) {}

  get available(): boolean {
    return !this.gitMissing;
  }

  /** Local state, no network: a few short processes per repo. `null` when not a repo. */
  async status(folder: string): Promise<GitStatus | null> {
    if (this.gitMissing || !(await isRepo(this.host, folder))) {
      return null;
    }
    const { status: st, log, stash, remotes } = await this.host.gitStatus(folder);
    if (st.missingGit) {
      this.gitMissing = true;
      return null;
    }
    if (!st.ok) {
      const error = describeGitError(st.stderr);
      if (!error) {
        return null;
      }
      return { branch: '?', detached: false, ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicts: 0, stashes: 0, error };
    }
    const parsed = parsePorcelainV2(st.stdout);
    const status: GitStatus = {
      branch: parsed.branch,
      detached: parsed.detached,
      ahead: parsed.ahead,
      behind: parsed.behind,
      staged: parsed.staged,
      modified: parsed.modified,
      untracked: parsed.untracked,
      conflicts: parsed.conflicts,
      stashes: stash.ok ? Number(stash.stdout.trim()) || 0 : 0,
    };
    if (parsed.upstream) {
      status.upstream = parsed.upstream;
    }
    const commit = log.ok ? parseLogLine(log.stdout) : undefined;
    if (commit) {
      status.lastCommit = commit;
    }
    const webUrl = remotes.ok ? remoteToWebUrl(pickRemoteUrl(remotes.stdout)) : undefined;
    if (webUrl) {
      status.webUrl = webUrl;
    }
    const main = await worktreeMainOf(this.host, folder);
    if (main) {
      status.worktreeOf = main;
    } else {
      const worktrees = await this.worktrees(folder);
      if (worktrees.length) {
        status.worktrees = worktrees;
      }
    }
    return status;
  }

  /**
   * Linked worktrees of a main repo, with a change count each. Costs nothing for repos without
   * worktrees: `.git/worktrees` is checked before any process starts.
   */
  async worktrees(folder: string, maxWithStatus = 12): Promise<WorktreeInfo[]> {
    try {
      if (!(await this.host.hasLinkedWorktrees(folder))) return [];
    } catch {
      return [];
    }
    const list = await this.host.gitWorktreeList(folder);
    if (!list.ok) return [];
    // Git always lists the main working tree first. Don't compare paths: git reports canonical ones
    // (macOS /private/var, Windows long names instead of 8.3, resolved symlinks) that may not match ours.
    const linked = parseWorktreeList(list.stdout)
      .slice(1)
      .filter((w) => !w.bare);
    return Promise.all(
      linked.map(async (w, i): Promise<WorktreeInfo> => {
        const info: WorktreeInfo = { path: pathApi().resolve(w.path), branch: w.branch || 'HEAD', detached: w.detached, prunable: w.prunable, locked: w.locked };
        if (!w.prunable && i < maxWithStatus) {
          const st = await this.host.gitShortStatus(info.path);
          if (st.ok) {
            const p = parsePorcelainV2(st.stdout);
            info.changes = p.staged + p.modified + p.untracked + p.conflicts;
          } else if (st.missingGit) {
            info.prunable = true;
          }
        }
        return info;
      }),
    );
  }

  /** Background fetch of the current branch's remote. Non-interactive; hooks and fsmonitor off (in Rust). */
  async fetch(folder: string): Promise<boolean> {
    try {
      return await this.host.gitFetchBackground(folder);
    } catch {
      return false;
    }
  }

  /**
   * A fetch / pull / push the user asked for. Runs like their own git (their hooks apply, e.g. pre-push),
   * except fsmonitor stays off and nothing may prompt. Pull is fast-forward only: it never creates a merge.
   */
  async remote(folder: string, op: RemoteOp): Promise<{ ok: boolean; message: string }> {
    // A missing cwd also fails with ENOENT; check it first so it isn't reported as "git not found".
    if (!(await isRepo(this.host, folder))) {
      return { ok: false, message: `${folder} is not available or is not a git repository.` };
    }
    let result;
    try {
      result = await this.host.gitRemote(folder, op);
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    if (result.missingGit) {
      return { ok: false, message: 'git was not found on PATH.' };
    }
    return { ok: result.ok, message: result.ok ? '' : result.stderr.trim() || `git ${op} failed` };
  }
}
