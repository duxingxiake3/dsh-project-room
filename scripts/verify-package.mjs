/**
 * Verifies that the packed tarball is complete and installable.
 *
 * `npm pack` decides what ships from two implicit sources — the `files` array and
 * a short list of always-included names — so "the tarball is fine" is a claim to
 * be measured, not assumed: `files` can name a directory that no longer exists, a
 * nested `.npmignore` can drop a file from inside one, and a manifest can ship
 * without the `dsh` block the loader reads to find the bundle patch. Every one of
 * those is a silent install failure in a profile, so none of them is cosmetic.
 *
 * No root `.npmignore` is added to this package, deliberately. npm documents that
 * a root `.npmignore` cannot exclude something `files` names, so it would only add
 * a second, weaker source of truth next to the array the loader already reads.
 * This script is the source of truth instead: it compares the real tarball with
 * the manifest's own promises, in both directions (nothing missing, nothing
 * extra).
 *
 * Everything runs in-process — `node:zlib` for the gzip, a local tar reader for
 * the archive, `import()` for the extracted host half, `vm.SourceTextModule` for
 * the client half. No child process is spawned, which is also why the verdict is
 * trustworthy under the Windows file sandbox: a piped child dies with `EPERM`
 * there (see `src/host/process.js`) and the check would report a defect that is
 * not in the package.
 *
 * Usage:
 *   npm run pack                    # build the tarball
 *   npm run verify:package          # verify <root>/dsh-project-room-<version>.tgz
 *   node --experimental-vm-modules scripts/verify-package.mjs --tarball <path> --keep
 *
 * The flag is required: `vm.SourceTextModule` (which parses the client half) only
 * exists behind `--experimental-vm-modules`, and a missing parser is reported as
 * "could not run" instead of as a broken package.
 *
 * Exit codes: 0 every check passed · 1 a check failed · 2 the run could not be
 * made (no tarball at that path, or the parser flag was not passed).
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { gunzipSync } from 'node:zlib';

import { checkSyntax } from './check-syntax.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Every tar header, and every padding step, is exactly this many bytes. */
const BLOCK = 512;

/** npm prefixes every tarball entry with the package directory name. */
const PREFIX = 'package/';

/**
 * Name patterns npm ships even when `files` never mentions them.
 *
 * Measured on the pinned toolchain (npm 11.13.0) rather than remembered: a probe
 * package whose `files` was `["a.txt"]` also shipped `README.md`, `LICENSE`,
 * `LICENCE.txt` and its `main`/`bin` targets — but NOT `CHANGELOG.md`,
 * `HISTORY.md` or `NOTICE`, which older npm did include. The allowance is kept to
 * what was observed, and every file it lets through is NAMED in the report, so a
 * tolerated name is visible instead of silently absorbed into the count.
 */
const ALWAYS_INCLUDED_PATTERN = /^(readme|licen[cs]e)(\..*)?$/i;

/**
 * The `files`-independent paths npm always ships, taken from the manifest instead
 * of guessed: `package.json`, plus `main` and every `bin` target.
 * @param {object} manifest
 * @returns {Set<string>}
 */
