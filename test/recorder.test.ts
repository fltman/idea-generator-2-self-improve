// Flight recorder (build 0013): every model call is written to the `calls` table,
// a crash leaves its row open, the next boot marks it lost and the judgement resumes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createServer as netServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { DEFAULT_APP_SETTINGS, ProviderError, type ChatRequest } from '../server/providers.ts';
import { flightStats } from '../public/js/evolve.js';

const JUDGEMENT = { reason: 'Clear mechanism.', originality: 3, feasibility: 3, impact: 3, keywords: ['cost'] };

function setup(chat?: (r: ChatRequest) => Promise<any>) {
  const seen: ChatRequest[] = [];
  const repo = openDb(':memory:');
  const engine = createEngine({
    repo, settings: () => DEFAULT_APP_SETTINGS, gitInit: false,
    chat: chat ?? (async (r) => {
      seen.push(r);
      const value = r.schemaName === 'judgement' ? JUDGEMENT
        : r.schemaName === 'expand' ? { ideas: [1, 2, 3].map((k) => ({ title: `Child ${k}`, pitch: 'p' })) }
        : { title: 'Cross', pitch: 'p' };
      return { value, costUsd: 0.002 };
    }),
  });
  const board = repo.createBoard({ title: 'Recorder', config: { lang: 'en' } });
  return { repo, engine, board, seen };
}

test('every model call lands in the calls table with its role, idea, dollars and seconds (100% logged)', async () => {
  const { repo, engine, board, seen } = setup();
  const seed = repo.insertIdea({ boardId: board.id, title: 'Seed', pitch: 'p', kind: 'seed', x: 0, y: 0, generation: 0 });
  await engine.judge(seed.id);
  const { ideas } = await engine.expand(seed.id);
  await engine.idle();
  const stats = repo.callStats(board.id);
  const logged = stats.roles.reduce((s, r) => s + r.n, 0);
  assert.equal(logged, seen.length, 'one row per provider request: share logged 100%');
  assert.deepEqual(stats.roles.map((r) => [r.role, r.n]).sort(), [['expand', 1], ['judge', 1 + ideas.length]]);
  const judge = stats.roles.find((r) => r.role === 'judge')!;
  assert.equal(judge.usd, 0.002 * (1 + ideas.length));
  assert.equal(judge.failed, 0);
  assert.ok(judge.seconds >= 0);
  const own = repo.callsFor(seed.id);
  assert.deepEqual(own.map((c) => [c.role, c.status]), [['judge', 'ok'], ['expand', 'ok']], 'the expand call is filed under its parent');
  assert.equal(stats.restarts, 0);
  assert.equal(stats.lost, 0);
});

test('a failed call is logged as failed, with no dollars', async () => {
  const { repo, engine, board } = setup(async () => { throw new ProviderError('rate_limited', 'slow down'); });
  const seed = repo.insertIdea({ boardId: board.id, title: 'Seed', pitch: 'p', kind: 'seed', x: 0, y: 0, generation: 0 });
  await assert.rejects(engine.judge(seed.id), /slow down/);
  assert.deepEqual(repo.callsFor(seed.id).map((c) => [c.role, c.status, c.usd]), [['judge', 'failed', 0]]);
  assert.equal(repo.callStats(board.id).roles[0].failed, 1);
});

test('recordBoot marks open calls lost; recover() redoes only cut-off judgements of still unjudged ideas', async () => {
  const { repo, engine, board, seen } = setup();
  const mk = (title: string) => repo.insertIdea({ boardId: board.id, title, pitch: 'p', kind: 'seed', x: 0, y: 0, generation: 0 });
  const cut = mk('Cut off');
  const hand = mk('Hand medal');
  repo.setMedalOverride(hand.id, 2);
  const done = mk('Already judged');
  repo.saveJudgement(done.id, { ...JUDGEMENT, lift: '', liftType: null } as any);
  // Three calls in flight when the "server died", plus a breed that must not be redone.
  for (const i of [cut, hand, done]) repo.openCall({ boardId: board.id, ideaId: i.id, role: 'judge', model: 'm' });
  repo.openCall({ boardId: board.id, ideaId: cut.id, role: 'expand', model: 'm' });
  const boot = repo.recordBoot();
  assert.equal(boot.lost.length, 4);
  assert.equal(repo.recordBoot().lost.length, 0, 'a second boot finds nothing open');
  assert.deepEqual(repo.callsFor(cut.id).map((c) => c.status), ['lost', 'lost']);
  const r = engine.recover(boot.lost);
  assert.equal(repo.getIdea(hand.id)!.medalOverride, 2);
  assert.deepEqual(r.judged, [cut.id], 'not the hand-medalled idea, not the judged one');
  await engine.idle();
  assert.equal(seen.filter((x) => x.schemaName === 'expand').length, 0, 'breeds are not redone');
  assert.deepEqual(repo.callsFor(cut.id).map((c) => `${c.role}:${c.status}`), ['judge:lost', 'expand:lost', 'judge:ok']);
});

