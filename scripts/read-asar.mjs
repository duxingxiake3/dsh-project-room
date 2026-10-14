/**
 * Extracts one file out of the packaged `app.asar`.
 *
 * The desktop host runs the framework from inside `<DSH-APP>\resources\app.asar`,
 * and that copy is the one whose API this plugin must satisfy. Reading it through
 * this script is how the adapter's assumptions were checked against the running
 * version instead of against a different install that happens to sit on the same
 * machine — the exact confusion the design notes warns about.
 *
 * Usage:
 *   node scripts/read-asar.mjs dsh/node_modules/@deepseek-ai/dsh-tools/package.json
 *   node scripts/read-asar.mjs dsh/node_modules/@deepseek-ai/dsh-agent/lib/index.js --out .tmp/dsh-agent.js
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ASAR = process.env.DSH_ASAR ?? '<DSH-APP>\\resources\\app.asar';
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Read the asar header.
 *
 * Rather than hardcode the pickle layout (which differs between archives and has
 * already cost one wrong reading), the JSON directory is located by its opening
 * marker and its exact length is found by parsing from the end backwards. File
 * data then begins right after the pickle payload.
 * @param {string} file
 * @returns {{ tree: object, baseOffset: number }}
 */
function readHeader(file) {
  const buffer = readFileSync(file);
  const marker = Buffer.from('{"files"', 'utf8');
  const jsonStart = buffer.indexOf(marker, 0);
  if (jsonStart < 0) throw new Error('no asar directory header found');

  const pickleSize = buffer.readUInt32LE(4);
  const headerStringSize = buffer.readUInt32LE(8);
  const candidates = [headerStringSize, pickleSize - 4, pickleSize];
  let tree = null;
  let end = 0;
  for (const size of candidates) {
    for (let trim = 0; trim < 8; trim += 1) {
      const length = size - trim;
      if (length <= 0 || jsonStart + length > buffer.length) continue;
      try {
        tree = JSON.parse(buffer.toString('utf8', jsonStart, jsonStart + length));
        end = length;
        break;
      } catch {
        /* try a shorter length */
      }
    }
    if (tree !== null) break;
  }
  if (tree === null) throw new Error('could not parse the asar directory header');

  // File data starts after the pickle header and its payload, 4-byte aligned.
  const payloadEnd = jsonStart + end;
  const baseOffset = payloadEnd + ((4 - (payloadEnd % 4)) % 4);
  return { tree, baseOffset };
}

/** Walk the tree to one entry. */
function findEntry(tree, segments) {
  let node = tree;
  for (const segment of segments) {
    const files = node.files ?? node;
    node = files[segment];
    if (!node) throw new Error(`no such entry in the archive: ${segments.join('/')}`);
  }
  return node;
}

const target = process.argv[2];
const outIndex = process.argv.indexOf('--out');
const out = outIndex >= 0 ? process.argv[outIndex + 1] : null;
if (!target) {
  process.stderr.write('usage: node scripts/read-asar.mjs <path-inside-asar> [--out <file>]\n');
  process.exit(2);
}

const { tree, baseOffset } = readHeader(ASAR);
const entry = findEntry(tree, target.split('/'));
if (entry.files && !entry.size) {
  process.stderr.write(`${target} is a directory; entries: ${Object.keys(entry.files).slice(0, 40).join(', ')}\n`);
  process.exit(2);
}

const buffer = readFileSync(ASAR);
const data = buffer.subarray(baseOffset + Number(entry.offset), baseOffset + Number(entry.offset) + Number(entry.size));

if (out) {
  const destination = join(ROOT, out);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, data);
  process.stdout.write(`wrote ${data.length} bytes to ${destination}\n`);
} else {
  process.stdout.write(data.toString('utf8'));
}
