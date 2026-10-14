/**
 * Runs `client-harness.html` in a headless browser and reports the verdict.
 *
 * The client half cannot be exercised by `node --test` (no DOM, no closed module
 * table) nor by the framework sandbox (which boots the host half only). This
 * script closes that gap with the machine's own installed browser, so a client
 * change is verified BEFORE it reaches a desktop restart.
 *
 * Usage:
 *   node scripts/run-client-harness.mjs            # find a browser, run, report
 *   node scripts/run-client-harness.mjs --keep     # keep the temp profile
 *
 * Exit code is 0 only when every check in the harness passed.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { capture } from '../src/host/process.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HARNESS = join(ROOT, 'client-harness.html');

/** Browsers to try, in order. Any Chromium build with `--headless=new` works. */
const CANDIDATES = [
  process.env.DSH_HARNESS_BROWSER,
  join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const browser = CANDIDATES.find((candidate) => existsSync(candidate));
if (!browser) {
  process.stderr.write(
    'no Chromium-based browser found. Set DSH_HARNESS_BROWSER to one, or open client-harness.html manually.\n' +
      `checked:\n  ${CANDIDATES.join('\n  ')}\n`,
  );
  process.exit(2);
}

if (!existsSync(HARNESS)) {
  process.stderr.write(`missing ${HARNESS}\n`);
  process.exit(2);
}

const profile = mkdtempSync(join(tmpdir(), 'dpr-harness-'));
const logFile = join(profile, 'console.log');

process.stdout.write(`browser : ${browser}\n`);
process.stdout.write(`harness : ${HARNESS}\n`);

const run = capture(
  browser,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--disable-extensions',
    '--enable-logging=stderr',
    '--virtual-time-budget=8000',
    `--user-data-dir=${profile}`,
    '--dump-dom',
    pathToFileURL(HARNESS).href,
  ],
  { timeoutMs: 120000, maxBuffer: 32 * 1024 * 1024 },
);

const output = `${run.stdout}\n${run.stderr}`;

// The harness prints one line per check; the browser tags console output with
// `INFO:CONSOLE`, so match on the harness prefix and strip the wrapper.
const checks = [];
for (const line of output.split(/\r?\n/)) {
  const match = /\[harness\]\s+(.*?)(", source:|$)/.exec(line);
  if (match) checks.push(match[1].trim());
}

const failures = checks.filter((entry) => entry.startsWith('FAIL'));
const passes = checks.filter((entry) => entry.startsWith('PASS'));
const summary = checks.find((entry) => entry.startsWith('HARNESS-RESULT'));

for (const entry of checks) process.stdout.write(`  ${entry}\n`);
process.stdout.write(`\n${summary ?? 'HARNESS-RESULT: MISSING — the harness did not finish'}\n`);

if (!process.argv.includes('--keep')) {
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* a leftover temp profile is harmless */
  }
} else {
  process.stdout.write(`kept profile: ${profile}\n`);
}

if (!summary || failures.length > 0 || passes.length === 0) {
  process.stderr.write(`\nclient harness FAILED (${failures.length} check(s))\n`);
  // A truncated run usually means the browser never loaded the page at all.
  if (checks.length === 0) {
    process.stderr.write('no harness output was captured; raw browser output follows:\n');
    process.stderr.write(output.slice(0, 4000));
  }
  process.exit(1);
}

process.stdout.write(`\nclient harness passed (${passes.length} checks)\n`);
