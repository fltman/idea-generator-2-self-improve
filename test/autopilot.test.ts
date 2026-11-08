import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffMs, createAutopilot, nextLocalMidnight, rateCheck, type RateInput } from '../server/autopilot.ts';
import { openDb } from '../server/db.ts';
import { createBus, createEngine } from '../server/engine.ts';
import { DEFAULT_APP_SETTINGS, type ChatRequest } from '../server/providers.ts';

const T = Date.parse('2026-11-02T12:00:00');
const base: RateInput = {
  now: T, steps: [], lastAt: 0, paceSeconds: 10, stepsPerHour: 60, boardSpent: 0, boardUsdPerDay: 1,
  globalSpent: 0, globalUsdPerDay: 5, errors: 0, lastErrorAt: 0,
};

test('rate limiter: budgets, backoff, hourly window, pace', () => {
  assert.deepEqual(rateCheck(base), { ok: true });
  assert.deepEqual(rateCheck({ ...base, globalSpent: 5 }), { ok: false, reason: 'global_budget', until: nextLocalMidnight(T) });
  assert.equal((rateCheck({ ...base, boardSpent: 1.2 }) as any).reason, 'board_budget');
  assert.equal((rateCheck({ ...base, boardSpent: 0.99 }) as any).ok, true);
  // 0 = free models only: nothing spent keeps running, the first paid cent stops it
  assert.equal(rateCheck({ ...base, boardUsdPerDay: 0, boardSpent: 0 }).ok, true);
  assert.equal((rateCheck({ ...base, boardUsdPerDay: 0, boardSpent: 0.001 }) as any).reason, 'board_budget');

  assert.deepEqual([1, 2, 3, 10].map(backoffMs), [30_000, 60_000, 120_000, 900_000]);
  assert.equal((rateCheck({ ...base, errors: 2, lastErrorAt: T - 30_000 }) as any).reason, 'backoff');
  assert.equal(rateCheck({ ...base, errors: 2, lastErrorAt: T - 61_000 }).ok, true);

  const steps = [T - 3_500_000, T - 1000];
  assert.deepEqual(rateCheck({ ...base, steps, stepsPerHour: 2 }), { ok: false, reason: 'hourly', until: T - 3_500_000 + 3_600_000 });
  assert.equal(rateCheck({ ...base, steps: [T - 3_700_000, T - 1000], stepsPerHour: 2 }).ok, true, 'old steps leave the window');

  assert.deepEqual(rateCheck({ ...base, lastAt: T - 4000 }), { ok: false, reason: 'pace', until: T + 6000 });
});

test('local midnight is the next calendar day at 00:00', () => {
  const m = new Date(nextLocalMidnight(T));
  assert.deepEqual([m.getDate(), m.getHours(), m.getMinutes()], [3, 0, 0]);
});

function fakeEngineFor(repo: ReturnType<typeof openDb>) {
  const bus = createBus();
  const steps: number[] = [];
  let fail = false;
  return {
    steps,
    setFail: (v: boolean) => (fail = v),
    engine: {
      bus,
      async autoStep(boardId: number) {
        if (fail) throw Object.assign(new Error('no key'), { code: 'no_key' });
        steps.push(boardId);
        repo.addSpend(boardId, 0.3);
        return { did: 'combine' as const };
      },
    } as any,
  };
}

test('scheduler: only auto boards run, at their pace, within their limits', async () => {
  const repo = openDb(':memory:');
  let now = T;
  const { engine, steps, setFail } = fakeEngineFor(repo);
  const ap = createAutopilot({ repo, engine, settings: () => DEFAULT_APP_SETTINGS, now: () => now });
  const auto = repo.createBoard({ title: 'Auto', config: { mode: 'auto', autopilotSeconds: 10, rate: { stepsPerHour: 3, usdPerDay: 100 } } });
  repo.createBoard({ title: 'Manual' });
  const flush = () => new Promise((r) => setTimeout(r, 5));

  await ap.tick(); await flush();
  assert.deepEqual(steps, [auto.id], 'the manual board never runs');
  now += 5_000; await ap.tick(); await flush();
  assert.equal(steps.length, 1);
  assert.equal(ap.status(auto.id).state, 'pace');
  now += 5_000; await ap.tick(); await flush();
  now += 10_000; await ap.tick(); await flush();
  assert.equal(steps.length, 3);
  now += 10_000; await ap.tick(); await flush();
  assert.equal(steps.length, 3, 'three steps per hour');
  assert.equal(ap.status(auto.id).state, 'hourly');

  // Errors back off, and the status says why.
  now += 3_600_000; setFail(true);
  await ap.tick(); await flush();
  assert.equal(ap.status(auto.id).state, 'error');
  assert.equal(ap.status(auto.id).code, 'no_key');
  now += 15_000; await ap.tick(); await flush();
  assert.equal(ap.status(auto.id).state, 'backoff');
  setFail(false);
  now += 30_000; await ap.tick(); await flush();
  assert.equal(steps.length, 4, 'recovers after the backoff');

  // Budget: the board has spent 4 × $0.30; a $1 cap stops it until midnight.
  repo.updateBoard(auto.id, { config: { rate: { stepsPerHour: 3, usdPerDay: 1 } } });
  now += 20_000; await ap.tick(); await flush();
  assert.equal(ap.status(auto.id).state, 'board_budget');
  assert.equal(steps.length, 4);

  repo.updateBoard(auto.id, { config: { mode: 'manual' } });
  await ap.tick();
  assert.equal(ap.status(auto.id).state, 'manual');
});

