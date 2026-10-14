/**
 * Running git from inside a DSH plugin.
 *
 * The child-process mechanics live in `src/host/process.js` — the sandbox denies
 * named pipes, so capturing git's output needs the fallback documented there.
 * What is git-specific, and therefore here:
 *
 *   - git is *optional*. A machine without it is a supported configuration that
 *     degrades to serialized writes (the design notes), so `gitVersion()` returns
 *     `null` instead of throwing while `git()` throws a typed `RoomError`, because
 *     a git command that fails is a fact the caller must report rather than swallow.
 *   - git is always run with an explicit `cwd`. A command silently aimed at the
 *     host's own directory would report a confident answer about a repository the
 *     room never touched.
 */

import { RoomError } from '../../../shared/contracts.js';
import { capture } from '../process.js';

/**
 * Runs git and returns its stdout, throwing a `RoomError` when git fails.
 *
 * @param {string} cwd directory the command runs in; never defaulted
 * @param {string[]} args
 * @returns {string}
 */
export function git(cwd, args) {
  const result = capture('git', args, { cwd });
  if (result.error !== undefined || result.status !== 0) {
    const detail = result.stderr.trim() || result.error?.message || `exit ${result.status}`;
    throw new RoomError('WORKSPACE_GIT_FAILED', `git ${args[0] ?? ''} failed: ${detail}`, {
      args,
      cwd,
      status: result.status ?? null,
    });
  }
  return result.stdout;
}

/**
 * Reports the installed git version, or `null` when git is absent.
 *
 * Used for the capability line in the boot report, so it must never throw.
 * @returns {string | null}
 */
export function gitVersion() {
  const result = capture('git', ['--version']);
  if (result.error !== undefined || result.status !== 0) return null;
  return result.stdout.trim() || null;
}
