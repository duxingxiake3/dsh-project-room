/**
 * Safe path containment — the real filesystem cases a string prefix test fails.
 *
 * These are policy checks, not an OS sandbox: the tests prove that a junction or
 * symlink *inside* a workspace is resolved before the containment decision, and
 * that a path with `..` never becomes a prefix match.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { canonicalPath, isInsidePath, pathIdentity, resolveInside, sameCanonicalPath } from '../../src/host/security/safe-path.js';

function tempDir(t, label) {
  const dir = mkdtempSync(join(tmpdir(), `safe-path-${label}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('safe path — containment decisions', () => {
  it('accepts a path inside the root, including one that does not exist yet', (t) => {
    const root = tempDir(t, 'root');
    writeFileSync(join(root, 'exists.txt'), 'x', 'utf8');
    const existing = resolveInside(root, 'exists.txt');
    assert.equal(existing.ok, true);
    assert.equal(existing.realPath, join(canonicalPath(root), 'exists.txt'));

    const missing = resolveInside(root, join('nested', 'new.txt'));
    assert.equal(missing.ok, true);
    assert.ok(missing.realPath.endsWith(join('nested', 'new.txt')));
  });

  it('refuses .. traversal and a different drive/absolute path', (t) => {
    const root = tempDir(t, 'root');
    assert.equal(resolveInside(root, join('..', 'outside.txt')).ok, false);
    assert.equal(resolveInside(root, join(root, '..', 'outside.txt')).ok, false);
    assert.equal(resolveInside(root, '').ok, false);
    if (process.platform === 'win32') {
      // A sibling directory that shares the root's textual prefix must not pass.
      const sibling = `${root}-sibling`;
      assert.equal(resolveInside(root, join(sibling, 'file.txt')).ok, false);
      assert.equal(isInsidePath(root, sibling), false);
    }
  });

  it('refuses a junction/symlink inside the root that points outside', (t) => {
    const root = tempDir(t, 'root');
    const outside = tempDir(t, 'outside');
    writeFileSync(join(outside, 'secret.txt'), 'not yours', 'utf8');
    const link = join(root, 'link-out');
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');

    const escaped = resolveInside(root, join('link-out', 'pwn.txt'));
    assert.equal(escaped.ok, false);
    assert.equal(escaped.reason, 'outside-root');
    assert.equal(resolveInside(root, join('link-out', 'secret.txt')).ok, false, '读取既有文件同样越界');

    const inside = join(root, 'real');
    mkdirSync(inside);
    writeFileSync(join(inside, 'ok.txt'), 'ok', 'utf8');
    assert.equal(resolveInside(root, join('real', 'ok.txt')).ok, true);
  });

  it('compares two references to the same directory as one canonical path', (t) => {
    const root = tempDir(t, 'root');
    const link = join(tempDir(t, 'parent'), 'alias');
    symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(sameCanonicalPath(root, link), true);
    assert.equal(pathIdentity(root), pathIdentity(link));
    assert.notEqual(pathIdentity(root), pathIdentity(join(root, 'sub')));
  });
});