test('autoStep with the real engine: judge first, grow a small pool, then breed', async () => {
  const repo = openDb(':memory:');
  let n = 0;
  const chat = async (r: ChatRequest) => {
    n++;
    const value =
      r.schemaName === 'expand' ? { ideas: [1, 2, 3].map((k) => ({ title: `Idé ${n}.${k}`, pitch: 'p' })) }
      : r.schemaName === 'judgement' ? { reason: 'r', originality: 2 + (n % 3), feasibility: 3, impact: 3, keywords: ['k'] }
      : { title: `Korsning ${n}`, pitch: 'p' };
    return { value, costUsd: 0 };
  };
  const engine = createEngine({ repo, chat, settings: () => DEFAULT_APP_SETTINGS, gitInit: false });
  const board = repo.createBoard({ title: 'B' });
  assert.deepEqual(await engine.autoStep(board.id), { did: 'idle', reason: 'empty' });
  repo.insertIdea({ boardId: board.id, title: 'Frö', pitch: '', kind: 'seed', x: 0, y: 0, generation: 0 });

  const did: string[] = [];
  for (let i = 0; i < 6; i++) did.push((await engine.autoStep(board.id)).did);
  assert.equal(did[0], 'judge', 'an unjudged seed is judged first');
  assert.equal(did[1], 'expand', 'a pool under three grows by expanding');
  assert.ok(did.includes('combine'), `breeds once the pool is big enough: ${did.join(',')}`);
  const ideas = repo.listIdeas(board.id);
  assert.ok(ideas.every((i) => i.judgedAt), 'every step leaves its ideas judged');
  assert.ok(ideas.some((i) => i.kind === 'combine' && i.generation >= 2));
});

test('autoStep in a keyword monoculture breeds outside it and marks the child', async () => {
  const repo = openDb(':memory:');
  const chat = async (r: ChatRequest) => {
    const value =
      r.schemaName === 'expand' ? { ideas: [1, 2].map((k) => ({ title: `Ny ${k}`, pitch: 'p' })) }
      : r.schemaName === 'judgement' ? { reason: 'r', originality: 3, feasibility: 3, impact: 3, keywords: ['fresh'] }
      : { title: 'Korsning', pitch: 'p' };
    return { value, costUsd: 0 };
  };
  const engine = createEngine({ repo, chat, settings: () => DEFAULT_APP_SETTINGS, gitInit: false });
  const board = repo.createBoard({ title: 'B' });
  const add = (title: string, sum: number, kw: string[]) => {
    const i = repo.insertIdea({ boardId: board.id, title, pitch: '', kind: 'expand', x: 0, y: 0, generation: 1 });
    repo.saveJudgement(i.id, { originality: sum - 8, feasibility: 4, impact: 4, reason: 'r' });
    repo.setKeywords(i.id, kw);
    return i;
  };
  // 14 strong ideas share one theme; 2 weaker ones do not.
  for (let n = 0; n < 14; n++) add(`Recept ${n}`, 12, ['lift recipe', n % 2 ? 'jury' : 'evolution']);
  const out = [add('Annat A', 10, ['camera']), add('Annat B', 9, ['export'])];
  for (let step = 0; step < 3; step++) {
    const r = await engine.autoStep(board.id);
    assert.ok(r.did === 'combine' || r.did === 'expand', r.did);
    const kids = r.ids!.map((id) => repo.getIdea(id)!);
    assert.ok(kids.every((k) => k.escape === 'lift recipe'), `step ${step}: the child remembers the monoculture it escaped`);
    const parents = repo.listEdges(board.id).filter((e) => r.ids!.includes(e.to)).map((e) => e.from);
    assert.ok(parents.some((p) => !repo.getIdea(p)!.keywords.includes('lift recipe')), `a parent from outside the theme: ${parents}`);
  }
  assert.ok(repo.listEdges(board.id).some((e) => out.some((o) => o.id === e.from)), 'the neglected ideas got children');
});