function alwaysIncluded(manifest) {
  const allowed = new Set(['package.json']);
  const add = (value) => {
    if (typeof value === 'string' && value.trim()) allowed.add(value.replace(/^\.\//, ''));
  };
  add(manifest.main);
  for (const value of Object.values(manifest.bin ?? {})) add(value);
  return allowed;
}

/**
 * Names npm refuses to ship from inside a `files` directory, so the expectation
 * must not demand them either. Kept to the documented always-ignored set rather
 * than guessed at; nothing in this repository matches it today, and a name that
 * did would be visible here instead of as a phantom "missing file".
 */
const ALWAYS_IGNORED = new Set([
  '.DS_Store',
  '.git',
  '.hg',
  '.npmrc',
  '.svn',
  'CVS',
  'node_modules',
  'npm-debug.log',
  'package-lock.json',
]);

/**
 * The paths the packaging contract promises BY NAME. `files` is expanded
 * separately; this list exists so a missing file is reported as that file, not as
 * a line in a diff of two sets.
 */
const REQUIRED_PATHS = [
  'host.js',
  'client.js',
  'client-harness.html',
  'cordis.patch.yml',
  'README.md',
  'README.zh.md',
  'assets/icon.svg',
  'shared/contracts.js',
  'shared/mention-resolver.js',
  'shared/vocabulary.js',
  'src/host/index.js',
  'src/host/process.js',
];

/** The generated section boundary markers, and the chunks that must sit inside. */
const GENERATED = {
  begin: '/* >>> GENERATED: shared rules (scripts/build-client.mjs) >>> */',
  end: '/* <<< GENERATED: shared rules <<< */',
  chunks: ['// ---- shared/vocabulary.js ----', '// ---- shared/mention-resolver.js ----'],
};

/** @type {Array<{ ok: boolean, label: string, detail: string }>} */
const verdicts = [];
/** @type {string[]} */
const failures = [];

/**
 * Runs one named check and records its verdict instead of throwing, so a broken
 * tarball reports everything wrong with it rather than only the first thing.
 * @param {string} label
 * @param {() => unknown | Promise<unknown>} run
 * @returns {Promise<void>}
 */
async function check(label, run) {
  try {
    const detail = await run();
    verdicts.push({ ok: true, label, detail: detail === undefined ? '' : String(detail) });
  } catch (error) {
    verdicts.push({ ok: false, label, detail: error.message });
    failures.push(`${label}: ${error.message}`);
  }
}

/** @returns {void} */
function usage() {
  process.stdout.write(
    'usage: node --experimental-vm-modules scripts/verify-package.mjs [--tarball <path>] [--keep]\n' +
      '  --tarball <path>  verify this tarball instead of <root>/dsh-project-room-<version>.tgz\n' +
      '  --keep            keep the extraction directory even when every check passes\n',
  );
}

/**
 * Decodes one NUL-terminated tar header field.
 * @param {Buffer} block
 * @param {number} start
 * @param {number} end
 * @returns {string}
 */
function field(block, start, end) {
  const raw = block.subarray(start, end);
  const nul = raw.indexOf(0);
  return raw.subarray(0, nul === -1 ? raw.length : nul).toString('utf8').trim();
}

/**
 * Recomputes a header's checksum. A tar reader that cannot tell a header from
 * padding would happily report a truncated archive as complete, and this whole
 * script exists to not do that.
 * @param {Buffer} block
 * @returns {boolean}
 */
function checksumMatches(block) {
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    // The checksum field itself is summed as if it were spaces.
    sum += index >= 148 && index < 156 ? 0x20 : block[index];
  }
  return sum === Number.parseInt(field(block, 148, 156) || '-1', 8);
}

/**
 * Reads the `len key=value\n` records of a PAX extended header. npm's tar writer
 * emits one whenever a name or size does not fit the classic header, so ignoring
 * them would silently skip files on a longer path.
 * @param {string} text
 * @returns {Record<string, string>}
 */
function parsePax(text) {
  /** @type {Record<string, string>} */
  const records = {};
  let offset = 0;
  while (offset < text.length) {
    const space = text.indexOf(' ', offset);
    if (space === -1) break;
    const length = Number(text.slice(offset, space));
    if (!Number.isInteger(length) || length <= 0) break;
    const record = text.slice(space + 1, offset + length).replace(/\n$/, '');
    const equals = record.indexOf('=');
    if (equals !== -1) records[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return records;
}

/**
 * Parses an uncompressed tar archive into its entries.
 *
 * Supports the header shapes npm can emit: ustar names (with `prefix`), a PAX
 * `x` header, and a GNU `L` long name. Directory entries are returned too, so a
 * caller can decide whether their presence is expected.
 *
 * @param {Buffer} buffer
 * @returns {Array<{ path: string, size: number, type: string, directory: boolean, data: Buffer }>}
 */
function readTar(buffer) {
  const entries = [];
  let offset = 0;
  /** @type {Record<string, string> | null} */
  let pax = null;
  /** @type {string | null} */
  let longName = null;

  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    if (!checksumMatches(header)) {
      throw new Error(`tar header at byte ${offset} fails its checksum; the archive is corrupt`);
    }

    const size = Number.parseInt(field(header, 124, 136) || '0', 8) || 0;
    const type = String.fromCharCode(header[156]);
    const body = buffer.subarray(offset + BLOCK, offset + BLOCK + size);
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'x' || type === 'g') {
      pax = { ...(pax ?? {}), ...parsePax(body.toString('utf8')) };
      continue;
    }
    if (type === 'L') {
      longName = body.toString('utf8').replace(/\0+$/, '');
      continue;
    }

    const rawName = field(header, 0, 100);
    const prefix = field(header, 345, 500);
    const path = pax?.path ?? longName ?? (prefix ? `${prefix}/${rawName}` : rawName);
    pax = null;
    longName = null;
    entries.push({ path, size, type, directory: type === '5' || path.endsWith('/'), data: body });
  }

  return entries;
}

/**
 * Expands one `files` entry into concrete repository-relative paths.
 *
 * A directory entry means "everything under it", which is how npm reads it; the
 * walk is done against the repository on purpose, because that is the only way a
 * file that exists but did NOT ship can be noticed.
 *
 * @param {string} entry
 * @returns {string[]}
 */
function expand(entry) {
  const target = join(ROOT, entry);
  const stat = statSync(target);
  if (!stat.isDirectory()) return [entry.replaceAll('\\', '/')];

  const out = [];
  const base = entry.replace(/\/+$/, '');
  for (const child of readdirSync(target, { withFileTypes: true })) {
    const next = `${base}/${child.name}`;
    if (child.isDirectory()) out.push(...expand(next));
    else out.push(next);
  }
  return out;
}

/**
 * The set of paths the manifest promises, plus anything the expansion could not
 * read (a `files` entry naming a path that does not exist).
 * @param {object} manifest
 * @returns {{ promised: Set<string>, problems: string[] }}
 */
function promisedPaths(manifest) {
  const promised = new Set();
  const problems = [];
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0, 'the manifest has no files array');
  for (const entry of manifest.files) {
    try {
      for (const path of expand(entry)) {
        if (path.split('/').some((segment) => ALWAYS_IGNORED.has(segment))) continue;
        promised.add(path);
      }
    } catch (error) {
      problems.push(`${entry}: ${error.code ?? error.message}`);
    }
  }
  return { promised, problems };
}

