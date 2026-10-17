/**
 * Generates the browser half's shared-rule section.
 *
 * The mention parser MUST be identical on both sides — one rule, one implementation
 * preview and server use one library and one rule version. The browser half is a
 * classic script whose module table is CLOSED: `require.async` cannot fetch a
 * package-local chunk that is not a boot-graph row, so registering extra chunks
 * fails the bundle purity gate and the whole page reports "Failed to load
 * plugins". That failure was observed in a real host, which is why this generator
 * INLINES `shared/*.js` into `client.js` between two markers instead:
 *
 *   - dependencies are ordered by a topological sort of the relative imports;
 *   - `import … from './x.js'` statements are dropped, because the inlined modules
 *     share one flat scope;
 *   - the `export ` keyword is stripped, and a duplicate top-level name is a build
 *     error rather than a silent shadow;
 *   - an explicit export map is emitted, so a renamed or deleted definition fails
 *     the build instead of becoming an `undefined` at runtime.
 *
 * The result: `client.js` stays ONE classic script with no extra requests, and
 * editing `shared/` without rebuilding is caught by `npm run check`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLIENT = join(ROOT, 'client.js');
const BEGIN = '/* >>> GENERATED: shared rules (scripts/build-client.mjs) >>> */';
const END = '/* <<< GENERATED: shared rules <<< */';

/** Modules to inline, entry points last. */
const MODULES = ['shared/vocabulary.js', 'shared/mention-resolver.js'];

/** Names the client half consumes, grouped as the client names them. */
const EXPORTS = {
  V: [
    'ROUTE',
    'ROLE_TEMPLATES',
    'DELIVERY_LABELS',
    'TASK_STATUS_LABELS',
    'MEMBER_STATUS_LABELS',
    'ERROR_LABELS',
    'PROJECT_LIFECYCLE_LABELS',
    'roleTemplate',
    'deliveryLabel',
    'taskLabel',
    'memberLabel',
  ],
  M: ['MentionResolver', 'mergeMentions', 'segmentsForDisplay', 'stripMentionSyntax', 'extractAtTokens', 'maskBody'],
};

/**
 * Resolve the modules in dependency order.
 * @returns {Array<{ file: string, source: string }>}
 */
function orderedModules() {
  const sources = new Map();
  for (const relativePath of MODULES) sources.set(relativePath, readFileSync(join(ROOT, relativePath), 'utf8'));

  /** @type {Array<{ file: string, source: string }>} */
  const order = [];
  const seen = new Set();

  const visit = (modulePath, chain) => {
    if (seen.has(modulePath)) return;
    if (chain.includes(modulePath)) throw new Error(`shared module cycle: ${[...chain, modulePath].join(' -> ')}`);
    const source = sources.get(modulePath);
    if (source === undefined) throw new Error(`unknown shared module: ${modulePath}`);
    for (const match of source.matchAll(/^import\s+[^;]*from\s+'(\.[^']+)';$/gm)) {
      const dependency = relative(ROOT, resolve(join(ROOT, modulePath), '..', match[1])).replace(/\\/g, '/');
      if (!sources.has(dependency)) throw new Error(`${modulePath} imports ${match[1]}, which is not listed in MODULES`);
      visit(dependency, [...chain, modulePath]);
    }
    seen.add(modulePath);
    order.push({ file: modulePath, source });
  };

  for (const modulePath of MODULES) visit(modulePath, []);
  return order;
}

/** Build the generated section body. */
function generate() {
  const parts = [
    BEGIN,
    '// Inlined from shared/ so the browser half is ONE classic script. The client module',
    '// table is closed, so a package-local chunk cannot be fetched at runtime.',
  ];
  const declared = new Map();

  for (const { file, source } of orderedModules()) {
    let text = source;
    // A relative import is already satisfied by the shared scope; drop it.
    text = text.replace(/^import\s+[^;]*from\s+'\.[^']+';$/gm, '');
    if (/^import\s/m.test(text)) throw new Error(`${file}: an import form this generator does not handle`);

    for (const match of text.matchAll(/^export\s+(?:const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm)) {
      if (declared.has(match[1])) {
        throw new Error(`${file}: "${match[1]}" is already declared by ${declared.get(match[1])} in the shared scope`);
      }
      declared.set(match[1], file);
    }
    text = text.replace(/^export\s+(?=(?:const|let|var|function|class|async))/gm, '');
    if (/^\s*export\s/m.test(text)) throw new Error(`${file}: an export form this generator does not handle`);

    parts.push(`// ---- ${file} ----`);
    parts.push(text.trim());
    parts.push('');
  }

  for (const [group, names] of Object.entries(EXPORTS)) {
    const missing = names.filter((name) => !declared.has(name));
    if (missing.length > 0) throw new Error(`${group}: ${missing.join(', ')} not found in the inlined shared scope`);
  }

  parts.push(`const V = { ${EXPORTS.V.join(', ')} };`);
  parts.push(`const M = { ${EXPORTS.M.join(', ')} };`);
  parts.push(END);
  return parts.join('\n');
}

/**
 * Compares the on-disk generated section with what `generate()` would write.
 *
 * Exported so the activation-contract test can assert staleness in-process. The
 * earlier version of that test spawned `node scripts/build-client.mjs --check`,
 * which the DSH Windows file sandbox denies with `EPERM` (no named pipes) — the
 * test then failed for a reason that had nothing to do with the plugin.
 *
 * @returns {{ stale: boolean, current: string, next: string }}
 */
export function checkGenerated({ client = CLIENT } = {}) {
  const source = readFileSync(client, 'utf8');
  const begin = source.indexOf(BEGIN);
  const end = source.indexOf(END);
  if (begin < 0 || end < 0 || end < begin) {
    throw new Error(`client.js is missing the generated markers:\n  ${BEGIN}\n  ${END}`);
  }
  const body = generate();
  const next = source.slice(0, begin) + body + source.slice(end + END.length);
  return { stale: next !== source, current: source, next };
}

/**
 * CLI entry. When this file is imported (the test does) nothing below runs.
 * @returns {void}
 */
function main() {
  const { stale } = checkGenerated();
  if (!stale) {
    process.stdout.write('· client.js shared section is up to date\n');
    return;
  }
  if (process.argv.includes('--check')) {
    process.stderr.write('✖ client.js shared section is stale; run `node scripts/build-client.mjs`\n');
    process.exit(1);
  }
  writeFileSync(CLIENT, checkGenerated().next, 'utf8');
  process.stdout.write('✔ client.js shared section regenerated\n');
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) main();

