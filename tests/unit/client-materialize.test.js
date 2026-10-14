/**
 * Client-half materialization tests.
 *
 * The client half is a classic script: it registers a factory with
 * `window.__ModuleLoader__.load({ id, factory })`, and the browser module system
 * calls `factory(require)` to materialize it. That contract is small enough to
 * honour exactly in Node, which is worth doing because the alternative is
 * "discover it in the browser", and the last time this file was wrong the whole
 * page reported "Failed to load plugins".
 *
 * What this proves without a browser:
 *
 *   - the script registers exactly ONE module under the plugin's package name;
 *   - `factory(require)` returns exports whose `apply` and `inject` exist;
 *   - the generated shared-rule section is really in scope, so `apply` can build
 *     the mention resolver and the label tables;
 *   - `apply(ctx)` registers the two slots the panel needs, and nothing else;
 *   - the factory needs ONLY `react` and `react/jsx-runtime` — the module table is
 *     closed, so any other `require` is a hard failure.
 *
 * What it cannot prove (listed honestly in the compatibility report): that the
 * slots render, that the styles look right, and that the interaction feels
 * correct. Those need a real page.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import vm from 'node:vm';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLIENT = join(ROOT, 'client.js');

/**
 * Minimal React stand-in.
 *
 * Only the surface the client half touches at MATERIALIZATION time is needed:
 * the factory destructures hooks but must not call them until a component
 * renders. A `Proxy` that returns a harmless function for anything makes that
 * explicit rather than accidental.
 */
function reactStub() {
  const anything = new Proxy(function noop() {}, {
    get: (_target, property) => (property === 'then' ? undefined : anything),
    apply: () => undefined,
  });
  return new Proxy(
    {},
    {
      get: (_target, property) => {
        if (property === '__esModule') return true;
        return anything;
      },
    },
  );
}

/**
 * Load and materialize the client half.
 *
 * @returns {{
 *   registrations: Array<{ id: string, chunk?: string }>,
 *   exports: Record<string, unknown>,
 *   requested: string[],
 *   applied: Array<{ name: string, id?: string, key?: string }>,
 *   injections: string[],
 * }}
 */
function materializeClient() {
  const source = readFileSync(CLIENT, 'utf8');
  /** @type {Array<{ id: string, chunk?: string, factory: Function }>} */
  const registrations = [];
  const requested = [];
  const applied = [];
  const injections = [];

  const window = {
    __ModuleLoader__: {
      load(registration) {
        registrations.push(registration);
      },
    },
    addEventListener() {},
    removeEventListener() {},
    confirm: () => false,
    dispatchEvent: () => true,
    innerHeight: 900,
    innerWidth: 1440,
  };

  const require = (specifier) => {
    requested.push(specifier);
    if (specifier === 'react' || specifier === 'react/jsx-runtime') return reactStub();
    throw new Error(`the client module table is closed; unexpected require("${specifier}")`);
  };

  const context = vm.createContext({ window, document: { visibilityState: 'visible' }, console, fetch: async () => ({ ok: true, json: async () => ({ ok: true, data: {} }) }), setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame: (fn) => fn() });
  vm.runInContext(source, context, { filename: 'client.js' });

  assert.equal(registrations.length, 1, 'the classic script must register exactly one module');
  const registration = registrations[0];
  assert.equal(registration.id, 'dsh-project-room', 'the registration id must be the package name');
  assert.equal(registration.chunk, undefined, 'a chunk registration would need a fetch the closed table forbids');
  assert.equal(typeof registration.factory, 'function');

  const exports = registration.factory(require);

  // Run `apply` against a recording context to see exactly what it registers.
  const ctx = {
    slots: {
      inject(key, callback) {
        injections.push(key);
        return callback();
      },
      register(config, component) {
        applied.push({ name: config.name, id: config.id, key: config.key, hasComponent: typeof component === 'function' });
        return () => {};
      },
    },
  };
  exports.apply(ctx);

  return { registrations, exports, requested, applied, injections };
}

describe('client half — module materialization', () => {
  it('registers one module and materializes without a browser', () => {
    const { exports } = materializeClient();
    assert.equal(typeof exports.apply, 'function', 'the loader calls exports.apply');
    assert.ok(Array.isArray(exports.inject), 'the loader reads exports.inject');
    assert.ok(exports.__internals, 'the verification surface must remain available');
  });

  it('requires only the two baseline modules', () => {
    const { requested } = materializeClient();
    for (const specifier of requested) {
      assert.ok(
        specifier === 'react' || specifier === 'react/jsx-runtime',
        `"${specifier}" is not in the closed module table; the page would fail to load plugins`,
      );
    }
  });

  it('never asks the module table for a package-local chunk', () => {
    const source = readFileSync(CLIENT, 'utf8');
    assert.equal(/dsh-project-room#/.test(source), false);
    assert.equal(source.includes('require.async'), false);
  });

  it('registers the sidebar entry and the main panel, and nothing else', () => {
    const { applied, injections } = materializeClient();
    assert.deepEqual(
      applied.map((entry) => `${entry.name}:${entry.id ?? entry.key}`).sort(),
      ['main:project-room', 'sidebar.panellist:project-room'],
    );
    for (const entry of applied) {
      assert.equal(entry.hasComponent, true, `${entry.name} must be given a component`);
    }
    assert.deepEqual(injections.sort(), ['main', 'sidebar.panellist']);
  });

  it('exposes the shared rules inside the client scope, so both halves agree', () => {
    const { exports } = materializeClient();
    const internals = exports.__internals;
    // `post` and `avatarFor` are the two helpers that would silently diverge if
    // the shared section were missing; `post` also proves ROUTE is in scope.
    assert.equal(typeof internals.post, 'function');
    assert.equal(typeof internals.avatarFor, 'function');
    assert.equal(typeof internals.toneOf, 'function');
    assert.ok(internals.CSS.includes('dpr_root'), 'the stylesheet must be present');
  });
});
