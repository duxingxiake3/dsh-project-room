/**
 * M0 environment probe for the Project Room plugin.
 *
 * This row exists only to answer, inside the real desktop host process, the
 * questions the design document's §8.3 matrix lists as "must verify":
 * which core version actually runs, whether a plugin-owned root session can be
 * created and driven, whether `node:sqlite` is loadable from a plugin, and what
 * model routes the host really exposes. It writes one JSON report and registers
 * no services, tools or UI.
 *
 * Delete this package once host notes records the answers.
 */

import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { hostname, platform, arch, release } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT = join(HERE, 'probe-report.json');

function probeSqlite() {
  try {
    const require = createRequire(import.meta.url);
    const sqlite = require('node:sqlite');
    const db = new sqlite.DatabaseSync(':memory:');
    db.exec('create table t(a integer, b text)');
    const insert = db.prepare('insert into t values (?, ?)');
    insert.run(1, 'ok');
    const row = db.prepare('select a, b from t').get();
    const version = db.prepare('select sqlite_version() as v').get();
    db.close();
    return { ok: true, row, sqliteVersion: version?.v };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

export const name = 'project-room-probe';

export function apply(ctx) {
  const report = {
    generatedAt: new Date().toISOString(),
    pid: process.pid,
    argv: process.argv.slice(0, 4),
    versions: {
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      chrome: process.versions.chrome ?? null,
      v8: process.versions.v8,
      modules: process.versions.modules,
      dshCore: undefined,
    },
    host: { platform: platform(), release: release(), arch: arch(), hostname: hostname() },
    sqlite: probeSqlite(),
    services: [],
    serviceErrors: {},
    events: [],
    modelRoutes: { agentDefaultModel: null, error: null },
    notes: [],
  };

  // Which of the services this plugin depends on are actually present on ctx.
  const wanted = [
    'agents',
    'agentLoop',
    'tools',
    'systemPrompt',
    'storage',
    'storageDomain',
    'webServer',
    'skills',
    'commands',
    'clientModules',
    'subagents',
    'llm',
    'sessionPersistence',
    'userQuestions',
    'permissionPresets',
    'web',
  ];
  for (const key of wanted) {
    try {
      report.services.push({ key, present: ctx.get(key) !== undefined });
    } catch (error) {
      report.services.push({ key, present: false, error: String(error?.message ?? error) });
    }
  }

  // Core version, read out of the installed bundle manifest rather than guessed.
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('@deepseek-ai/dsh-base/package.json');
    report.versions.dshCore = pkg.version;
  } catch (error) {
    report.serviceErrors.dshBase = String(error?.message ?? error);
  }

  try {
    report.modelRoutes.agentDefaultModel = ctx.get('agentDefaultModel')?.currentSelection?.() ?? null;
  } catch (error) {
    report.modelRoutes.error = String(error?.message ?? error);
  }

  try {
    writeFileSync(REPORT, JSON.stringify(report, null, 2), 'utf8');
    ctx.logger?.info?.(`[project-room-probe] report written to ${REPORT}`);
  } catch (error) {
    try {
      writeFileSync(
        REPORT,
        JSON.stringify({ ...report, writeError: String(error?.message ?? error) }, null, 2),
        'utf8',
      );
    } catch {
      /* nothing else to do */
    }
  }
}
