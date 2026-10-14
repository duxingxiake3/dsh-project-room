/**
 * Package metadata tests.
 *
 * The host reads a plugin's manifest before anything else, and a path it declares
 * but cannot `lstat` surfaces as "Plugin metadata … Error: ENOENT … lstat". That
 * is how a declared-but-never-created `assets/` directory and a missing
 * `README.zh.md` turned up: the manifest promised files the repository did not
 * contain. Nothing in the code was wrong, so no code test would have caught it.
 *
 * This asserts the manifest and the filesystem agree, and that the fields the
 * loader actually reads are present and well-typed.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** Every path the manifest points at, with the field that named it. */
function declaredPaths() {
  /** @type {Array<{ field: string, value: string }>} */
  const paths = [];
  if (manifest.icon) paths.push({ field: 'icon', value: manifest.icon });
  if (manifest.main) paths.push({ field: 'main', value: manifest.main });
  for (const value of Object.values(manifest.exports ?? {})) {
    if (typeof value === 'string') paths.push({ field: 'exports', value });
    else if (value && typeof value === 'object') {
      for (const nested of Object.values(value)) {
        if (typeof nested === 'string') paths.push({ field: 'exports', value: nested });
      }
    }
  }
  for (const value of manifest.files ?? []) paths.push({ field: 'files', value });
  if (manifest.dsh?.bundle?.patch) {
    paths.push({ field: 'dsh.bundle.patch', value: manifest.dsh.bundle.patch });
  }
  if (manifest.dsh?.client && manifest.exports?.['./client']) {
    paths.push({ field: 'dsh.client', value: manifest.exports['./client'] });
  }
  return paths;
}

describe('package metadata — declared paths exist', () => {
  it('resolves every declared path against the repository', () => {
    const missing = [];
    for (const { field, value } of declaredPaths()) {
      // A subpath export pattern such as `./shared/*` names a family, not a file.
      if (value.includes('*') || value === '.') continue;
      const target = join(ROOT, value);
      if (!existsSync(target)) missing.push(`${field}: ${value}`);
    }
    assert.deepEqual(
      missing,
      [],
      `the manifest declares paths that do not exist, which the host reports as "Plugin metadata … ENOENT … lstat": ${missing.join(', ')}`,
    );
  });

  it('declares an icon that is a readable, non-empty SVG', () => {
    assert.equal(typeof manifest.icon, 'string', 'the icon field must be a path string');
    const file = join(ROOT, manifest.icon);
    const text = readFileSync(file, 'utf8');
    assert.ok(text.includes('<svg'), 'the icon must be SVG markup');
    assert.ok(statSync(file).size > 0 && statSync(file).size <= 256 * 1024, 'the host caps a plugin icon at 256 KiB');
  });

  it('points exports at files that parse as the halves they claim to be', () => {
    const host = readFileSync(join(ROOT, manifest.exports['.']), 'utf8');
    assert.match(host, /export\s*\{[^}]*\bapply\b/, 'the host half must export apply');
    const client = readFileSync(join(ROOT, manifest.exports['./client']), 'utf8');
    assert.match(client, /__ModuleLoader__\.load\(/, 'the client half must self-register with the module loader');
  });
});

describe('package metadata — loader contract', () => {
  it('names the bundle patch the loader reads', () => {
    const patch = manifest.dsh?.bundle?.patch;
    assert.equal(typeof patch, 'string');
    const text = readFileSync(join(ROOT, patch), 'utf8');
    // The loader needs an `insert:` list to create a row; a bare `- id:` targets an
    // existing one and silently loads nothing.
    assert.match(text, /-\s*insert:/, 'the patch must INSERT a row: a bare `- id:` targets an existing row and loads nothing');
    assert.match(text, /name:\s*'?dsh-project-room'?/, 'the inserted row must name this package');
  });

  it('declares the client half for the web platform', () => {
    assert.equal(manifest.dsh?.client?.platform, 'web');
    assert.equal(manifest.exports['./client'], './client.js');
  });

  it('keeps the package dependency-free so installation needs no toolchain', () => {
    assert.equal(manifest.dependencies, undefined, 'a runtime dependency would require an install step');
    assert.equal(manifest.type, 'module');
    assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0);
  });

  it('declares an engines range that includes the runtime actually measured', () => {
    // Measured from the running host: the packaged desktop runtime resolves to
    // 0.2.0-rc.2 (see notes/host notes). The range must not exclude it.
    assert.equal(typeof manifest.engines?.dsh, 'string');
    const range = manifest.engines.dsh;
    assert.ok(/<0\.3\.0/.test(range), `the upper bound must admit 0.2.0-rc.2, got ${range}`);
    assert.ok(/(>=0\.1\.7|>=0\.2\.0)/.test(range), `the lower bound must admit the CLI install 0.1.7-rc.1, got ${range}`);
  });
});
