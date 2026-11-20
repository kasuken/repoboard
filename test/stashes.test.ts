import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseStashList, stashBranch, stashLabel } from '../src/domain/gitParse';
import { hasStashes, type GitStatus, type ProjectMeta } from '../src/domain/model';
import { sortProjects } from '../src/domain/search';
import { GitClient } from '../src/core/git';
import { setPlatform } from '../src/domain/pathlib';
import { createFakeHost } from './support/fakeHost';

setPlatform('linux');

const US = '\x1f';

test('parseStashList: normal entries, messages with colons', () => {
  const out = [`stash@{0}${US}1700000100${US}WIP on main: 1a2b3c4 fix: login flicker`, `stash@{1}${US}1700000000${US}On feature/x: note: with colons`].join('\n') + '\n';
  assert.deepEqual(parseStashList(out), [
    { ref: 'stash@{0}', time: 1700000100, message: 'WIP on main: 1a2b3c4 fix: login flicker' },
    { ref: 'stash@{1}', time: 1700000000, message: 'On feature/x: note: with colons' },
  ]);
});

test('parseStashList: empty output and junk lines', () => {
  assert.deepEqual(parseStashList(''), []);
  assert.deepEqual(parseStashList('\n\n'), []);
  const out = [`gpg: Signature made`, `stash@{0}${US}1700000000${US}On main: a`, `too${US}many${US}fields${US}here`, `only${US}two`, `${US}1${US}no ref`, `stash@{1}${US}1700000000${US}On main: b\r`].join('\n');
  assert.deepEqual(parseStashList(out).map((e) => e.ref), ['stash@{0}', 'stash@{1}']);
});

test('stashBranch and stashLabel', () => {
  assert.equal(stashBranch('WIP on main: 1a2b3c subject'), 'main');
  assert.equal(stashBranch('On feature/cart: try new drawer'), 'feature/cart');
  assert.equal(stashBranch('custom message'), undefined);
  assert.equal(stashLabel('WIP on main: 1a2b3c4 fix login flicker'), 'On main · fix login flicker');
  assert.equal(stashLabel('On feature/cart: try new cart drawer'), 'On feature/cart · try new cart drawer');
  assert.equal(stashLabel('WIP on main: 1a2b3c4'), 'On main');
  assert.equal(stashLabel('something else'), 'something else');
  assert.ok(stashLabel('On x: ' + 'y'.repeat(200)).length <= 80);
});

test('GitClient reads the stash list; a linked worktree gets none', async () => {
  const stash = [{ message: 'WIP on main: abc1234 one', time: 1700000100 }, { message: 'On main: two', time: 1700000000 }];
  const host = createFakeHost({ '/code/main': { stash }, '/code/clean': {}, '/code/wt': { stash } });
  host.gitDotFile = async (folder) => (folder === '/code/wt' ? 'gitdir: /code/main/.git/worktrees/wt\n' : null);
  const git = new GitClient(host);
  const main = await git.status('/code/main');
  assert.equal(main!.stashes, 2);
  assert.deepEqual(main!.stashList!.map((e) => e.ref), ['stash@{0}', 'stash@{1}']);
  assert.equal(main!.stashList![0]!.time, 1700000100);
  const clean = await git.status('/code/clean');
  assert.equal(clean!.stashes, 0);
  assert.equal(clean!.stashList, undefined);
  const wt = await git.status('/code/wt');
  assert.equal(wt!.worktreeOf, '/code/main');
  assert.equal(wt!.stashes, 0);
  assert.equal(wt!.stashList, undefined);
});

test('stash list is capped at 50 but the count is complete', async () => {
  const stash = Array.from({ length: 60 }, (_, i) => ({ message: `On main: n${i}` }));
  const git = new GitClient(createFakeHost({ '/code/a': { stash } }));
  const s = await git.status('/code/a');
  assert.equal(s!.stashes, 60);
  assert.equal(s!.stashList!.length, 50);
});

test('"with stashes" predicate and the most-changes tie-breaker', () => {
  const g = (o: Partial<GitStatus>): GitStatus => ({ branch: 'main', detached: false, ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicts: 0, stashes: 0, ...o });
  assert.equal(hasStashes(g({ stashes: 1 })), true);
  assert.equal(hasStashes(g({})), false);
  assert.equal(hasStashes(null), false);
  const mk = (id: string, name: string) => ({ id, name, path: `/x/${id}`, tags: [], source: 'manual' as const, addedAt: 0 });
  const meta = (git: GitStatus): ProjectMeta => ({ availability: 'ok', git, languages: [], updatedAt: 0, languagesAt: 0 });
  const projects = [mk('a', 'alpha'), mk('b', 'beta'), mk('c', 'gamma')];
  const m = { a: meta(g({})), b: meta(g({ stashes: 2 })), c: meta(g({ modified: 1 })) };
  assert.deepEqual(sortProjects(projects, m, 'changes').map((p) => p.id), ['c', 'b', 'a']);
});
