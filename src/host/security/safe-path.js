/**
 * Project Room — conservative path containment.
 *
 * This is a **policy check**, not an OS sandbox. It exists because a string
 * prefix test (`path.startsWith(workspace)`) is defeated by a symlink or a
 * Windows junction *inside* the workspace that points anywhere else: the path
 * text still looks contained while the write lands outside. So before a path is
 * approved:
 *
 *   1. the target is resolved relative to the root;
 *   2. the deepest existing ancestor is resolved with `realpathSync`, which
 *      follows symlinks and junctions;
 *   3. the missing tail (a file about to be created) is appended to that real
 *      ancestor, and the result must still be inside the real root.
 *
 * What it cannot do: stop an attacker who swaps a directory after the check and
 * before the write (TOCTOU). That window is why the research session also
 * denies shell execution and why the lifecycle never deletes a source path.
 * Callers must not describe this as physical isolation.
 *
 * @module dsh-project-room/src/host/security/safe-path
 */

import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Windows and macOS compare paths case-insensitively in practice. */
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

/** @param {string} value */
function normalized(value) {
  const trimmed = String(value).replace(/[\\/]+$/, '');
  return (CASE_INSENSITIVE ? trimmed.toLowerCase() : trimmed) || sep;
}

/**
 * Whether `child` is the same path as `parent` or lives below it. Uses
 * `path.relative`, so `..` and different drive letters are refused instead of
 * being treated as a textual prefix.
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
export function isInsidePath(parent, child) {
  if (!parent || !child) return false;
  const rel = relative(parent, child);
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  return !rel.split(sep).includes('..');
}

/**
 * Resolve the real location of a path, following symlinks/junctions on every
 * existing ancestor. A path that does not exist yet resolves through its
 * deepest existing ancestor, so a create inside a junction is still attributed
 * to the junction's target.
 * @param {string} value
 * @returns {string}
 */
export function canonicalPath(value) {
  const absolute = resolve(String(value));
  const missing = [];
  let cursor = absolute;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return absolute;
    missing.unshift(cursor.slice(parent.length).replace(/^[\\/]+/, ''));
    cursor = parent;
  }
  let real = cursor;
  try {
    real = realpathSync(cursor);
  } catch {
    real = cursor;
  }
  // `missing` holds basenames, never `..`; re-resolving keeps the caller's
  // remaining segments from escaping the resolved ancestor.
  return resolve(join(real, ...missing));
}

/**
 * Resolve `candidate` and prove it stays inside `root` after symlink/junction
 * resolution.
 *
 * @param {string} root
 * @param {string} candidate Absolute or root-relative.
 * @returns {{ ok: true, path: string, realPath: string } | { ok: false, reason: string, path: string, root: string }}
 */
export function resolveInside(root, candidate) {
  if (typeof root !== 'string' || !root.trim()) {
    return { ok: false, reason: 'root-missing', path: String(candidate ?? ''), root: String(root ?? '') };
  }
  if (typeof candidate !== 'string' || !candidate.trim()) {
    return { ok: false, reason: 'path-missing', path: String(candidate ?? ''), root };
  }
  const realRoot = canonicalPath(root);
  let target;
  try {
    target = isAbsolute(candidate) ? resolve(candidate) : resolve(realRoot, candidate);
  } catch {
    return { ok: false, reason: 'path-invalid', path: String(candidate), root: realRoot };
  }
  const realTarget = canonicalPath(target);
  if (!isInsidePath(realRoot, realTarget)) {
    return { ok: false, reason: 'outside-root', path: realTarget, root: realRoot };
  }
  return { ok: true, path: normalizeAbsolute(realTarget), realPath: realTarget };
}

/** Preserve the caller's spelling while keeping the resolved location. */
function normalizeAbsolute(value) {
  return resolve(value);
}

/**
 * Whether two paths name the same filesystem object after resolution. Used by
 * the resource ledger so two projects that share a directory are visible as
 * `shared` rather than as two independent owned paths.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameCanonicalPath(a, b) {
  if (!a || !b) return false;
  return normalized(canonicalPath(a)) === normalized(canonicalPath(b));
}

/** A stable identity for a canonical path (used as the ledger key). */
export function pathIdentity(value) {
  return normalized(canonicalPath(value));
}