test('flightStats: dollars and seconds per medal per role, null before the first medal', () => {
  const rec = { roles: [{ role: 'judge', n: 4, failed: 1, lost: 1, usd: 0.04, seconds: 20 }, { role: 'expand', n: 1, failed: 0, lost: 0, usd: 0.02, seconds: 6 }], restarts: 2, lost: 1, lastRestart: '2026-11-08 10:00:00' };
  const bronze = { originality: 3, feasibility: 3, impact: 3, medalOverride: null };
  const none = { originality: 2, feasibility: 2, impact: 2, medalOverride: null };
  const s = flightStats(rec, [bronze, bronze, none]);
  assert.equal(s.medals, 2);
  assert.equal(s.rows[0].usdPerMedal, 0.02);
  assert.equal(s.rows[0].secPerMedal, 10);
  assert.equal(s.total.n, 5);
  assert.ok(Math.abs(s.total.usdPerMedal - 0.03) < 1e-9);
  assert.equal(s.total.secPerMedal, 13);
  assert.equal(s.restarts, 2);
  assert.equal(flightStats(rec, [none]).rows[0].usdPerMedal, null);
  assert.equal(flightStats(null, []).total.n, 0);
});

// ---------------------------------------------------------------- the crash test: a real server process, killed mid-judgement

const freePort = () => new Promise<number>((resolve) => {
  const s = netServer();
  s.listen(0, '127.0.0.1', () => {
    const p = (s.address() as any).port;
    s.close(() => resolve(p));
  });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

test('kill -9 mid-judgement, restart: one idea row, the cut-off call recorded as lost, exactly one finished judge call', { timeout: 60000 }, async () => {
  // A fake OpenAI-compatible provider. While `hang` is on it swallows judgement requests and never answers.
  let hang = true;
  let judgeRequests = 0;
  const provider: Server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    if (body.response_format?.json_schema?.name === 'judgement') {
      judgeRequests++;
      if (hang) return; // the call is in flight when the server dies
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(JUDGEMENT) } }], usage: { cost: 0.002 } }));
  });
  await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r));
  const providerUrl = `http://127.0.0.1:${(provider.address() as any).port}`;

  const dbFile = join(mkdtempSync(join(tmpdir(), 'ideagen-crash-')), 'ideas.db');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_FILE: dbFile,
    IDEAGEN_NO_AUTOPILOT: '1', IDEAGEN_NO_BUILDER: '1', IDEAGEN_RESUME: '1', CAMERA: '0',
  };
  const boot = async () => {
    const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'server', 'index.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout!.on('data', (d) => (log += d));
    child.stderr!.on('data', (d) => (log += d));
    await until('the server', async () => (await fetch(`${base}/api/boards`)).ok);
    return { child, log: () => log };
  };
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return res.json() as Promise<any>;
  };
  const models = Object.fromEntries(Object.keys(DEFAULT_APP_SETTINGS.models).map((r) => [r, 'custom:fake']));
  const pushSettings = () => api('PUT', '/api/runtime-settings', { baseUrls: { custom: providerUrl }, models });
  const stop = (child: ChildProcess, signal: NodeJS.Signals) => new Promise<void>((r) => {
    if (child.exitCode != null || child.signalCode != null) return r();
    child.once('exit', () => r());
    child.kill(signal);
  });

  let first: Awaited<ReturnType<typeof boot>> | null = null;
  let second: Awaited<ReturnType<typeof boot>> | null = null;
  try {
    first = await boot();
    await pushSettings();
    const { board } = await api('POST', '/api/boards', { lang: 'en', title: 'Crash test' });
    await sleep(1100); // so the restart lands in a later second than the board (boots are counted strictly after it)
    const { idea } = await api('POST', `/api/boards/${board.id}/seed`, { text: 'Cache judge verdicts' });
    await until('the judgement to be in flight', async () => judgeRequests === 1);
    await stop(first.child, 'SIGKILL'); // no shutdown handler gets to run

    hang = false;
    second = await boot();
    let data = await api('GET', `/api/boards/${board.id}`);
    assert.equal(data.ideas.find((i: any) => i.id === idea.id).originality, null, 'still unjudged after the crash');
    await pushSettings(); // the browser hands over its settings again; that is when the cut-off judgement resumes
    data = await until('the resumed verdict', async () => {
      const d = await api('GET', `/api/boards/${board.id}`);
      return d.ideas.find((i: any) => i.id === idea.id)?.originality != null && d;
    });
    assert.equal(data.ideas.length, 1, 'one idea row: the restart added no duplicate');
    assert.equal(data.recorder.restarts, 1, 'the restart chip counts one restart');
    assert.equal(data.recorder.lost, 1, 'and one call it cut off');
    assert.match(second.log(), /resumed 1 judgement/);
    assert.equal(judgeRequests, 2, 'the provider saw the cut-off request and one retry');
  } finally {
    if (first) await stop(first.child, 'SIGKILL');
    if (second) await stop(second.child, 'SIGTERM');
    provider.close();
    provider.closeAllConnections?.();
  }
  const repo = openDb(dbFile);
  const ideaRows = repo.listBoards().flatMap((b) => repo.listIdeas(b.id));
  assert.equal(ideaRows.length, 1);
  assert.deepEqual(repo.callsFor(ideaRows[0].id).map((c) => `${c.role}:${c.status}`), ['judge:lost', 'judge:ok'], 'exactly one finished judge call');
});

test('flightStats: only medals won since the recorder started count', () => {
  const rec = { roles: [{ role: 'judge', n: 2, failed: 0, lost: 0, usd: 1, seconds: 10 }], since: '2026-11-08 16:00:00' };
  const old = { originality: 4, feasibility: 3, impact: 3, medalOverride: null, judgedAt: '2026-11-08 15:00:00' };
  const fresh = { ...old, judgedAt: '2026-11-08 16:30:00' };
  const s = flightStats(rec, [old, old, fresh]);
  assert.equal(s.medals, 1);
  assert.equal(s.rows[0].usdPerMedal, 1);
});
