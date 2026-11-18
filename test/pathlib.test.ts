import assert from 'node:assert/strict';
import * as nodePath from 'node:path';
import { test } from 'node:test';
import { posix, win32 } from '../src/domain/pathlib';

test('pathlib win32 agrees with node:path.win32 on absolute paths', () => {
  const cases = [
    'C:\\Code\\Repo',
    'C:/Code/Repo/',
    'c:\\code\\..\\other\\.\\x',
    'C:\\',
    '\\\\server\\share\\dir\\file',
    '\\\\server\\share',
    'D:\\a\\b\\c.txt',
  ];
  for (const c of cases) {
    assert.equal(win32.resolve(c), nodePath.win32.resolve(c), `resolve ${c}`);
    assert.equal(win32.parse(win32.resolve(c)).root, nodePath.win32.parse(nodePath.win32.resolve(c)).root, `root ${c}`);
  }
  assert.equal(win32.resolve('C:\\code\\app', '..\\..\\x'), nodePath.win32.resolve('C:\\code\\app', '..\\..\\x'));
  assert.equal(win32.resolve('C:\\code\\app', 'D:\\other'), 'D:\\other');
  for (const c of ['C:\\Code\\Repo\\x.code-workspace', 'C:\\Code', 'D:\\a\\b']) assert.equal(win32.dirname(c), nodePath.win32.dirname(c), c);
  assert.equal(win32.basename('C:\\code\\app\\'), 'app');
  assert.equal(win32.join('C:\\Users\\me', 'src\\x'), 'C:\\Users\\me\\src\\x');
  assert.equal(win32.normalize('C:/a//b/../c'), 'C:\\a\\c');
});

test('pathlib posix agrees with node:path.posix on absolute paths', () => {
  const cases = ['/code/app', '/code//app/', '/code/./a/../b', '/', '/a/b/c.txt'];
  for (const c of cases) {
    assert.equal(posix.resolve(c), nodePath.posix.resolve(c), `resolve ${c}`);
    assert.equal(posix.parse(posix.resolve(c)).root, nodePath.posix.parse(nodePath.posix.resolve(c)).root, `root ${c}`);
  }
  assert.equal(posix.resolve('/code/app', '../../x'), '/x');
  assert.equal(posix.resolve('/a', '/b', 'c'), '/b/c');
  assert.equal(posix.resolve('/code/app', '../../../..'), '/');
  for (const c of ['/code/app/x.code-workspace', '/code', '/a/b']) assert.equal(posix.dirname(c), nodePath.posix.dirname(c), c);
  assert.equal(posix.basename('/code/app/'), 'app');
  assert.equal(posix.join('/home/me', 'src/x'), '/home/me/src/x');
  assert.equal(posix.join('a', '..', '..', 'b'), '../b');
});
