/**
 * Minimal Chrome DevTools Protocol driver (no dependencies, Node >= 22 for
 * the global WebSocket). Used by the screenshot / GIF capture tools.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_CHROME = process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : 'google-chrome';

/**
 * Launch headless Chrome and attach to its first page.
 * Returns { send(method, params), events: [], close() }.
 */
export async function launch({ chrome = DEFAULT_CHROME, width = 1280, height = 900 } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'phosphor-chrome-'));
  const proc = spawn(chrome, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', `--window-size=${width},${height}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    proc.stderr.on('data', (d) => {
      buf += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) resolve(m[1]);
    });
    proc.on('exit', () => reject(new Error('Chrome exited early')));
    setTimeout(() => reject(new Error('Chrome did not start')), 15000);
  });

  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else events.push(msg);
  });
  const raw = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
  });

  const { targetInfos } = await raw('Target.getTargets');
  const page = targetInfos.find((t) => t.type === 'page');
  const targetId = page ? page.targetId : (await raw('Target.createTarget', { url: 'about:blank' })).targetId;
  const { sessionId } = await raw('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => raw(method, params, sessionId);
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Page.bringToFront');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

  return {
    send,
    events,
    /** Evaluate an expression in the page and return its (JSON) value. */
    async evaluate(expression) {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    /** Console errors and uncaught exceptions seen so far. */
    errors() {
      const out = [];
      for (const m of events) {
        if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
          out.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
        } else if (m.method === 'Runtime.exceptionThrown') {
          out.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
        } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
          out.push(`${m.params.entry.text} ${m.params.entry.url || ''}`.trim());
        }
      }
      return out;
    },
    close() {
      ws.close();
      proc.kill();
      setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500);
    },
  };
}
