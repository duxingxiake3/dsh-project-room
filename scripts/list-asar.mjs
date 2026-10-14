/**
 * List asar entries, or search them, without extracting.
 *
 * `scripts/read-asar.mjs` reads one known file; this answers "what IS in the archive",
 * which is what you need when locating a package whose name you are not sure of.
 *
 * Usage:
 *   node scripts/list-asar.mjs dsh/node_modules/@deepseek-ai            # list a directory
 *   node scripts/list-asar.mjs --find web-frontend                       # search entry names
 *   node scripts/list-asar.mjs --asar <archive> dsh                     # explicit archive
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Locate the packaged archive the same way read-asar.mjs does. */
function findAsar() {
  const fromEnv = process.env.DSH_ASAR;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const fromArgv = process.argv.find((argument) => argument.endsWith('app.asar'));
  if (fromArgv && existsSync(fromArgv)) return fromArgv;
  for (const letter of 'CDEFGH') {
    const drive = `${letter}:\\`;
    if (!existsSync(drive)) continue;
    let top;
    try {
      top = readdirSync(drive, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of top) {
      if (!entry.isDirectory()) continue;
      for (const candidate of [join(drive, entry.name, 'resources', 'app.asar')]) {
        if (!existsSync(candidate)) continue;
        try {
          const { tree } = readHeader(candidate);
          const names = new Set(Object.keys(tree.files ?? {}));
          if (names.has('dsh')) return candidate;
        } catch {
          /* not an asar we can read */
        }
      }
    }
  }
  throw new Error('could not locate a DSH app.asar; pass --asar <path>');
}

/**
 * Locate the JSON directory header.
 * @param {string} file
 * @returns {{ tree: object }}
 */
function readHeader(file) {
  const buffer = readFileSync(file);
  const marker = Buffer.from(String.fromCharCode(123) + '"files"', 'utf8');
  const jsonStart = buffer.indexOf(marker, 0);
  if (jsonStart < 0) throw new Error('no asar directory header');
  const pickleSize = buffer.readUInt32LE(4);
  const headerStringSize = buffer.readUInt32LE(8);
  for (const size of [headerStringSize, pickleSize - 4, pickleSize]) {
    for (let trim = 0; trim < 8; trim += 1) {
      const length = size - trim;
      if (length <= 0 || jsonStart + length > buffer.length) continue;
      try {
        return { tree: JSON.parse(buffer.toString('utf8', jsonStart, jsonStart + length)) };
      } catch {
        /* try a shorter length */
      }
    }
  }
  throw new Error('could not parse the asar directory header');
}

/** Walk to one directory node. */
function nodeAt(tree, segments) {
  let node = tree;
  for (const segment of segments) {
    node = node.files?.[segment];
    if (!node) return null;
  }
  return node;
}

/** Depth-first search for entry names matching a pattern. */
function findEntries(node, pattern, prefix, out, limit) {
  if (out.length >= limit) return;
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (pattern.test(name)) out.push(path);
    if (child.files && out.length < limit) findEntries(child, pattern, path, out, limit);
  }
}

const args = process.argv.slice(2);
const asarIndex = args.indexOf('--asar');
const asar = asarIndex >= 0 ? args[asarIndex + 1] : findAsar();
// Drop `--asar <path>` wherever it appears so the remaining arguments are the
// directory (or the `--find <pattern>` pair), independent of argument order.
const rest = args.filter((argument, index) => {
  if (argument === '--asar') return false;
  if (asarIndex >= 0 && index === asarIndex + 1) return false;
  return true;
});

const { tree } = readHeader(asar);
process.stdout.write(`archive: ${asar}\n`);
process.stdout.write(`args: ${JSON.stringify(rest)}\n`);

const findIndex = rest.indexOf('--find');
if (findIndex >= 0) {
  const pattern = new RegExp(rest[findIndex + 1], 'i');
  const out = [];
  findEntries(tree, pattern, '', out, 60);
  process.stdout.write(`matches for /${rest[findIndex + 1]}/i:\n`);
  for (const entry of out) process.stdout.write(`  ${entry}\n`);
} else {
  const target = rest[0] ?? '';
  const node = target ? nodeAt(tree, target.split('/').filter(Boolean)) : tree;
  if (!node) {
    process.stderr.write(`no such directory: ${target}\n`);
    process.exit(2);
  }
  process.stdout.write(`entries of ${target || '(root)'}:\n`);
  for (const [name, child] of Object.entries(node.files ?? {})) {
    process.stdout.write(`  ${child.files ? '[dir] ' : '      '}${name}\n`);
  }
}