/**
 * An ESM module is only really shipped if it parses. `vm.SourceTextModule` does
 * the parse without executing anything and without needing imports to resolve.
 * @param {string} file
 * @returns {string} the file's text, so the caller can also inspect it
 */
function parseOnly(file) {
  const text = readFileSync(file, 'utf8');
  new vm.SourceTextModule(text, { identifier: file });
  return text;
}

/* ------------------------------------------------------------------ *
 * Arguments and preconditions
 * ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
/** @type {string | null} */
let tarballOption = null;
let keep = false;
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === '--keep') keep = true;
  else if (arg === '--tarball') {
    const value = argv[index + 1];
    if (value === undefined) {
      process.stderr.write('--tarball needs a path\n');
      process.exit(2);
    }
    tarballOption = value;
    index += 1;
  } else if (arg.startsWith('--tarball=')) tarballOption = arg.slice('--tarball='.length);
  else if (arg === '--help' || arg === '-h') {
    usage();
    process.exit(0);
  } else {
    process.stderr.write(`unknown argument: ${arg}\n`);
    usage();
    process.exit(2);
  }
}

const repoManifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const defaultTarball = `${repoManifest.name}-${repoManifest.version}.tgz`;
const tarballPath = resolve(tarballOption ?? join(ROOT, defaultTarball));

if (tarballOption !== null && tarballOption.trim() === '') {
  process.stderr.write('--tarball needs a path\n');
  process.exit(2);
}
if (!existsSync(tarballPath)) {
  process.stderr.write(
    `no tarball at ${tarballPath}\nBuild it first: npm run pack\n`,
  );
  process.exit(2);
}
if (typeof vm.SourceTextModule !== 'function') {
  process.stderr.write(
    'vm.SourceTextModule is unavailable, so the client half cannot be parsed.\n' +
      'Re-run with the flag the package script uses: node --experimental-vm-modules scripts/verify-package.mjs\n',
  );
  process.exit(2);
}

