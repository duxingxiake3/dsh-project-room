/**
 * Project Room — activation diagnostics ("black box").
 *
 * A plugin that crashes the host process leaves almost nothing behind: no stack
 * in the UI, no session log, and the room database simply stops mid-write. This
 * module exists because that already happened once, and guessing from a stopped
 * database is not a diagnosis.
 *
 * What it does:
 *
 *   - appends one JSON line per activation phase to `<data>/boot-trace.jsonl`, so
 *     the LAST line of a crashed process says exactly how far it got;
 *   - keeps the previous trace instead of truncating it, and rewrites a compact
 *     `boot-report.json` at the end for the normal case;
 *   - installs process-level `uncaughtException` / `unhandledRejection` handlers
 *     that record the error text and then re-throw into the host's own handling —
 *     this plugin must never swallow a host error, only document it.
 *
 * Every write is best-effort and wrapped: diagnostics must never be the reason a
 * project cannot run.
 *
 * @module dsh-project-room/src/host/diagnostics
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { dataRoot } from './storage/paths.js';

/** Absolute path of the append-only activation trace. */
export function tracePath() {
  return join(dataRoot(), 'boot-trace.jsonl');
}

/** Absolute path of the summarized activation report. */
export function reportPath() {
  return join(dataRoot(), 'boot-report.json');
}

const MAX_TRACE_BYTES = 256 * 1024;

/**
 * Append one phase line to the trace.
 *
 * @param {string} phase Short machine-readable phase name.
 * @param {object} [detail] Extra facts (counts, versions, ids).
 * @returns {number} milliseconds since this activation started.
 */
export function trace(phase, detail) {
  const state = ensureState();
  const line = `${JSON.stringify({
    at: new Date().toISOString(),
    pid: process.pid,
    activation: state.activationId,
    phase,
    elapsedMs: Date.now() - state.startedAt,
    ...(detail === undefined ? {} : { detail }),
  })}\n`;
  state.lines.push(line.trim());
  try {
    rotateIfLarge();
    appendFileSync(tracePath(), line, 'utf8');
  } catch {
    /* diagnostics are best-effort by design */
  }
  return Date.now() - state.startedAt;
}

/**
 * Record one error against this activation, then hand it to the host.
 *
 * @param {string} phase
 * @param {unknown} error
 */
export function traceError(phase, error) {
  trace(`${phase}.error`, {
    message: String(error?.message ?? error),
    code: error?.code ?? null,
    stack: String(error?.stack ?? '').split('\n').slice(0, 8).join('\n'),
  });
}

/**
 * Install host-level error listeners once.
 *
 * The handlers RECORD and then re-throw into the host's own path: an installed
 * listener that returns normally would suppress the host's crash reporting, which
 * would make this plugin's presence change host behaviour.
 *
 * @param {object} [logger]
 * @returns {() => void} disposer
 */
export function installErrorHooks(logger) {
  const onUncaught = (error) => {
    traceError('process.uncaughtException', error);
    logger?.error?.(`[project-room] process error recorded: ${error?.message ?? error}`);
    throw error;
  };
  const onRejection = (reason) => {
    traceError('process.unhandledRejection', reason);
    logger?.error?.(`[project-room] unhandled rejection recorded: ${reason?.message ?? reason}`);
    throw reason;
  };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejection);
  trace('process.hooks-installed');
  return () => {
    try {
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onRejection);
    } catch {
      /* the process may be exiting already */
    }
  };
}

/**
 * Write the summarized report at the end of a successful activation, keeping a
 * bounded history so "which version actually ran" stays answerable later.
 *
 * @param {object} report
 */
export function writeReport(report) {
  const state = ensureState();
  try {
    const target = reportPath();
    const previous = existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) : null;
    const history = Array.isArray(previous?.history) ? previous.history.slice(-19) : [];
    history.push({
      at: new Date().toISOString(),
      activation: state.activationId,
      pid: process.pid,
      dshVersion: report.dshVersion,
      coreResolvedFrom: report.coreResolvedFrom,
      toolCount: report.toolNames?.length ?? 0,
      roomCount: report.rooms ?? 0,
      elapsedMs: Date.now() - state.startedAt,
    });
    writeFileSync(
      target,
      JSON.stringify({ generatedAt: new Date().toISOString(), pluginVersion: report.pluginVersion, phases: state.lines, ...report, history }, null, 2),
      'utf8',
    );
    trace('activation.report-written', { tools: report.toolNames?.length ?? 0, rooms: report.rooms ?? 0 });
  } catch (error) {
    traceError('activation.report', error);
  }
}

/**
 * The phases recorded so far in this activation, for the report.
 * @returns {string[]}
 */
export function recordedPhases() {
  return [...ensureState().lines];
}

/* ------------------------------------------------------------------ *
 * Internals
 * ------------------------------------------------------------------ */

/** @type {{ activationId: string, startedAt: number, lines: string[] } | null} */
let state = null;

function ensureState() {
  if (state !== null) return state;
  state = {
    activationId: `act_${Date.now().toString(36)}_${process.pid}`,
    startedAt: Date.now(),
    lines: [],
  };
  trace('activation.begin', { node: process.versions.node, electron: process.versions.electron ?? null });
  return state;
}

/**
 * Keep the trace from growing without bound across restarts: past the cap it is
 * rolled to `.1` once, which preserves the previous crash trail while this
 * activation keeps appending.
 */
function rotateIfLarge() {
  const target = tracePath();
  if (!existsSync(target)) return;
  const size = readFileSync(target).length;
  if (size < MAX_TRACE_BYTES) return;
  try {
    mkdirSync(dataRoot(), { recursive: true });
    renameSync(target, `${target}.1`);
  } catch {
    /* if the roll fails, appending anyway is still better than losing the trail */
  }
}
