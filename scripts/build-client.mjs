/**
 * Generates the browser halves of the shared modules.
 *
 * The mention parser MUST be identical on both sides — the design notes rule 11 says
 * preview and server use one library and one rule version. The browser half is a
 * classic script with no bundler and a closed module table, so it cannot import
 * the ESM source directly. Duplicating the file by hand would guarantee drift;
 * this small generator instead emits a chunk from the single source of truth on
 * every `npm run build`, and `npm run check` fails if the output is stale.
 *
 * What it does, in order, per module:
 *   1. strips the `import … from './x.js'` lines and rewrites them into
 *      destructuring from the `__deps` parameter the chunk factory receives;
 *   2. replaces the `export ` keyword on declarations;
 *   3. returns an explicit export map, so a forgotten export is a build error
 *      rather than a `undefined` at runtime;
 *   4. wraps everything in the `window.__ModuleLoader__.load({...})` form the
 *      client module system expects, with a banner marking it generated.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** One generated chunk: source module, output file, chunk name, and its deps. */
const TARGETS = [
  {
    source: 'shared/vocabulary.js',
    output: 'client.vocabulary.js',
    chunk: 'vocabulary',
    deps: [],
    exports: [
      'AT_SIGN',
      'AT_SIGN_FULL_WIDTH',
      'ROUTE',
      'ENVELOPE_PROTOCOL',
      'TIME_FORMAT',
      'ACTION_PREFIX',
      'DELIVERY_LABELS',
      'TASK_STATUS_LABELS',
      'TASK_TRANSITIONS',
      'MEMBER_STATUS_LABELS',
      'ROLE_TEMPLATES',
      'ERROR_LABELS',
      'roleTemplate',
      'canTransition',
      'isoTimestamp',
      'deliveryLabel',
      'taskLabel',
      'memberLabel',
    ],
  },
  {
    source: 'shared/mention-resolver.js',
    output: 'client.mention-resolver.js',
    chunk: 'mention-resolver',
    deps: [{ chunk: 'vocabulary', from: './vocabulary.js', names: ['AT_SIGN', 'AT_SIGN_FULL_WIDTH'] }],
    exports: [
      'EVERYONE_KEYWORDS',
      'HUMAN_KEYWORDS',
      'normalizeName',
      'foldAscii',
      'sameName',
      'maskBody',
      'extractAtTokens',
      'MentionResolver',
      'mergeMentions',
      'segmentsForDisplay',
      'stripMentionSyntax',
    ],
  },
];

/**
 * Rewrite one ESM module into a chunk factory body.
 * @param {object} target
 * @returns {string}
 */
function generate(target) {
  const file = join(ROOT, target.source);
  let text = readFileSync(file, 'utf8');

  const importLines = [...text.matchAll(/^import\s+[^;]+;$/gm)];
  const imports = importLines.map((match) => {
    const names = /import\s+\{([^}]+)\}/.exec(match[0]);
    if (!names) throw new Error(`${target.source}: only named imports are supported (${match[0]})`);
    return names[1]
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
      .join(', ');
  });
  text = text.replace(/^import\s+[^;]+;$/gm, '');

  const declaredImports = new Set(target.deps.flatMap((dependency) => dependency.names));
  for (const importNames of imports) {
    for (const name of importNames.split(',').map((entry) => entry.trim())) {
      if (!declaredImports.has(name)) {
        throw new Error(`${target.source}: imports ${name}, which is not declared in the generator's deps`);
      }
    }
  }

  text = text.replace(/^export\s+(?=(const|let|var|function|class|async))/gm, '');
  if (/^\s*export\s/m.test(text)) {
    throw new Error(`${target.source}: an export form this generator does not handle is still present`);
  }

  for (const name of target.exports) {
    const declared =
      new RegExp(`^(const|let|var|function|class)\\s+${name}\\b`, 'm').test(text) ||
      new RegExp(`^\\s*${name}\\s*[:,]`, 'm').test(text);
    if (!declared) throw new Error(`${target.source}: declared export ${name} was not found`);
  }

  const banner =
    `/**\n` +
    ` * GENERATED FILE — do not edit.\n` +
    ` *\n` +
    ` * Browser half of ${target.source}, emitted by scripts/build-client.mjs so\n` +
    ` * both halves run the same rules (the design notes rule 11). Edit the source module\n` +
    ` * and run \`node scripts/build-client.mjs\`.\n` +
    ` */\n`;

  return (
    banner +
    `window.__ModuleLoader__.load({\n` +
    `  id: 'dsh-project-room#${target.chunk}',\n` +
    `  chunk: '${target.output}',\n` +
    `  factory: (require) => {\n` +
    `    const module = { exports: {} };\n` +
    `    const exports = module.exports;\n` +
    `    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });\n\n` +
    `    const __deps = { ${target.deps.map((dependency) => `...require('dsh-project-room#${dependency.chunk}')`).join(', ')} };\n` +
    (imports.length > 0 ? `    const { ${imports.join(', ')} } = __deps;\n` : '') +
    `\n` +
    `${text.trim()}\n\n` +
    `    module.exports = { ${target.exports.join(', ')} };\n` +
    `    return module.exports;\n` +
    `  },\n` +
    `});\n`
  );
}

let changed = 0;
for (const target of TARGETS) {
  const output = join(ROOT, target.output);
  const next = generate(target);
  let current = '';
  try {
    current = readFileSync(output, 'utf8');
  } catch {
    current = '';
  }
  if (current === next) {
    process.stdout.write(`· ${target.output} up to date\n`);
    continue;
  }
  if (process.argv.includes('--check')) {
    process.stderr.write(`✖ ${target.output} is stale; run \`node scripts/build-client.mjs\`\n`);
    changed += 1;
    continue;
  }
  writeFileSync(output, next, 'utf8');
  changed += 1;
  process.stdout.write(`✔ ${target.output} written\n`);
}

if (process.argv.includes('--check') && changed > 0) process.exit(1);
process.stdout.write(`${changed} file(s) ${process.argv.includes('--check') ? 'stale' : 'updated'}.\n`);
