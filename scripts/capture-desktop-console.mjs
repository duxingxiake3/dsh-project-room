/**
 * Attach to the running DSH DESKTOP app's renderer and capture its console.
 *
 * The desktop app's UI is the DSH web shell running in an Electron renderer. When
 * a boot step fails, that renderer reports a one-line message to the main process,
 * which writes it into `logs/crash-*-web-boot.log` — and the message is often just
 * "entry X: failed", with the actual exception swallowed inside the shell.
 *
 * This script connects to the renderer over CDP and prints EVERY console message
 * and exception, so the swallowed cause becomes readable. The app must be started
 * with a debugging port:
 *
 *   "<DSH-APP>\DeepSeek Harness.exe" --remote-debugging-port=9222
 *
 * Usage: node scripts/capture-desktop-console.mjs [port] [seconds]
 */

import { setTimeout as delay } from 'node:timers/promises';

const port = Number(process.argv[2] ?? 9222);
const seconds = Number(process.argv[3] ?? 25);
const deadline = Date.now() + seconds * 1000;

/** Find the renderer target whose URL is the app shell. */
async function findTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const pages = targets.filter((target) => target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string');
      // The shell is served from the app scheme; prefer it over devtools pages.
      const shell = pages.find((page) => page.url.startsWith('dsh-app://')) ?? pages[0];
      if (shell) return shell;
    } catch {
      /* the app is not listening yet */
    }
    await delay(500);
  }
  return null;
}

const target = await findTarget();
if (!target) {
  process.stderr.write(`no debuggable renderer on port ${port}. Start the app with --remote-debugging-port=${port}\n`);
  process.exit(2);
}

process.stdout.write(`attached to: ${target.url}\n\n`);

const socket = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();

function send(method, params) {
  id += 1;
  socket.send(JSON.stringify({ id, method, params: params ?? {} }));
  return new Promise((resolve) => pending.set(id, resolve));
}

const seen = [];
function record(kind, text) {
  const line = `${kind}  ${text}`;
  seen.push(line);
  process.stdout.write(`${line}\n`);
}

socket.addEventListener('message', (event) => {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    return;
  }
  if (message.id !== undefined) {
    pending.get(message.id)?.();
    pending.delete(message.id);
    return;
  }
  const params = message.params ?? {};
  if (message.method === 'Runtime.consoleAPICalled') {
    const text = (params.args ?? [])
      .map((arg) => {
        if (arg.type === 'string') return arg.value;
        if ('value' in arg) return String(arg.value);
        return arg.description ?? arg.className ?? arg.type;
      })
      .join(' ');
    record(`console.${params.type}`, text);
  } else if (message.method === 'Runtime.exceptionThrown') {
    const detail = params.exceptionDetails ?? {};
    record('EXCEPTION', detail.exception?.description ?? detail.text ?? '(no description)');
  } else if (message.method === 'Log.entryAdded') {
    const entry = params.entry ?? {};
    if (entry.level === 'error' || entry.level === 'warning') record(`log.${entry.level}`, entry.text ?? '');
  }
});

socket.addEventListener('open', async () => {
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Console.enable');
  process.stdout.write('listening…\n');
});

socket.addEventListener('error', (error) => {
  process.stderr.write(`websocket error: ${error?.message ?? error}\n`);
});

// Re-read the current DOM too: the shell renders its failure state into the page,
// and that text is often richer than the one-line IPC message.
await delay(Math.min(3000, seconds * 1000));
try {
  const result = await send('Runtime.evaluate', {
    expression: 'document.body ? document.body.innerText.slice(0, 4000) : "(no body)"',
    returnByValue: true,
  });
  process.stdout.write('\n--- page text ---\n');
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  /* the renderer may already be gone */
}

while (Date.now() < deadline) await delay(250);
socket.close();
process.stdout.write(`\n--- ${seen.length} console line(s) captured ---\n`);
