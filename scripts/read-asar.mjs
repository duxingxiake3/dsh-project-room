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

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Locate the packaged `app.asar`.
 *
 * No install path is hardcoded: a repository should not publish one machine's
 * filesystem layout, and a hardcoded default would silently read the wrong archive
 * on another machine — the exact mistake this script exists to prevent. Resolution
 * order: `DSH_ASAR`, the running process's own Electron layout, then a shallow scan
 * of the usual Windows locations.
 *
 * @returns {string}
 */
function findAsar() {
  const fromEnv = process.env.DSH_ASAR;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  // When this script is run by the app's own Electron binary, argv carries the
  // archive path directly.
  const fromArgv = process.argv.find((argument) => argument.endsWith('app.asar'));
  if (fromArgv && existsSync(fromArgv)) return fromArgv;

  const candidates = [];
  for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]) {
    if (!root || !existsSync(root)) continue;
    for (const name of ['DeepSeek Harness', 'deepseek-harness', 'DeepSeekHarness']) {
      candidates.push(join(root, name, 'resources', 'app.asar'));
    }
  }

  // A portable or self-extracted install can sit anywhere, so each drive is scanned
  // at most TWO levels deep for `resources/app.asar`. The depth is bounded on purpose:
  // a recursive walk of a whole drive would be worse than simply asking for the path.
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
      candidates.push(join(drive, entry.name, 'resources', 'app.asar'));
      if (!/dsh|harness|deepseek/i.test(entry.name)) continue;
      try {
        for (const child of readdirSync(join(drive, entry.name), { withFileTypes: true })) {
          if (child.isDirectory()) candidates.push(join(drive, entry.name, child.name, 'resources', 'app.asar'));
        }
      } catch {
        /* an unreadable directory is simply skipped */
      }
    }
  }

  // Several Electron apps can sit on one machine (a work app, an editor…), so the
  // candidates are filtered by CONTENT rather than by path. The test is deliberately
  // crude — the top-level entry names — because it only has to tell "an Electron app"
  // from "the DSH runtime", and reading a few directory keys is far cheaper than
  // validating a nested tree.
  const isDshRuntime = (candidate) => {
    try {
      const { tree } = readHeader(candidate);
      const names = new Set(Object.keys(tree.files ?? {}));
      // The packaged host archive carries the runtime under `dsh/`, with its
      // dependencies either beside it in the archive or unpacked next to it.
      return names.has('dsh') && (names.has('unpacked') || names.has('node_modules') || names.has('desktop-runtime.json'));
    } catch {
      return false;
    }
  };
  const found = candidates.find((candidate) => existsSync(candidate) && isDshRuntime(candidate));
  if (found) return found;

  process.stderr.write(
    `could not locate a DSH app.asar among ${candidates.length} candidate(s). Pass the path explicitly:\n` +
      '  node scripts/read-asar.mjs <file-inside-asar> --asar <path-to-app.asar>\n' +
      'or set DSH_ASAR.\n',
  );
  process.exit(2);
}

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

/**
 * Split argv into the positional path plus the flags, so a flag may appear before or
 * after the path without being mistaken for it.
 */
function parseArguments(argv) {
  const positional = [];
  const flags = new Map();
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--out' || argument === '--asar') {
      flags.set(argument.slice(2), argv[index + 1]);
      index += 1;
      continue;
    }
    if (argument.startsWith('--')) {
      flags.set(argument.slice(2), true);
      continue;
    }
    positional.push(argument);
  }
  return { target: positional[0], flags };
}

const { target, flags } = parseArguments(process.argv);
const out = typeof flags.get('out') === 'string' ? flags.get('out') : null;
const asarFlag = flags.get('asar');
// `--asar` names the archive; everything else is resolved from the environment.
const ASAR = typeof asarFlag === 'string' ? asarFlag : findAsar();

if (!target) {
  process.stderr.write('usage: node scripts/read-asar.mjs <path-inside-asar> [--out <file>] [--asar <archive>]\n');
  process.exit(2);
}
if (!ASAR || !existsSync(ASAR)) {
  process.stderr.write(`no archive at ${ASAR}\n`);
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
