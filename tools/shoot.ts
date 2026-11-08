// Screenshot this checkout of the app, for the build journal (and the film).
//
//   node tools/shoot.ts --out journal/0001-x/02-after.png [--board 3] [--lang en]
//        [--eval "window.ideagen.graph.h.select(12)"] [--wait 1500] [--width 1440 --height 900] [--scale 1]
//        [--path "/"] [--url http://127.0.0.1:8301/]
//
// Without --url it boots THIS folder's server on a free port, against a copy of
// data/ideas.db (or an empty database), with the autopilot and the builder off,
// so nothing calls a model. Then headless Chrome opens the page with ?debug
// (window.ideagen = { graph, state }), runs each --eval in order (awaiting
// promises, waiting --wait ms after load and after each), and saves a PNG.
// No dependencies: Chrome DevTools Protocol over Node's built-in WebSocket.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';

const HELP = readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n');

const { values: o } = parseArgs({
  options: {
    out: { type: 'string' }, board: { type: 'string' }, lang: { type: 'string', default: 'en' }, eval: { type: 'string', multiple: true, default: [] },
    wait: { type: 'string', default: '1500' }, width: { type: 'string', default: '1440' }, height: { type: 'string', default: '900' },
    scale: { type: 'string', default: '1' }, path: { type: 'string', default: '/' }, url: { type: 'string' }, help: { type: 'boolean' },
  },
});
if (o.help || !o.out) {
  console.log(HELP);
  process.exit(o.help ? 0 : 1);
}

const CHROME = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((p) => p && existsSync(p));
if (!CHROME) throw new Error('No Chrome found; set CHROME_BIN');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise<number>((res, rej) => {
  const s = createServer();
  s.once('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => res(p)); });
});
const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');
const tmp = mkdtempSync(join(tmpdir(), 'ideagen-shoot-'));
const children: ChildProcess[] = [];
let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  for (const c of children) c.kill('SIGKILL');
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* Chrome may still hold a file; it is a temp dir */ }
};
process.on('exit', cleanup);

async function startServer() {
  const port = await freePort();
  const db = join(tmp, 'ideas.db');
  // A consistent snapshot (VACUUM INTO also picks up what is still in the WAL file); the original is never touched.
  if (existsSync(join(repoRoot, 'data', 'ideas.db'))) new DatabaseSync(join(repoRoot, 'data', 'ideas.db'), { readOnly: true }).prepare('VACUUM INTO ?').run(db);
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_FILE: db, IDEAGEN_NO_AUTOPILOT: '1', IDEAGEN_NO_BUILDER: '1' };
  const child = spawn(process.execPath, ['server/index.ts'], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let log = '';
  child.stdout!.on('data', (d) => (log += d));
  child.stderr!.on('data', (d) => (log += d));
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    if (child.exitCode != null) throw new Error(`The server exited:\n${log}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/api/boards`)).ok) return `http://127.0.0.1:${port}`; } catch { /* not yet */ }
  }
  throw new Error(`The server did not start:\n${log}`);
}

async function startChrome(width: number, height: number) {
  const chrome = spawn(CHROME!, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(tmp, 'chrome')}`, `--window-size=${width},${height}`,
    '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(chrome);
  let err = '';
  const ws = await new Promise<string>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`Chrome did not start:\n${err}`)), 20_000);
    chrome.stderr!.on('data', (d) => {
      err += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) { clearTimeout(t); res(m[1]); }
    });
  });
  const port = new URL(ws).port;
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = pages.find((p: any) => p.type === 'page');
  return page.webSocketDebuggerUrl as string;
}

function cdp(url: string) {
  const sock = new WebSocket(url);
  let id = 0;
  const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  const waiters: { method: string; res: (v: any) => void }[] = [];
  sock.onmessage = (m) => {
    const msg = JSON.parse(String(m.data));
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
    } else if (msg.method) {
      for (const w of waiters.filter((x) => x.method === msg.method)) { waiters.splice(waiters.indexOf(w), 1); w.res(msg.params); }
    }
  };
  const open = new Promise((r) => (sock.onopen = r));
  return {
    open,
    send: (method: string, params: object = {}) => new Promise<any>((res, rej) => {
      const n = ++id;
      pending.set(n, { res, rej });
      sock.send(JSON.stringify({ id: n, method, params }));
    }),
    once: (method: string) => new Promise<any>((res) => waiters.push({ method, res })),
    close: () => sock.close(),
  };
}

try {
  const width = Number(o.width), height = Number(o.height), wait = Number(o.wait);
  const base = o.url ? new URL(o.url).origin : await startServer();
  const target = new URL(o.url ?? o.path!, base);
  target.searchParams.set('debug', '1');
  const page = cdp(await startChrome(width, height));
  await page.open;
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: Number(o.scale), mobile: false });
  // Language and board are per-browser settings (localStorage); set them before the app reads them.
  const ls: Record<string, string> = { 'ideagen.lang': o.lang! };
  if (o.board) ls['ideagen.board'] = o.board;
  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { ${Object.entries(ls).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join(' ')} } catch {}`,
  });
  const loaded = page.once('Page.loadEventFired');
  await page.send('Page.navigate', { url: target.href });
  await loaded;
  await sleep(wait);
  for (const expression of o.eval as string[]) {
    const r = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`--eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    await sleep(wait);
  }
  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  mkdirSync(dirname(resolve(o.out!)), { recursive: true });
  writeFileSync(o.out!, Buffer.from(shot.data, 'base64'));
  page.close();
  console.log(`saved ${o.out} (${width}×${height})`);
  cleanup();
  process.exit(0);
} catch (e: any) {
  console.error(e?.message ?? e);
  cleanup();
  process.exit(1);
}
