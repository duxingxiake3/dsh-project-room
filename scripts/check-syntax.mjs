/**
 * Syntax gate for every source file in the package.
 *
 * The plugin ships as plain ESM with no build step — the same choice the other
 * published DSH plugins make, and the reason a `dsh plugin` install needs no
 * toolchain. Without a compiler, a syntax check is the cheapest possible guard
 * against shipping a file the host cannot even parse.
 *
 * `node --check` parses a single file; this walks the tree so a file that is
 * never imported by a test still gets checked.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIRECTORIES = ['src', 'shared', 'tests', 'scripts'];
const FILES = ['host.js', 'client.js'];
const SKIP = new Set(['node_modules', '.git', '.project-room-data']);

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

const targets = [...FILES.map((file) => join(ROOT, file))];
for (const directory of DIRECTORIES) {
  try {
    targets.push(...collect(join(ROOT, directory)));
  } catch {
    /* an absent optional directory is not a failure */
  }
}

let failures = 0;
for (const target of targets) {
  const text = readFileSync(target, 'utf8');
  // Generated files are checked by their generator's own staleness check, and a
  // browser chunk cannot be parsed by `node --check` anyway (it has no ESM
  // syntax of its own to validate).
  if (text.startsWith('/**\n * GENERATED FILE')) continue;
  const result = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
  if (result.status !== 0) {
    failures += 1;
    process.stderr.write(`✖ ${relative(ROOT, target)}\n${result.stderr}\n`);
  }
}

// A stray reference to a host package would break installation on a profile that
// does not provide it. This plugin intentionally imports only node builtins and
// its own files.
const FORBIDDEN = /from\s+['"]@deepseek-ai\//;
for (const target of targets) {
  const text = readFileSync(target, 'utf8');
  if (FORBIDDEN.test(text)) {
    failures += 1;
    process.stderr.write(`✖ ${relative(ROOT, target)} imports a @deepseek-ai package; the plugin must stay install-free.\n`);
  }
}

if (failures > 0) {
  process.stderr.write(`\n${failures} problem(s) found in ${targets.length} file(s).\n`);
  process.exit(1);
}
process.stdout.write(`✔ ${targets.length} file(s) parsed, no host-package imports.\n`);
