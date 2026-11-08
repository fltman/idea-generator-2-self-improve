// Spores: strong ideas that spread between boards on their own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { DEFAULT_APP_SETTINGS, type ChatRequest } from '../server/providers.ts';
import { sporeDue, pickSpore, sporeTarget, sporeRooted, sporeStats, SPORE_EVERY } from '../public/js/evolve.js';

const idea = (id: number, sum: number | null, extra: object = {}) => ({
  id, kind: 'combine', medalOverride: null, keywords: [],
  ...(sum == null ? { originality: null, feasibility: null, impact: null } : { originality: sum - 8, feasibility: 4, impact: 4 }),
  ...extra,
});

test('sporeDue: every SPORE_EVERY bred ideas since the last spore; seeds and guests do not count', () => {
  const bred = Array.from({ length: SPORE_EVERY }, (_, k) => idea(k + 1, 9));
  assert.equal(sporeDue(bred.slice(1)), false);
  assert.equal(sporeDue(bred), true);
  assert.equal(sporeDue([...bred.slice(1), idea(99, 9, { kind: 'seed' }), idea(98, 9, { kind: 'guest' })]), false);
  assert.equal(sporeDue(bred, 5), false, 'only ideas newer than the last spore count');
});

test('pickSpore: the fittest own idea at silver or better that has not left before', () => {
  const ideas = [idea(1, 10), idea(2, 12), idea(3, 13, { kind: 'guest' }), idea(4, 12), idea(5, 11)];
  assert.equal(pickSpore(ideas).id, 2, 'best fitness; the older on a tie; never a guest');
  assert.equal(pickSpore(ideas, new Set([2, 4])).id, 5);
  assert.equal(pickSpore([idea(1, 10), idea(2, null)]), null, 'bronze and unjudged ideas stay home');
  assert.equal(pickSpore([idea(1, 6, { medalOverride: 2 })]).id, 1, 'a hand-set silver may leave');
});

test('sporeTarget: lands where most keywords are shared; with none shared it drifts at random', () => {
  const sp = { keywords: ['Sound', 'parks'] };
  const boards = [{ id: 7, keywords: ['light'] }, { id: 8, keywords: ['sound', 'parks', 'x'] }, { id: 9, keywords: ['parks'] }];
  assert.deepEqual(sporeTarget(sp, boards, () => 0.5), { boardId: 8, shared: ['sound', 'parks'] });
  assert.equal(sporeTarget({ keywords: ['none'] }, boards, (() => { const r = [0.1, 0.9, 0.2]; return () => r.shift()!; })()).boardId, 8, 'the draw picks among equals');
  assert.equal(sporeTarget(sp, []), null);
  // The draw stays under one shared keyword: it can never beat a real overlap.
  assert.equal(sporeTarget(sp, [{ id: 1, keywords: [] }, { id: 2, keywords: ['parks'] }], (() => { const r = [0.999, 0]; return () => r.shift()!; })()).boardId, 2);
});

test('sporeRooted and sporeStats: a medal where it landed is a root; children count for arrivals', () => {
  assert.equal(sporeRooted(idea(1, null)), null);
  assert.equal(sporeRooted(idea(1, 8)), false);
  assert.equal(sporeRooted(idea(1, 9)), true);
  const out = [idea(10, 9), idea(11, 7), idea(12, null)];
  const here = [idea(20, 12, { kind: 'guest', spore: true }), idea(21, 9, { kind: 'guest' }), idea(22, 9)];
  const s = sporeStats(out, here, [{ from: 20, to: 22 }, { from: 20, to: 23 }, { from: 21, to: 22 }]);
  assert.deepEqual(s.sent, { n: 3, judged: 2, rooted: 1 });
  assert.deepEqual(s.arrived, { n: 1, judged: 1, rooted: 1, children: 2 }, 'a hand-announced guest is not a spore');
});