const bytes = readFileSync(tarballPath);
const digest = createHash('sha256').update(bytes).digest('hex');

/* ------------------------------------------------------------------ *
 * Archive: parse, check the shape, extract
 * ------------------------------------------------------------------ */

/** @type {Array<{ path: string, size: number, type: string, directory: boolean, data: Buffer }>} */
let entries;
let extractRoot = null;
try {
  entries = readTar(gunzipSync(bytes));
  if (entries.length === 0) throw new Error('the archive has no entries');

  // Extraction, not just listing: the import below must run against a real file
  // tree, and a path that escapes the package directory must never be written.
  extractRoot = mkdtempSync(join(tmpdir(), 'dpr-verify-'));
  const packageDir = join(extractRoot, 'package');
  mkdirSync(packageDir, { recursive: true });
  for (const entry of entries) {
    const relativePath = entry.path.startsWith(PREFIX) ? entry.path.slice(PREFIX.length) : null;
    if (relativePath === null || relativePath === '') {
      throw new Error(`entry "${entry.path}" is not under ${PREFIX}; the tarball is not a package archive`);
    }
    if (relativePath.split('/').includes('..') || /^[a-zA-Z]:/.test(relativePath)) {
      throw new Error(`entry "${entry.path}" escapes the package directory`);
    }
    const target = join(packageDir, relativePath);
    if (entry.directory) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.data);
  }
} catch (error) {
  process.stderr.write(`✖ the tarball could not be read: ${error.message}\n`);
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * Checks
 * ------------------------------------------------------------------ */

const pkgDir = join(extractRoot, 'package');
const shipped = new Set(entries.filter((entry) => !entry.directory).map((entry) => entry.path.slice(PREFIX.length)));
const shippedBytes = entries.reduce((total, entry) => total + entry.size, 0);

await check('archive is a well-formed gzip tar of regular files', () => {
  const directories = entries.filter((entry) => entry.directory).map((entry) => entry.path);
  assert.deepEqual(directories, [], 'npm packs files, not directory entries');
  const odd = entries.filter((entry) => entry.type !== '0' && entry.type !== '\0').map((entry) => `${entry.path} (type ${entry.type})`);
  assert.deepEqual(odd, [], 'only regular files are expected in a package tarball');
  return `${entries.length} entry/entries, ${shippedBytes} bytes unpacked`;
});

await check('every entry sits under package/ and none escapes it', () => {
  for (const entry of entries) {
    assert.ok(entry.path.startsWith(PREFIX), `${entry.path} is not under ${PREFIX}`);
    const relativePath = entry.path.slice(PREFIX.length);
    assert.ok(!relativePath.split('/').includes('..'), `${entry.path} escapes the package root`);
  }
  return `prefix ${PREFIX}, no ".." segments, no absolute paths`;
});

/** @type {any} */
let packagedManifest;
try {
  packagedManifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
} catch (error) {
  // Not routed through `check()`: without a manifest there is nothing to compare
  // against, and a raw stack trace would read like a bug in this script.
  process.stderr.write(`✖ the extracted package has no readable package.json: ${error.message}\n`);
  process.exit(1);
}
const { promised, problems } = promisedPaths(repoManifest);

await check("the manifest's files array resolves", () => {
  assert.deepEqual(problems, [], 'files names a path that cannot be read');
  return `${repoManifest.files.length} entries → ${promised.size} promised file(s)`;
});

await check('the tarball is missing nothing the manifest promises', () => {
  const missing = [...promised].filter((path) => !shipped.has(path)).sort();
  assert.deepEqual(missing, [], 'the manifest promises files the tarball does not contain');
  return `${promised.size} promised file(s) all present`;
});

await check('the tarball contains nothing the manifest does not promise', () => {
  const allowed = alwaysIncluded(repoManifest);
  const exempt = (path) => allowed.has(path) || ALWAYS_INCLUDED_PATTERN.test(path);
  const stray = [...shipped].filter((path) => !promised.has(path) && !exempt(path)).sort();
  assert.deepEqual(stray, [], 'the tarball carries files no manifest entry accounts for');
  const tolerated = [...shipped].filter((path) => !promised.has(path) && exempt(path)).sort();
  return `${shipped.size} shipped file(s), all accounted for${
    tolerated.length > 0 ? ` (npm always includes: ${tolerated.join(', ')})` : ''
  }`;
});

await check('the named promises exist in the extracted package', () => {
  for (const path of REQUIRED_PATHS) {
    assert.ok(existsSync(join(pkgDir, path)), `${path} is absent from the extracted package`);
  }
  return `${REQUIRED_PATHS.length} named path(s) present`;
});

await check('the packaged package.json keeps the fields the loader reads', () => {
  assert.deepEqual(packagedManifest.files, repoManifest.files, 'the packaged files array drifted from the repository');
  assert.equal(packagedManifest.name, 'dsh-project-room');
  assert.equal(packagedManifest.version, repoManifest.version, 'the packaged version drifted from the repository');
  assert.equal(
    tarballPath.endsWith(`${repoManifest.name}-${packagedManifest.version}.tgz`),
    true,
    `the tarball should be named ${repoManifest.name}-${packagedManifest.version}.tgz`,
  );
  assert.equal(packagedManifest.type, 'module');
  assert.equal(packagedManifest.icon, './assets/icon.svg');
  assert.equal(packagedManifest.exports?.['.'], './host.js');
  assert.equal(packagedManifest.exports?.['./client'], './client.js');
  assert.equal(packagedManifest.dsh?.manifestVersion, 1, 'the dsh block must survive packing');
  assert.equal(packagedManifest.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.equal(packagedManifest.dsh?.client?.platform, 'web');
  return `version ${packagedManifest.version}, dsh.manifestVersion 1, bundle patch ./cordis.patch.yml`;
});

await check('installation needs no toolchain and no network', () => {
  assert.equal(packagedManifest.dependencies, undefined, 'a runtime dependency would need an install step');
  assert.equal(packagedManifest.devDependencies, undefined);
  const peers = Object.keys(packagedManifest.peerDependencies ?? {});
  for (const peer of peers) {
    // npm tries to fetch a non-optional peer; every host package here is provided
    // by the profile at runtime and must stay advisory.
    assert.equal(
      packagedManifest.peerDependenciesMeta?.[peer]?.optional,
      true,
      `${peer} must be an optional peer or npm will try to resolve it during install`,
    );
  }
  assert.ok(!shipped.has('node_modules'), 'a vendored node_modules would defeat the install-free promise');
  return `0 dependencies, ${peers.length} optional peer(s)`;
});

await check('cordis.patch.yml is present and inserts a row naming this package', () => {
  const patch = readFileSync(join(pkgDir, 'cordis.patch.yml'), 'utf8');
  assert.ok(patch.trim().length > 0, 'the patch is empty');
  // A bare `- id:` targets an EXISTING row and silently loads nothing, which is
  // exactly the failure a previous checkpoint had to hunt down.
  assert.match(patch, /-\s*insert:/, 'the patch must INSERT a row');
  assert.match(patch, /name:\s*'?dsh-project-room'?/, 'the inserted row must name this package');
  return `${patch.trim().split(/\r?\n/).length} line(s)`;
});

await check('the extracted host.js imports and exposes the plugin contract', async () => {
  // Imported from the EXTRACTED location: a relative import that only resolves in
  // the repository would fail here, which is the point.
  const host = await import(pathToFileURL(join(pkgDir, 'host.js')).href);
  assert.equal(host.name, 'project-room');
  assert.equal(typeof host.apply, 'function');
  assert.ok(Array.isArray(host.inject) && host.inject.length > 0, 'inject must be a non-empty array');
  assert.equal(typeof host.Config, 'object');
  assert.equal(host.Config?.['~standard']?.version, 1);
  assert.equal(typeof host.Config?.['~standard']?.validate, 'function');
  // A validator, not a placeholder: `undefined` must default and a non-object must
  // be refused by the contract the loader calls.
  const defaults = host.Config['~standard'].validate(undefined);
  assert.equal(typeof defaults?.value, 'object', 'validate(undefined) must return the defaults');
  assert.ok(Array.isArray(host.Config['~standard'].validate('nope')?.issues), 'validate("nope") must report issues');
  return `name=${host.name}, inject=[${host.inject.join(', ')}], Config defaults ok`;
});

await check('the extracted client.js parses and keeps its generated section', () => {
  const text = parseOnly(join(pkgDir, 'client.js'));
  const begin = text.indexOf(GENERATED.begin);
  const end = text.indexOf(GENERATED.end);
  assert.ok(begin !== -1, 'the >>> GENERATED: shared rules marker is gone');
  assert.ok(end > begin, 'the generated section is not closed');
  for (const chunk of GENERATED.chunks) {
    assert.ok(text.includes(chunk), `${chunk} is missing from the inlined section`);
  }
  assert.match(text, /__ModuleLoader__\.load\(/, 'the client half must still self-register');
  return `parsed ${text.length} chars, generated section ${end - begin} chars, ${GENERATED.chunks.length} chunk(s) inlined`;
});

await check('no shipped file imports a @deepseek-ai package', () => {
  // The established rule lives in check-syntax.mjs; reusing it here means the
  // tarball is held to exactly the rule the repository gate enforces.
  const { targets, failures: issues, available } = checkSyntax({ root: pkgDir });
  assert.equal(available, true, 'the parser was unavailable');
  assert.deepEqual(issues, [], 'a shipped file imports a host package');
  const javascript = entries.filter((entry) => /\.m?js$/.test(entry.path) && !entry.directory);
  assert.equal(
    targets.length,
    javascript.length,
    `${javascript.length} javascript file(s) shipped but only ${targets.length} were checked`,
  );
  return `${targets.length} javascript file(s) parsed, 0 host-package imports`;
});

await check('the shipped bytes are the bytes in the working tree', () => {
  // Without this check the verifier only proves the ARCHIVE is self-consistent, so a
  // tarball packed before the latest edits passes while shipping stale code. That
  // happened once during development. Comparing per-file digests closes it: every
  // shipped file must still match the repository it claims to be a build of.
  const drifted = [];
  for (const relative of [...shipped].sort()) {
    const inTree = join(ROOT, relative);
    if (!existsSync(inTree)) {
      drifted.push(`${relative} (in the tarball, gone from the tree)`);
      continue;
    }
    const treeHash = createHash('sha256').update(readFileSync(inTree)).digest('hex');
    const tarHash = createHash('sha256').update(readFileSync(join(pkgDir, relative))).digest('hex');
    if (treeHash !== tarHash) drifted.push(`${relative} (content differs)`);
  }
  assert.deepEqual(drifted, [], `the tarball is stale; re-run \`npm run pack\`:\n  ${drifted.join('\n  ')}`);
  return `${shipped.size} shipped file(s) match the tree byte for byte`;
});

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

process.stdout.write(`tarball : ${tarballPath}\n`);
process.stdout.write(`bytes   : ${bytes.length}\n`);
process.stdout.write(`sha256  : ${digest}\n`);
process.stdout.write(`entries : ${shipped.size} file(s), ${shippedBytes} bytes unpacked\n`);
for (const { ok, label, detail } of verdicts) {
  process.stdout.write(`${ok ? '✔' : '✖'} ${label}${detail ? ` — ${detail}` : ''}\n`);
}

if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} of ${verdicts.length} check(s) failed:\n`);
  for (const failure of failures) process.stderr.write(`  ✖ ${failure}\n`);
  // Kept on purpose: the fastest way to explain a failure is to read the tree
  // that produced it.
  process.stderr.write(`\nextracted package kept for inspection: ${pkgDir}\n`);
  process.exit(1);
}

if (keep) process.stdout.write(`\nextracted package kept: ${pkgDir}\n`);
else rmSync(extractRoot, { recursive: true, force: true });

process.stdout.write(`\nPACKAGE VERIFIED — ${verdicts.length} check(s) passed, ${shipped.size} file(s).\n`);
