/**
 * Activation contract tests.
 *
 * These guard the two failures that actually took the host down during
 * development. Both were invisible to unit tests and to `node --check`, and both
 * were only found by booting a real framework composition — so they are asserted
 * here in the cheapest form that would have caught them.
 *
 *   1. **`inject` is mandatory.** Cordis proxies `ctx.<service>` and throws
 *      `cannot get property "tools" without inject` when a plugin reads a service
 *      it did not declare. Reading `ctx.tools` therefore aborted `apply()` at the
 *      tool-registration step and the plugin never activated at all.
 *
 *   2. **The client module table is closed.** The browser half is one classic
 *      script; `require.async('dsh-project-room#…')` cannot resolve a
 *      package-local chunk that is not a boot-graph row, so the whole page
 *      reported "Failed to load plugins". The shared rules are now inlined into
 *      `client.js` by `scripts/build-client.mjs`, and this test fails if the
 *      generated section is stale or if a chunk reference comes back.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Import the plugin entry the way the loader does.
 *
 * On Windows a dynamic `import()` needs a real `file://` URL — a bare absolute
 * path fails with `ERR_UNSUPPORTED_ESM_URL_SCHEME`, which is a test-harness
 * mistake rather than a plugin defect, so it must not look like one.
 * @returns {Promise<object>}
 */
function loadPlugin() {
  return import(pathToFileURL(join(ROOT, 'host.js')).href);
}

/** The Cordis service keys `apply` reads off `ctx`. */
const SERVICES_READ = ['tools', 'webServer', 'agents', 'llm', 'systemPrompt'];

describe('activation contract — Cordis inject declaration', () => {
  it('declares every service that apply() reads off ctx', async () => {
    const plugin = await loadPlugin();
    assert.equal(plugin.name, 'project-room');
    assert.ok(Array.isArray(plugin.inject), 'the plugin must export an inject array; without it, reading ctx.tools throws');

    const source = readFileSync(join(ROOT, 'src', 'host', 'index.js'), 'utf8');
    for (const service of SERVICES_READ) {
      // Two ways apply may legitimately touch a service: the proxy `ctx.<name>`
      // or the guarded lookup `ctx.get('<name>')`. Both require the declaration.
      const viaProxy = new RegExp(`ctx\\.${service}\\b`).test(source);
      const viaGet = new RegExp(`ctx\\.get\\(['"]${service}['"]\\)`).test(source);
      if (!viaProxy && !viaGet) continue;
      assert.ok(
        plugin.inject.includes(service),
        `apply() uses ctx.${service} but "inject" does not declare it: Cordis will throw "cannot get property \\"${service}\\" without inject" and the plugin will not activate`,
      );
    }
  });

  it('names only services the plugin genuinely needs, so activation is not blocked needlessly', async () => {
    const plugin = await loadPlugin();
    // A service in this list must be one the plugin cannot do its job without.
    const allowed = new Set(['tools', 'webServer', 'agents', 'llm', 'systemPrompt']);
    for (const service of plugin.inject) {
      assert.ok(allowed.has(service), `"${service}" is injected but nothing in the design requires it as a hard dependency`);
    }
  });

  it('accepts an empty configuration and normalizes it', async () => {
    const plugin = await loadPlugin();
    const result = plugin.Config['~standard'].validate({});
    assert.equal(result.issues, undefined, 'the default configuration must validate');
    assert.equal(typeof result.value.maxAutomaticRounds, 'number');
    assert.equal(result.value.httpRoute, true);
  });

  it('refuses a configuration that would silently disable collaboration', async () => {
    const plugin = await loadPlugin();
    const result = plugin.Config['~standard'].validate({ maxAutomaticRounds: 0 });
    assert.ok(Array.isArray(result.issues) && result.issues.length > 0, 'a zero round budget must be reported, not accepted');
  });
});

describe('activation contract — client half stays one classic script', () => {
  const client = readFileSync(join(ROOT, 'client.js'), 'utf8');

  it('registers exactly one module, with no package-local chunk reference', () => {
    assert.match(client, /window\.__ModuleLoader__\.load\(\{/);
    assert.equal(
      client.includes('require.async('),
      false,
      'the client module table is closed: require.async cannot resolve a package-local chunk and the page fails to load plugins',
    );
    assert.equal(
      /dsh-project-room#/.test(client),
      false,
      'no "#chunk" specifier may appear: shared rules are inlined instead',
    );
  });

  it('inlines the shared rules, so preview and server run the same parser', () => {
    assert.match(client, />>> GENERATED: shared rules/);
    for (const name of ['MentionResolver', 'mergeMentions', 'extractAtTokens', 'maskBody', 'ROLE_TEMPLATES', 'DELIVERY_LABELS']) {
      assert.ok(
        new RegExp(`(function|const|class)\\s+${name}\\b`).test(client),
        `the generated section must define ${name}`,
      );
    }
  });

  it('has an up-to-date generated section', () => {
    const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-client.mjs'), '--check'], { encoding: 'utf8' });
    assert.equal(
      result.status,
      0,
      `client.js shared section is stale — run \`node scripts/build-client.mjs\`. Output: ${result.stdout}${result.stderr}`,
    );
  });

  it('parses as a classic script', () => {
    const result = spawnSync(process.execPath, ['--check', join(ROOT, 'client.js')], { encoding: 'utf8' });
    assert.equal(result.status, 0, `client.js does not parse: ${result.stderr}`);
  });
});

describe('activation contract — the package stays install-free', () => {
  it('imports no @deepseek-ai package anywhere in the plugin', () => {
    const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'check-syntax.mjs')], { encoding: 'utf8' });
    assert.equal(result.status, 0, `a host package import would break installation: ${result.stdout}${result.stderr}`);
  });
});