test('autopilot: a spore board sends its best idea to the spore board it fits, once, and the guest is judged there', async () => {
  const repo = openDb(':memory:');
  let n = 0;
  const chat = async (r: ChatRequest) => {
    n++;
    const value =
      r.schemaName === 'expand' ? { ideas: [1, 2, 3].map((k) => ({ title: `Idé ${n}.${k}`, pitch: 'p' })) }
      : r.schemaName === 'judgement' ? { reason: 'r', originality: 4, feasibility: 4, impact: 3, keywords: r.user.includes('Ljud') ? ['ljud'] : ['ljud', 'park'] }
      : { title: `Korsning ${n}`, pitch: 'p' };
    return { value, costUsd: 0 };
  };
  const engine = createEngine({ repo, chat, settings: () => DEFAULT_APP_SETTINGS, gitInit: false, sporeRng: () => 0.5 });
  const home = repo.createBoard({ title: 'Hem', config: { spores: true } });
  const parks = repo.createBoard({ title: 'Parker', config: { spores: true } });
  const off = repo.createBoard({ title: 'Stängd', config: { spores: false } });
  const sounds = repo.createBoard({ title: 'Ljud', config: { spores: true } });
  for (const b of [parks, off, sounds]) {
    const s = repo.insertIdea({ boardId: b.id, title: `${b.title} frö`, pitch: '', kind: 'seed', x: 0, y: 0, generation: 0 });
    await engine.judge(s.id);
  }
  repo.insertIdea({ boardId: home.id, title: 'Frö', pitch: '', kind: 'seed', x: 0, y: 0, generation: 0 });

  for (let i = 0; i < 12 && !repo.sporesFrom(home.id).length; i++) await engine.autoStep(home.id);
  await engine.idle();
  const sent = repo.sporesFrom(home.id);
  assert.equal(sent.length, 1, 'one spore once enough was bred');
  assert.equal(sent[0].boardId, parks.id, 'it lands where both keywords are shared, not on the closed board');
  assert.equal(sent[0].kind, 'guest');
  assert.ok(sent[0].spore);
  assert.ok(sent[0].judgedAt, 'judged against the new board');
  assert.ok(repo.listIdeas(off.id).every((i) => !i.spore), 'a board with spores off takes none');
  // Not due again right away, and the same idea never leaves twice.
  await engine.autoStep(home.id);
  assert.equal(repo.sporesFrom(home.id).length, 1);
});

test('spores off: the autopilot never sends anything', async () => {
  const repo = openDb(':memory:');
  const chat = async (r: ChatRequest) => ({
    value: r.schemaName === 'expand' ? { ideas: [1, 2, 3].map((k) => ({ title: `I ${Math.random()} ${k}`, pitch: 'p' })) }
      : r.schemaName === 'judgement' ? { reason: 'r', originality: 4, feasibility: 4, impact: 4, keywords: ['k'] }
      : { title: `K ${Math.random()}`, pitch: 'p' },
    costUsd: 0,
  });
  const engine = createEngine({ repo, chat, settings: () => DEFAULT_APP_SETTINGS, gitInit: false });
  const home = repo.createBoard({ title: 'Hem' });
  repo.createBoard({ title: 'Annan', config: { spores: true } });
  repo.insertIdea({ boardId: home.id, title: 'Frö', pitch: '', kind: 'seed', x: 0, y: 0, generation: 0 });
  for (let i = 0; i < 12; i++) await engine.autoStep(home.id);
  assert.equal(repo.sporesFrom(home.id).length, 0);
});

test('autopilot: an idea that is built or being built never leaves as a spore', async () => {
  const repo = openDb(':memory:');
  const chat = async (r: ChatRequest) => ({
    value: r.schemaName === 'expand' ? { ideas: [1, 2, 3].map((k) => ({ title: `I ${Math.random()} ${k}`, pitch: 'p' })) }
      : r.schemaName === 'judgement' ? { reason: 'r', originality: 2, feasibility: 3, impact: 3, keywords: ['k'] }
      : { title: `K ${Math.random()}`, pitch: 'p' },
    costUsd: 0,
  });
  const engine = createEngine({ repo, chat, settings: () => DEFAULT_APP_SETTINGS, gitInit: false, sporeRng: () => 0.5 });
  const home = repo.createBoard({ title: 'Hem', config: { spores: true } });
  const other = repo.createBoard({ title: 'Annan', config: { spores: true } });
  const best = repo.insertIdea({ boardId: home.id, title: 'Byggd', pitch: '', kind: 'seed', x: 0, y: 0, generation: 0 });
  const next = repo.insertIdea({ boardId: home.id, title: 'Obyggd', pitch: '', kind: 'seed', x: 0, y: 0, generation: 0 });
  repo.saveJudgement(best.id, { reason: 'r', originality: 5, feasibility: 5, impact: 4, keywords: ['k'] } as any);
  repo.saveJudgement(next.id, { reason: 'r', originality: 4, feasibility: 4, impact: 4, keywords: ['k'] } as any);
  const b = repo.createBuild({ ideaId: best.id, boardId: home.id, title: 'Byggd', pitch: '', trigger: 'jury' });
  repo.updateBuild(b.id, { status: 'merged' });
  for (let i = 0; i < 12 && !repo.sporesFrom(home.id).length; i++) await engine.autoStep(home.id);
  await engine.idle();
  const sent = repo.sporesFrom(home.id);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].originIdeaId, next.id, 'the built idea stays home; the next best goes');
  assert.equal(sent[0].boardId, other.id);
});
