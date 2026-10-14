/**
 * Syntax gate for every source file in the package.
 *
 * The plugin ships as plain ESM with no build step — the same choice the other
 * published DSH plugins make, and the reason a `dsh plugin` install needs no
 * toolchain. Without a compiler, a syntax check is the cheapest possible guard
 * against shipping a file the host cannot even parse.
 *
 * Parsing is IN-PROCESS (`vm.SourceTextModule`), never `node --check` in a child
 * process. That is not a style preference: DSH's Windows file sandbox denies
 * named pipes, so a child spawned with the default `stdio: 'pipe'` dies with
 * `EPERM` and the check silently degenerates into "everything failed". Parsing
 * here means the gate reports the truth in every sandbox mode. This file already
 * caught that exact trap once, in its own test.
 *
 *   node scripts/check-syntax.mjs            # gate, exit 1 on any problem
 *   node --experimental-vm-modules …         # required flag, see below
 *
 * `vm.SourceTextModule` is behind `--experimental-vm-modules`. It is passed by
 * `npm run check`; running this file directly without it reports that fact
 * instead of pretending the tree is broken.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIRECTORIES = ['src', 'shared', 'tests', 'scripts'];
const FILES = ['host.js', 'client.js'];
const SKIP = new Set(['node_modules', '.git', '.project-room-data', '.tmp']);

/**
 * A stray reference to a host package would break installation on a profile that
 * does not provide it. This plugin intentionally imports only node builtins and
 * its own files.
 */
const FORBIDDEN = /from\s+['"]@deepseek-ai\//;

/** @returns {string[]} */
function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...collect(full));
    else if (entry.endsWith('.js') || entry.endsWith('.mjs')) out.push(full);
  }
  return out;
}

/**
 * Parses every package file and reports the problems found.
 *
 * Exported so the activation-contract test can assert on the real result instead
 * of spawning this script — a spawned child would hit the pipe denial above and
 * report a failure that has nothing to do with the plugin.
 *
 * @returns {{ targets: string[], failures: string[], available: boolean }}
 */
export function checkSyntax({ root = ROOT } = {}) {
  const targets = FILES.map((file) => join(root, file));
  for (const directory of DIRECTORIES) {
    try {
      targets.push(...collect(join(root, directory)));
    } catch {
      /* an absent optional directory is not a failure */
    }
  }

  const parse = vm.SourceTextModule;
  if (typeof parse !== 'function') return { targets, failures: [], available: false };

  const failures = [];
  for (const target of targets) {
    const text = readFileSync(target, 'utf8');
    // Generated files are checked by their generator's own staleness check, and a
    // browser chunk has no ESM syntax of its own to validate.
    if (text.startsWith('/**\n * GENERATED FILE')) continue;
    try {
      // Constructing the module parses and resolves the syntax; it does not run
      // any code and does not need the imports to exist.
      new parse(text, { identifier: target });
    } catch (error) {
      failures.push(`${relative(root, target)}: ${error.message}`);
    }
  }

  for (const target of targets) {
    if (FORBIDDEN.test(readFileSync(target, 'utf8'))) {
      failures.push(
        `${relative(root, target)} imports a @deepseek-ai package; the plugin must stay install-free.`,
      );
    }
  }

  return { targets, failures, available: true };
}

/**
 * CLI entry. When this file is imported (the test does) nothing below runs.
 * @returns {void}
 */
function main() {
  const { targets, failures, available } = checkSyntax();
  if (!available) {
    process.stderr.write(
      'vm.SourceTextModule is unavailable, so nothing was parsed.\n' +
        'Re-run with the flag the package script uses: node --experimental-vm-modules scripts/check-syntax.mjs\n',
    );
    process.exit(2);
  }
  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`✖ ${failure}\n`);
    process.stderr.write(`\n${failures.length} problem(s) found in ${targets.length} file(s).\n`);
    process.exit(1);
  }
  process.stdout.write(`✔ ${targets.length} file(s) parsed, no host-package imports.\n`);
}

// Imported by the test, executed by `npm run check`: only run when this file is
// the process entry point.
const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) main();
