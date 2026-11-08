import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pauseBanner, RESUME_MEDALS, PAUSE_CAPS } from '../public/js/pause.js';
import { flightStats } from '../public/js/evolve.js';
import { createAutopilot } from '../server/autopilot.ts';
import { openDb } from '../server/db.ts';
import { createBus } from '../server/engine.ts';
import { DEFAULT_APP_SETTINGS } from '../server/providers.ts';

const rate = { usdPerDay: 1, stepsPerHour: 60 };
const until = Date.parse('2026-11-09T00:00:00');

test('pause banner: only a tripped cap shows one', () => {
  assert.deepEqual(PAUSE_CAPS, ['board_budget', 'global_budget', 'hourly']);
  for (const state of ['manual', 'running', 'idle', 'pace', 'error', 'backoff']) {
    assert.equal(pauseBanner({ status: { state }, rate }), null, state);
  }
  assert.equal(pauseBanner({ status: null, rate }), null);
});

test('pause banner: a board budget raise is priced at RESUME_MEDALS medals', () => {
  const p = pauseBanner({ status: { state: 'board_budget', until, spentToday: 1 }, rate, usdPerMedal: 0.043, medals: 137 })!;
  assert.equal(RESUME_MEDALS, 3);
  assert.deepEqual([p.cap, p.value, p.spent, p.until], ['board_budget', 1, 1, until]);
  // 3 × $0.043 = $0.129, rounded up to the cent so it never buys less than promised
  assert.deepEqual(p.raise, { by: 0.13, to: 1.13, usd: 0.13 });
  assert.ok(Math.abs(p.forecast!.medals - 0.13 / 0.043) < 1e-9);
  assert.ok(p.forecast!.medals >= RESUME_MEDALS);
  assert.deepEqual([p.forecast!.usdPerMedal, p.forecast!.basis], [0.043, 137]);
});

test('pause banner: overspend past the cap still leaves the promised room', () => {
  // The check runs before a step, so spend can end above the cap ($1.24 of $1).
  const p = pauseBanner({ status: { state: 'board_budget', until, spentToday: 1.24 }, rate, usdPerMedal: 0.1, medals: 5 })!;
  assert.equal(p.raise.to, 1.54, 'new cap = spend + 3 medals');
  assert.equal(p.raise.usd, 0.54, 'the button names the whole raise');
  assert.ok(Math.abs(p.forecast!.medals - 3) < 1e-9, 'and forecasts what the room above spend buys');
});

test('pause banner: no cost data falls back to +25% (at least $0.50) and says it is not priced', () => {
  const none = pauseBanner({ status: { state: 'board_budget', until, spentToday: 1 }, rate, usdPerMedal: null })!;
  assert.deepEqual(none.raise, { by: 0.5, to: 1.5, usd: 0.5 });
  assert.equal(none.forecast, null);
  const big = pauseBanner({ status: { state: 'board_budget', until, spentToday: 4 }, rate: { usdPerDay: 4, stepsPerHour: 60 }, usdPerMedal: 0 })!;
  assert.deepEqual(big.raise, { by: 1, to: 5, usd: 1 });
  // A $0 cap (free models only) that a paid call tripped
  const zero = pauseBanner({ status: { state: 'board_budget', until, spentToday: 0.01 }, rate: { usdPerDay: 0, stepsPerHour: 60 }, usdPerMedal: 0.05, medals: 2 })!;
  assert.deepEqual(zero.raise, { by: 0.16, to: 0.16, usd: 0.16 });
});

test('pause banner: the global budget uses the app cap and spend', () => {
  const p = pauseBanner({ status: { state: 'global_budget', until, spentToday: 0.2 }, rate, globalCap: 5, globalSpent: 5.01, usdPerMedal: 0.2, medals: 10 })!;
  assert.deepEqual([p.cap, p.value, p.spent], ['global_budget', 5, 5.01]);
  assert.deepEqual(p.raise, { by: 0.61, to: 5.61, usd: 0.61 }, 'spend $5.01 + 3 × $0.20');
  const unknown = pauseBanner({ status: { state: 'global_budget', until }, rate, globalCap: 5, usdPerMedal: 0.2 })!;
  assert.equal(unknown.spent, null);
  assert.equal(unknown.raise.to, 5.6);
});

test('pause banner: the hourly cap is raised in steps, not priced', () => {
  const p = pauseBanner({ status: { state: 'hourly', until, stepsLastHour: 60 }, rate, usdPerMedal: 0.04, medals: 9 })!;
  assert.deepEqual([p.cap, p.value, p.spent, p.until], ['hourly', 60, 60, until]);
  assert.deepEqual(p.raise, { by: 15, to: 75, usd: null });
  assert.equal(p.forecast, null);
  assert.deepEqual(pauseBanner({ status: { state: 'hourly', until }, rate: { usdPerDay: 1, stepsPerHour: 4 } })!.raise, { by: 5, to: 9, usd: null });
});

test('pause banner: the price comes from the flight recorder like the overview', () => {
  const ideas = [1, 2, 3, 4].map((id) => ({ id, originality: 3, feasibility: 3, impact: 3, judgedAt: '2026-11-08 10:00:00' }));
  const fs = flightStats({ since: '2026-11-08 00:00:00', roles: [{ role: 'judge', n: 8, usd: 0.3 }, { role: 'combine', n: 4, usd: 0.1 }] }, ideas);
  const p = pauseBanner({ status: { state: 'board_budget', until, spentToday: 1 }, rate, usdPerMedal: fs.total.usdPerMedal, medals: fs.medals })!;
  assert.deepEqual(p.raise, { by: 0.3, to: 1.3, usd: 0.3 }, '$0.40 / 4 medals × 3');
  assert.equal(p.forecast!.basis, 4);
});

test('the banner\'s raise resumes a budget-paused autopilot on the next tick, and keeps the step cap', async () => {
  const repo = openDb(':memory:');
  let now = Date.parse('2026-11-08T12:00:00');
  const steps: number[] = [];
  const engine = {
    bus: createBus(),
    async autoStep(boardId: number) { steps.push(boardId); repo.addSpend(boardId, 0.6); return { did: 'combine' as const }; },
  } as any;
  const ap = createAutopilot({ repo, engine, settings: () => DEFAULT_APP_SETTINGS, now: () => now });
  const b = repo.createBoard({ title: 'B', config: { mode: 'auto', autopilotSeconds: 3, rate: { stepsPerHour: 40, usdPerDay: 1 } } });
  const flush = () => new Promise((r) => setTimeout(r, 5));
  for (let i = 0; i < 3; i++) { await ap.tick(); await flush(); now += 5000; }
  assert.equal(steps.length, 2, '$1.20 spent of $1');
  const st = ap.status(b.id);
  assert.equal(st.state, 'board_budget');

  const p = pauseBanner({ status: st, rate: repo.getBoard(b.id)!.config.rate, usdPerMedal: 0.1, medals: 6 })!;
  assert.equal(p.raise.to, 1.5);
  // What resumeAt() sends: PATCH config.rate with only the raised cap.
  repo.updateBoard(b.id, { config: { rate: { usdPerDay: p.raise.to } } });
  assert.deepEqual(repo.getBoard(b.id)!.config.rate, { stepsPerHour: 40, usdPerDay: 1.5 }, 'the step cap is untouched');
  await ap.tick(); await flush();
  assert.equal(steps.length, 3, 'the autopilot resumed');
});
