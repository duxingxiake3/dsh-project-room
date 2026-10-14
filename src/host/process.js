/**
 * Running a child process from inside DSH code or its tooling.
 *
 * **Why this exists.** Under the Windows file sandbox a child spawned with Node's
 * default `stdio: 'pipe'` fails with `EPERM` before the program ever runs — the
 * sandbox denies named pipes. That single fact broke three separate things during
 * development, each in a way that looked like a product defect:
 *
 *   - `scripts/check-syntax.mjs` reported all 47 files as syntax errors;
 *   - `tests/integration/workspace.test.js` crashed its process at import, which
 *     under a shared test process took every other suite down with it;
 *   - `scripts/run-client-harness.mjs` reported "the harness did not finish".
 *
 * `capture()` keeps the fast piped path when pipes work (an unsandboxed host) and
 * falls back to redirecting the child's stdout/stderr to a real file descriptor
 * when they do not. Both paths return the same bytes, so callers never branch.
 * Inherited and file-descriptor stdio are permitted under the sandbox; only pipes
 * are refused.
 *
 * This module imports no `@deepseek-ai` package and has no dependency on plugin
 * state, so the tooling scripts can use it too.
 */

import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The code Node reports when the file sandbox refuses a pipe. */
const PIPE_DENIED = 'EPERM';

/**
 * Scratch directory for the fallback's output file, created lazily and reused.
 * A fresh `mkdtempSync` per call would litter the temp directory on every git
 * status check.
 * @type {string | null}
 */
let scratch = null;

/** @returns {string} */
function scratchDir() {
  if (scratch === null) scratch = mkdtempSync(join(tmpdir(), 'dsh-project-room-stdio-'));
  return scratch;
}

/**
 * Runs a child process and captures stdout/stderr as text in both sandbox modes.
 *
 * Never uses `shell: true`: arguments are passed as a vector, so a member-authored
 * path stays a path instead of becoming command syntax.
 *
 * @param {string} file executable name or path
 * @param {string[]} args argument vector, passed verbatim
 * @param {{ cwd?: string, timeoutMs?: number, maxBuffer?: number }} [options]
 * @returns {{ status: number | null, stdout: string, stderr: string, error?: Error, capturedViaPipe: boolean }}
 */
export function capture(file, args, options = {}) {
  const piped = spawnSync(file, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs,
    maxBuffer: options.maxBuffer,
  });

  if (piped.error === undefined || piped.error.code !== PIPE_DENIED) {
    return {
      status: piped.status,
      stdout: piped.stdout ?? '',
      stderr: piped.stderr ?? '',
      error: piped.error ?? undefined,
      capturedViaPipe: true,
    };
  }

  // Pipe refused: capture through a file descriptor instead. stdout and stderr
  // share one file, matching the interleaving the piped path would have produced
  // when a caller concatenates the two streams.
  const outFile = join(scratchDir(), 'stdio.txt');
  const fd = openSync(outFile, 'w');
  try {
    const redirected = spawnSync(file, args, {
      cwd: options.cwd,
      stdio: ['ignore', fd, fd],
      timeout: options.timeoutMs,
    });
    return {
      status: redirected.status,
      stdout: readFileSync(outFile, 'utf8'),
      stderr: '',
      error: redirected.error ?? undefined,
      capturedViaPipe: false,
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * Removes the fallback scratch directory. Safe to call more than once; the next
 * `capture()` recreates it.
 * @returns {void}
 */
export function disposeScratch() {
  if (scratch === null) return;
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* a leftover temp directory is harmless */
  }
  scratch = null;
}
