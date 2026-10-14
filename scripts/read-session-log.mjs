/**
 * Read a DSH session log — the ground truth for "what did this agent actually do".
 *
 * Session logs are stored as zstd-compressed JSONL (`session.v4.jsonl.zstd`), which
 * Node 24 decompresses natively. This exists because when a member produces no
 * visible group message, the only way to tell "the model returned nothing" from
 * "the plugin failed to publish its reply" is to read the agent's own log.
 *
 * Usage:
 *   node scripts/read-session-log.mjs <session.v4.jsonl.zstd>
 *   node scripts/read-session-log.mjs --room-dir <room session folder>
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const argument = process.argv[2];
if (!argument) {
  process.stderr.write('usage: node scripts/read-session-log.mjs <file-or-room-dir>\n');
  process.exit(2);
}

/** Resolve a file, or the newest session log inside a session or room directory. */
function resolveLog(target) {
  if (!existsSync(target)) throw new Error(`no such path: ${target}`);
  if (statSync(target).isFile()) return target;

  const LOG = 'session.v4.jsonl.zstd';
  // A session directory holds the log directly; a room directory holds one session
  // directory per member. Accept both rather than making the caller know which.
  const direct = join(target, LOG);
  if (existsSync(direct)) return direct;

  const found = readdirSync(target, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(target, entry.name, LOG))
    .filter((candidate) => existsSync(candidate))
    .map((candidate) => ({ candidate, mtime: statSync(candidate).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (found.length === 0) throw new Error(`no ${LOG} inside ${target}`);
  return found[0].candidate;
}

const file = resolveLog(argument);
const text = zstdDecompressSync(readFileSync(file)).toString('utf8');
const events = [];
for (const line of text.split('\n')) {
  if (!line.trim()) continue;
  try {
    events.push(JSON.parse(line));
  } catch {
    /* a torn final line is normal for a live session */
  }
}

const summary = [];
for (const [index, event] of events.entries()) {
  const type = event.type ?? '(none)';
  let detail = '';
  if (type === 'user/message') {
    const source = event.source?.kind ?? '?';
    const id = event.id ?? '';
    const textBlock = (event.content ?? []).find((block) => block.type === 'text');
    const preview = (textBlock?.text ?? '').replace(/\s+/g, ' ').slice(0, 90);
    detail = `source=${source} id=${id}\n        text: ${preview}`;
  } else if (type === 'assistant/message') {
    const kinds = (event.content ?? []).map((block) => block.type);
    detail = `blocks=[${kinds.join(', ')}]`;
    const textBlock = (event.content ?? []).find((block) => block.type === 'text');
    if (textBlock?.text) detail += `\n        text: ${textBlock.text.replace(/\s+/g, ' ').slice(0, 300)}`;
    const calls = (event.content ?? []).filter((block) => block.type === 'tool-call');
    for (const call of calls) detail += `\n        tool-call: ${call.name} ${String(call.arguments).slice(0, 160)}`;
  } else if (type === 'tool/result') {
    const textBlock = (event.content ?? []).find((block) => block.type === 'text');
    detail = `${event.isError ? 'ERROR ' : ''}${(textBlock?.text ?? '').replace(/\s+/g, ' ').slice(0, 200)}`;
  } else if (type === 'turn/end') {
    detail = `reason=${event.reason?.kind ?? '?'}`;
  } else if (type === 'request/header') {
    detail = `provider=${event.config?.provider} model=${event.config?.model}`;
  } else if (type === 'turn/start' || type === 'step/start' || type === 'step/end') {
    detail = `turn=${event.turn} step=${event.step ?? ''}`;
  }
  summary.push(`  ${String(index + 1).padStart(3)}. ${type}${detail ? `  ${detail}` : ''}`);
}

process.stdout.write(`file: ${file}\nevents: ${events.length}\n\n${summary.join('\n')}\n`);

// The counts that answer "did it reply?" and "did it use tools?".
const assistantMessages = events.filter((event) => event.type === 'assistant/message');
const toolCalls = assistantMessages.flatMap((event) => (event.content ?? []).filter((block) => block.type === 'tool-call'));
const textBlocks = assistantMessages.flatMap((event) => (event.content ?? []).filter((block) => block.type === 'text' && block.text?.trim()));
process.stdout.write(
  `\n--- summary ---\n` +
    `assistant messages : ${assistantMessages.length}\n` +
    `  with text        : ${textBlocks.length}\n` +
    `  tool calls       : ${toolCalls.length}${toolCalls.length > 0 ? ` (${[...new Set(toolCalls.map((call) => call.name))].join(', ')})` : ''}\n` +
    `turn ends          : ${events.filter((event) => event.type === 'turn/end').length}\n` +
    `errors             : ${events.filter((event) => event.type === 'turn/end' && event.reason?.kind === 'error').length}\n`,
);
