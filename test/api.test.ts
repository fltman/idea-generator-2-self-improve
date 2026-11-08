// The whole HTTP API against an in-memory database and a fake LLM.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { createAutopilot } from '../server/autopilot.ts';
import { createHandler } from '../server/app.ts';
import { DEFAULT_APP_SETTINGS, ProviderError, type AppSettings, type ChatRequest } from '../server/providers.ts';

const calls: ChatRequest[] = [];
let judgeScores = { originality: 3, feasibility: 3, impact: 3 };
let judgeKeywords = ['Public Space', 'sound'];
let judgeLift: Record<string, string> = {}; // liftType + lift, when a test wants the jury to write a recipe
let retrialScores: typeof judgeScores | null = null; // what the second judge (the retrial model) answers, when a test sets it
let trialLot = 0.99; // placebo trials: the engine's lot; below PLACEBO_RATE sends a recipe breed to the placebo arm
let liftCheckAnswer: { applied: boolean; reason: string } | null = null; // the recipe check's ruling; null: no boolean (unchecked)
let liftCheckFails = false; // the recipe check's provider call throws
let failNext: Error | null = null;
let xCitations: string[] = [];

// Fake chat: answers by schema name, records every request.
async function fakeChat(r: ChatRequest) {
  calls.push(r);
  if (failNext) {
    const e = failNext;
    failNext = null;
    throw e;
  }
  if (liftCheckFails && r.schemaName === 'liftcheck') throw new Error('provider down');
  const n = calls.length;
  const value =
    r.schemaName === 'expand' ? { ideas: [1, 2, 3].map((k) => ({ title: `"Barn ${n}.${k}."`, pitch: `Pitch ${k}` })) }
    : r.schemaName === 'judgement' && retrialScores && r.model === settings.models.retrial ? { reason: 'Andra domaren tvekar.', ...retrialScores, keywords: judgeKeywords }
    : r.schemaName === 'judgement' ? { reason: 'Stark mekanism, oklar kund.', ...judgeScores, keywords: judgeKeywords, ...judgeLift }
    : r.schemaName === 'liftcheck' ? (liftCheckAnswer ?? { reason: 'Oklart.' })
    : r.schemaName === 'summary' ? { headline: 'Tavlan rör sig mot ljud.', themes: [{ name: 'Ljud', insight: 'Allt låter.', ideas: ['Lånecyklar'] }], strongest: [{ title: 'Korsning', why: 'Konkret.' }], gaps: ['Ingen tänker på natten.'], nextSteps: ['Korsa A och B.'] }
    : r.schemaName === 'synthesis' ? { headline: 'Bänkarna dominerar.', insights: ['i1', 'i2', 'i3'], standouts: [{ title: 'Sjungande parkbänk', board: 'X', why: 'w' }], opportunities: ['o1', 'o2'], nextSteps: ['n1', 'n2'] }
    : r.schemaName === 'brief' ? { name: 'Sjungande bänk', slug: 'Sjungande Bänk!', oneLiner: 'En bänk som sjunger.', problem: 'P', audience: 'A', mvp: ['m1', 'm2'], outOfScope: ['o'], stack: 's', firstSteps: ['f1', 'f2'], openQuestions: ['q1'], risks: ['r1'] }
    : r.schemaName === 'leads' ? { leads: [
        { title: 'Trend A', summary: 'S', hook: 'H', url: 'https://x.com/a/status/1' },
        { title: 'Trend B', summary: 'S', hook: 'H', url: 'https://twitter.com/b/status/2?s=20' },
        { title: 'Made up', summary: 'S', hook: 'H', url: 'https://x.com/fake/status/3' },
      ] }
    : r.schemaName === 'research' ? { leads: [
        { id: '2610.1', title: 'Rumsljud', summary: 'S', hook: 'H' },
        { id: '9999.9', title: 'Påhittad', summary: 'S', hook: 'H' },
      ] }
    : { title: r.schemaName === 'seed' ? 'Destillerat frö' : 'Korsning', pitch: 'En kombinerad pitch.' };
  return { value, costUsd: 0.001, citations: r.schemaName === 'leads' ? xCitations : [] };
}

const projectsRoot = mkdtempSync(join(tmpdir(), 'ideagen-projects-'));
let settings: AppSettings = { ...structuredClone(DEFAULT_APP_SETTINGS), projectsRoot };
let received = false;
const runtime = { get: () => settings, set: (s: AppSettings) => { settings = s; received = true; }, received: () => received };

const repo = openDb(':memory:');
const revealed: string[] = [];
const pages: Record<string, { title: string; text: string }> = {
  'https://example.com/artikel': { title: 'Artikel', text: 'Lång artikeltext om lånecyklar. '.repeat(10) },
  'https://example.com/tom': { title: '', text: 'kort' },
};
const engine = createEngine({
  repo, chat: fakeChat, settings: () => settings, gitInit: false, trialRng: () => trialLot,
  fetchPage: async (url) => {
    if (!pages[url]) throw new Error('HTTP 404');
    return pages[url];
  },
  fetchPapers: async () => [
    { id: '2610.1', title: 'Spatial audio', summary: 'sum', published: '2026-10-30', upvotes: 9 },
    { id: '2610.2', title: 'Other', summary: 'sum', published: '2026-10-29', upvotes: 1 },
  ],
  reveal: (p) => revealed.push(p),
});
const autopilot = createAutopilot({ repo, engine, settings: () => settings });
let server: Server;
let base = '';

before(async () => {
  server = createServer(createHandler({ repo, engine, autopilot, runtime, publicDir: join(import.meta.dirname, '..', 'public') }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => server.close());

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
}
const newBoard = async (extra: object = {}) => (await api('POST', '/api/boards', { lang: 'sv', ...extra })).data.board;
const seed = async (boardId: number, text: string) => (await api('POST', `/api/boards/${boardId}/seed`, { text })).data.idea;
const lastCall = (schema: string) => [...calls].reverse().find((c) => c.schemaName === schema)!;

test('full loop: seed → background judge → expand → combine → export', async () => {
  judgeScores = { originality: 3, feasibility: 3, impact: 3 };
  const board = await newBoard({ goal: 'Färre bilresor i staden' });
  assert.equal(board.title, 'Ny tavla');
  assert.equal(board.config.mode, 'manual');
  assert.equal(board.config.flowName, 'Uppfinnaren · Inventor', 'the first template seeds the flow');

  const before = calls.length;
  const s = await seed(board.id, 'Lånecyklar');
  assert.equal(s.title, 'Lånecyklar');
  await engine.idle();
  assert.equal(calls.length, before + 1, 'a short seed needs no LLM call, only the judge');
  assert.match(lastCall('judgement').user, /Färre bilresor i staden/, 'the judge sees the goal');
  const judged = repo.getIdea(s.id)!;
  assert.equal(judged.originality, 3);
  assert.deepEqual(judged.keywords, ['public space', 'sound'], 'keywords are normalised');

  const { data: e } = await api('POST', `/api/ideas/${s.id}/expand`, {});
  assert.equal(e.ideas.length, 3);
  assert.match(e.ideas[0].title, /^Barn \d+\.1$/, 'quotes and trailing period are stripped');
  assert.match(lastCall('expand').user, /Every idea must serve this goal/);
  assert.match(lastCall('expand').user, /- Lånecyklar/, 'existing titles reach the prompt');
  await engine.idle();
  assert.ok(e.ideas.every((i: any) => repo.getIdea(i.id)!.judgedAt), 'children are judged in the background');

  const [c1, c2] = e.ideas;
  const { data: c } = await api('POST', `/api/boards/${board.id}/combine`, { a: c1.id, b: c2.id });
  assert.equal(c.idea.generation, 2);
  await engine.idle();
  judgeScores = { originality: 9, feasibility: 0, impact: 4 }; // out of range on purpose
  const { data: j } = await api('POST', `/api/ideas/${c.idea.id}/judge`, {});
  assert.deepEqual([j.idea.originality, j.idea.feasibility, j.idea.impact], [5, 1, 4], 'scores are clamped');

  const { data: md } = await api('GET', `/api/boards/${board.id}/export.md?lang=sv`);
  assert.match(md, /^# Ny tavla/);
  assert.match(md, /> Färre bilresor i staden/);
  assert.match(md, /## 🥉 Korsning — 10\/15/, '10/15 is bronze');
  assert.match(md, /`public space` `sound`/);
  assert.ok(repo.spentOn(board.id) > 0, 'spend lands on the board');
  judgeScores = { originality: 3, feasibility: 3, impact: 3 };
});

test('each role uses its own model: app-wide setting, overridden per board', async () => {
  const pushed = await api('PUT', '/api/runtime-settings', {
    ...settings, models: { ...settings.models, expand: 'ollama:qwen3:8b' }, keys: { openrouter: 'sk-or-secret-123' },
  });
  assert.ok(!JSON.stringify(pushed.data).includes('sk-or-secret-123'), 'keys are never echoed back');
  assert.equal(pushed.data.providers.find((p: any) => p.id === 'openrouter').keySource, 'browser');
  assert.equal(pushed.data.settingsReceived, true);

  const board = await newBoard();
  const s = await seed(board.id, 'Rot');
  await api('POST', `/api/ideas/${s.id}/expand`, {});
  assert.equal(lastCall('expand').model, 'ollama:qwen3:8b');

  await api('PATCH', `/api/boards/${board.id}`, { config: { models: { expand: 'anthropic:claude-opus-5-5' } } });
  await api('POST', `/api/ideas/${s.id}/expand`, {});
  assert.equal(lastCall('expand').model, 'anthropic:claude-opus-5-5', 'board override wins');
  await api('PATCH', `/api/boards/${board.id}`, { config: { models: { expand: '' } } });
  await api('POST', `/api/ideas/${s.id}/expand`, {});
  assert.equal(lastCall('expand').model, 'ollama:qwen3:8b', 'an empty override falls back to the app setting');
  await engine.idle();
  settings = { ...structuredClone(DEFAULT_APP_SETTINGS), projectsRoot };
});

test('board config is validated and clamped', async () => {
  const board = await newBoard();
  const { data } = await api('PATCH', `/api/boards/${board.id}`, {
    config: { mode: 'chaos', rate: { stepsPerHour: 0, usdPerDay: -3 }, autopilotSeconds: 1, flow: { system: '' }, lang: 'de' },
  });
  const c = data.board.config;
  assert.equal(c.mode, 'manual');
  assert.equal(c.rate.stepsPerHour, 1);
  assert.equal(c.rate.usdPerDay, 0);
  assert.equal(c.autopilotSeconds, 3);
  assert.ok(c.flow.system.length > 20, 'an empty prompt keeps the old one');
  assert.equal(c.lang, 'sv');
});

test('the judge turns gold into a Claude Code project; a board can switch that off', async () => {
  judgeScores = { originality: 5, feasibility: 4, impact: 5 };
  const board = await newBoard({ goal: 'Ljud i offentliga rum' });
  const s = await seed(board.id, 'Sjungande parkbänk');
  await engine.idle();
  const gold = repo.getIdea(s.id)!;
  assert.ok(gold.projectPath, 'gold → project');
  assert.ok(gold.projectPath!.startsWith(projectsRoot));
  assert.match(gold.projectPath!, /sjungande-bank$/, 'slug is ASCII');
  const claude = readFileSync(join(gold.projectPath!, 'CLAUDE.md'), 'utf8');
  assert.match(claude, /^# Sjungande bänk/);
  assert.match(claude, /Ljud i offentliga rum/);
  assert.match(claude, /14\/15 🥇/);
  assert.ok(existsSync(join(gold.projectPath!, 'vault', 'Home.md')));
  assert.match(readFileSync(join(gold.projectPath!, '.gitignore'), 'utf8'), /^vault\/$/m);

  const again = await api('POST', `/api/ideas/${s.id}/project`, {});
  assert.equal(again.data.existed, true, 'one project per idea');
  await api('POST', `/api/ideas/${s.id}/reveal`, {});
  assert.deepEqual(revealed, [gold.projectPath]);

  const off = await newBoard();
  await api('PATCH', `/api/boards/${off.id}`, { config: { autoProjectOnGold: false } });
  const s2 = await seed(off.id, 'Ännu en guldidé');
  await engine.idle();
  assert.equal(repo.getIdea(s2.id)!.projectPath, null);
  judgeScores = { originality: 3, feasibility: 3, impact: 3 };
});

test('announce: guests cross-breed on other boards, judged against their goals', async () => {
  const a = await newBoard({ title: 'Ljud', goal: 'Ljudkonst' });
  const b = await newBoard({ title: 'Trafik', goal: 'Färre bilar' });
  const c = await newBoard({ title: 'Mat', goal: 'Mindre matsvinn' });
  const idea = await seed(a.id, 'Visslande trafikljus');
  await engine.idle();

  const { data } = await api('POST', `/api/ideas/${idea.id}/announce`, { boardIds: [a.id, b.id, c.id, b.id] });
  assert.deepEqual(data.guests.map((g: any) => g.boardId).sort(), [b.id, c.id].sort(), 'not to its own board, once per board');
  const guest = data.guests.find((g: any) => g.boardId === b.id).idea;
  assert.equal(guest.kind, 'guest');
  assert.equal(guest.originBoardTitle, 'Ljud');
  await engine.idle();
  const guestJudge = calls.filter((x) => x.schemaName === 'judgement' && x.user.includes('Visslande trafikljus'));
  assert.ok(guestJudge.some((x) => x.user.includes('Färre bilar')), "judged against the target board's goal");

  const again = await api('POST', `/api/ideas/${idea.id}/announce`, { boardIds: 'all' });
  assert.ok(!again.data.guests.some((g: any) => [b.id, c.id].includes(g.boardId)), 'never twice on the same board');
  assert.ok([b.id, c.id].every((id) => again.data.skipped.includes(id)));
  const onward = await api('POST', `/api/ideas/${guest.id}/announce`, { boardIds: [a.id] });
  assert.equal(onward.data.guests.length, 0, 'a guest cannot be announced back to its original board');

  const local = await seed(b.id, 'Cykelfiler');
  const { data: child } = await api('POST', `/api/boards/${b.id}/combine`, { a: guest.id, b: local.id });
  const lineage = repo.lineage(child.idea.id);
  assert.ok(lineage.some((i) => i.title === 'Visslande trafikljus') && lineage.some((i) => i.title === 'Cykelfiler'));
  assert.ok(lineage.some((i) => i.boardId === a.id), 'lineage follows the guest home');
  await engine.idle();
});

test('spin-off: a new board grown from one idea, refined in its own context', async () => {
  const parent = await newBoard({ title: 'Mor', goal: 'Allt' });
  await api('PATCH', `/api/boards/${parent.id}`, { config: { judgeGuidance: 'Belöna lokalt.', mode: 'auto' } });
  const idea = await seed(parent.id, 'Ljudande busshållplats');
  const { data } = await api('POST', `/api/ideas/${idea.id}/spinoff`, {});
  assert.equal(data.board.goal, 'Ljudande busshållplats');
  assert.equal(data.board.config.judgeGuidance, 'Belöna lokalt.', 'config is copied');
  assert.equal(data.board.config.mode, 'manual', 'but it starts manual');
  assert.equal(data.board.originBoardTitle, 'Mor');
  assert.equal(data.idea.originIdeaId, idea.id);
  const { data: p } = await api('GET', `/api/boards/${parent.id}`);
  assert.deepEqual(p.spinoffs, [{ ideaId: idea.id, boardId: data.board.id, title: 'Ljudande busshållplats' }]);
  await api('PATCH', `/api/boards/${parent.id}`, { config: { mode: 'manual' } });
  await engine.idle();
});

test('leads: X keeps only search-cited posts; research keeps only real paper ids', async () => {
  const board = await newBoard({ goal: 'Interaktivt ljus' });
  xCitations = ['https://x.com/a/status/1', 'https://x.com/b/status/2'];
  const { data: x } = await api('POST', `/api/boards/${board.id}/leads/x`, {});
  assert.deepEqual(x.leads.map((l: any) => l.title), ['Trend A', 'Trend B']);
  assert.equal(x.dropped, 1, 'the uncited post is dropped');
  assert.deepEqual(lastCall('leads').plugins, [{ id: 'web', engine: 'native', max_results: 12 }]);
  assert.equal(lastCall('leads').model, 'openrouter:x-ai/grok-4.3');

  const { data: r } = await api('POST', `/api/boards/${board.id}/leads/research`, {});
  assert.deepEqual(r.leads.map((l: any) => l.url), ['https://huggingface.co/papers/2610.1']);
  assert.match(lastCall('research').user, /Interaktivt ljus/);

  const { data: s } = await api('POST', `/api/leads/${x.leads[0].id}/seed`, {});
  assert.equal(s.idea.sourceUrl, 'https://x.com/a/status/1');
  assert.equal(s.lead.ideaId, s.idea.id);

  xCitations = [];
  const { data: x2 } = await api('POST', `/api/boards/${board.id}/leads/x`, {});
  assert.equal(x2.empty, true);
  assert.equal(x2.leads.length, 2, 'nothing verified: old leads stay');
  await engine.idle();
});

test('summary of a board, kept on the board and in the export', async () => {
  const board = await newBoard();
  assert.equal((await api('POST', `/api/boards/${board.id}/summary`, {})).status, 400, 'needs two ideas');
  await seed(board.id, 'Lånecyklar');
  await seed(board.id, 'Korsning');
  await engine.idle();
  const { data } = await api('POST', `/api/boards/${board.id}/summary`, {});
  assert.equal(data.board.summary.headline, 'Tavlan rör sig mot ljud.');
  assert.equal(data.board.summary.ideaCount, 2);
  const { data: md } = await api('GET', `/api/boards/${board.id}/export.md`);
  assert.match(md, /## Sammanfattning\n\nTavlan rör sig mot ljud\./);
});

test('dashboard: keyword trends across boards, and drill-down', async () => {
  judgeKeywords = ['Trend Keyword'];
  const b1 = await newBoard({ title: 'D1' });
  const b2 = await newBoard({ title: 'D2' });
  await seed(b1.id, 'Ett');
  await seed(b2.id, 'Två');
  await engine.idle();
  const { data } = await api('GET', '/api/dashboard?days=7');
  const kw = data.keywords.find((k: any) => k.keyword === 'trend keyword');
  assert.equal(kw.count, 2);
  assert.equal(kw.boards, 2);
  assert.equal(kw.recent, 2);
  assert.equal(kw.series.length, 7);
  assert.equal(kw.series.at(-1), 2, 'today');
  const { data: drill } = await api('GET', `/api/keywords/${encodeURIComponent('trend keyword')}/ideas`);
  assert.deepEqual(drill.ideas.map((i: any) => i.boardTitle).sort(), ['D1', 'D2']);
  judgeKeywords = ['public space', 'sound'];
});

test('live events: a browser following a board sees what happens', async () => {
  const board = await newBoard();
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/boards/${board.id}/events`, { signal: ctrl.signal });
  const reader = res.body!.getReader();
  const seen: any[] = [];
  const pump = (async () => {
    let buf = '';
    const dec = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let cut;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        if (chunk.startsWith('data: ')) seen.push(JSON.parse(chunk.slice(6)));
      }
    }
  })();
  await seed(board.id, 'Live');
  await engine.idle();
  await new Promise((r) => setTimeout(r, 50));
  ctrl.abort();
  await pump;
  const types = seen.map((e) => e.type);
  assert.equal(types[0], 'hello');
  assert.ok(types.includes('ideas') && types.includes('judging'), types.join(','));
});

test('provider failures surface with their code, and nothing is half-saved', async () => {
  const board = await newBoard();
  const s = await seed(board.id, 'Frö');
  await engine.idle();
  failNext = new ProviderError('no_key', 'OpenRouter: no API key');
  const r = await api('POST', `/api/ideas/${s.id}/expand`, {});
  assert.equal(r.status, 502);
  assert.equal(r.data.code, 'no_key');
  assert.equal(repo.listIdeas(board.id).length, 1);
});

test('links: fetched and distilled; unreadable links are an error, not a silent text seed', async () => {
  const board = await newBoard();
  const ok = await api('POST', `/api/boards/${board.id}/seed`, { text: 'https://example.com/artikel' });
  assert.equal(ok.data.idea.title, 'Destillerat frö');
  assert.equal((await api('POST', `/api/boards/${board.id}/seed`, { text: 'https://example.com/nej' })).data.code, 'url_unreadable');
  assert.equal((await api('POST', `/api/boards/${board.id}/seed`, { text: 'https://example.com/tom' })).data.code, 'url_no_text');
  await engine.idle();
  assert.equal(repo.listIdeas(board.id).length, 1);
});

test('templates: five defaults (one is the self-improver), editable, the last one stays', async () => {
  const { data } = await api('GET', '/api/templates');
  assert.equal(data.templates.length, 5);
  assert.ok(data.templates.some((t: any) => t.name.startsWith('Självförbättraren')));
  assert.equal((await api('POST', '/api/templates', { name: 'X' })).status, 400);
  const { data: n } = await api('POST', '/api/templates', { name: 'Ny', system: 's', expand: 'e', combine: 'c' });
  const board = await newBoard({ templateId: n.template.id });
  assert.equal(board.config.flowName, 'Ny');
  const all = (await api('GET', '/api/templates')).data.templates;
  for (const t of all.slice(0, -1)) assert.equal((await api('DELETE', `/api/templates/${t.id}`)).status, 200);
  assert.equal((await api('DELETE', `/api/templates/${all.at(-1).id}`)).data.code, 'last_template');
});

test('static files, path traversal, unknown routes', async () => {
  const res = await fetch(base + '/js/score.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type')!, /javascript/);
  assert.ok([403, 404].includes((await fetch(base + '/%2e%2e/package.json')).status));
  assert.equal((await api('GET', '/api/nope')).status, 404);
});

test('report: totals, every project, per-board insights, saved conclusions, Markdown', async () => {
  const { data: before } = await api('GET', '/api/report?days=30');
  assert.ok(before.totals.ideas > 0 && before.totals.boards > 0);
  assert.ok(before.projects.some((p: any) => p.title === 'Sjungande parkbänk'), 'the gold project from earlier is listed');
  assert.ok(before.boards.every((b: any) => Array.isArray(b.best) && b.best.length <= 3));
  const withSummary = before.boards.find((b: any) => b.summary);
  assert.ok(withSummary && typeof withSummary.summary.stale === 'boolean');
  assert.equal(before.synthesis, null);

  const synthCall = (r: ChatRequest) => r.schemaName === 'synthesis';
  const { data: after } = await api('POST', '/api/report/synthesis', { days: 30, lang: 'sv' });
  const call = calls.filter(synthCall).at(-1)!;
  assert.match(call.user, /Sjungande parkbänk/, 'the synthesis sees the boards’ best ideas');
  assert.match(call.user, /Claude Code projects:/);
  assert.equal(call.model, DEFAULT_APP_SETTINGS.models.summary);
  assert.equal(typeof after.synthesis.headline, 'string');
  assert.equal(after.synthesis.days, 30);

  const { data: md } = await api('GET', '/api/report.md?days=30&lang=sv');
  assert.match(md, /^# Rapport · \d{4}-\d{2}-\d{2}/);
  assert.match(md, /## Slutsatser/);
  assert.match(md, /cd ".*sjungande-bank" && claude/);
});

test('a typed seed longer than a title is distilled, never cut off', async () => {
  const board = await newBoard();
  const text = 'When the jury scores an idea, it should also say what would lift it one medal, and the next generation should try exactly that.';
  assert.ok(text.length > 120 && text.length <= 160);
  const { data } = await api('POST', `/api/boards/${board.id}/seed`, { text });
  assert.equal(data.idea.title, 'Destillerat frö');
  assert.ok(calls.some((c) => c.schemaName === 'seed' && c.user.includes('next generation')));
  await engine.idle();
});

test('lift recipes: the jury writes one, offspring get it as their task, and the hit is counted', async () => {
  const { liftStats, liftHit } = await import('../public/js/evolve.js');
  try {
    judgeScores = { originality: 3, feasibility: 3, impact: 3 }; // 9: bronze
    judgeLift = { liftType: 'Feasibility', lift: 'Pilota med en skola i en månad.' };
    const board = await newBoard();
    const s = await seed(board.id, 'Cykelbuss');
    await engine.idle();
    const parent = repo.getIdea(s.id)!;
    assert.equal(parent.recipeType, 'feasibility', 'the type is normalised');
    assert.equal(parent.recipe, 'Pilota med en skola i en månad.');
    assert.match(JSON.stringify(lastCall('judgement').schema), /"liftType"/);

    // Branching hands the recipe on and remembers it.
    judgeScores = { originality: 4, feasibility: 4, impact: 3 }; // 11: silver, a lift from bronze
    judgeLift = { liftType: 'impact', lift: 'Mät minskade bilresor.' };
    const { data } = await api('POST', `/api/ideas/${s.id}/expand`, {});
    assert.match(lastCall('expand').user, /lift recipe for "Cykelbuss"[\s\S]*raising its feasibility[\s\S]*Pilota med en skola/);
    assert.match(lastCall('expand').user, /every new idea must carry out exactly this change/);
    await engine.idle();
    const kids = data.ideas.map((i: any) => repo.getIdea(i.id)!);
    for (const k of kids) {
      assert.deepEqual([k.liftType, k.liftFrom, k.liftBase, k.liftArm], ['feasibility', s.id, 1, 'recipe']);
      assert.equal(liftHit(k), true);
    }
    assert.deepEqual(liftStats(repo.listIdeas(board.id)).feasibility, { tries: 3, hits: 3 });

    // A cross takes the recipe whose type has the better record: the seed's feasibility (3/3), not a child's untried impact.
    const cross = await api('POST', `/api/boards/${board.id}/combine`, { a: kids[0].id, b: s.id });
    assert.match(lastCall('combine').user, /lift recipe for "Cykelbuss"/);
    const child = repo.getIdea(cross.data.idea.id)!;
    assert.deepEqual([child.liftType, child.liftFrom, child.liftBase], ['feasibility', s.id, 1]);
    await engine.idle();

    // A recipe with an unknown type is dropped, not half-saved.
    judgeLift = { liftType: 'charm', lift: 'Gör den gulligare.' };
    const odd = await seed(board.id, 'Konstig idé');
    await engine.idle();
    assert.deepEqual([repo.getIdea(odd.id)!.recipeType, repo.getIdea(odd.id)!.recipe], [null, null]);
  } finally {
    judgeLift = {};
    judgeScores = { originality: 3, feasibility: 3, impact: 3 };
  }
});

test('placebo trials: by lot a breed gets a vague task instead of the recipe, and a parent with no recipe breeds a no-task control', async () => {
  const { liftStats, liftHit, trialStats, armHit } = await import('../public/js/evolve.js');
  const { PLACEBO_TASK } = await import('../server/llm.ts');
  try {
    judgeScores = { originality: 3, feasibility: 3, impact: 3 }; // 9: bronze
    judgeLift = { liftType: 'impact', lift: 'Mät minskade bilresor.' };
    const board = await newBoard();
    const s = await seed(board.id, 'Skolgata');
    await engine.idle();

    // The lot falls on placebo: the prompt holds neither the recipe nor its criterion, only the vague task.
    trialLot = 0;
    judgeScores = { originality: 4, feasibility: 4, impact: 3 }; // 11: silver, the medal rose anyway
    const { data } = await api('POST', `/api/ideas/${s.id}/expand`, {});
    const user = lastCall('expand').user;
    assert.ok(user.includes(PLACEBO_TASK));
    assert.doesNotMatch(user, /Mät minskade bilresor|lift recipe|raising its/);
    await engine.idle();
    for (const i of data.ideas) {
      const k = repo.getIdea(i.id)!;
      assert.deepEqual([k.liftArm, k.liftType, k.liftFrom, k.liftBase], ['placebo', 'impact', s.id, 1], 'remembers the withheld type');
      assert.equal(liftHit(k), null, 'a placebo is not a recipe hit');
      assert.equal(armHit(k), true);
    }
    const ideas = repo.listIdeas(board.id);
    assert.deepEqual(liftStats(ideas).impact, { tries: 0, hits: 0 }, 'placebo luck never steers breeding');
    assert.deepEqual(trialStats(ideas).placebo.byType.impact, { tries: 3, hits: 3 });

    // A bronze parent with no recipe: no task at all, counted in the no-task arm.
    trialLot = 0.99;
    judgeScores = { originality: 3, feasibility: 3, impact: 3 };
    judgeLift = {};
    const bare = await seed(board.id, 'Ingen recept');
    await engine.idle();
    const r2 = await api('POST', `/api/ideas/${bare.id}/expand`, {});
    assert.doesNotMatch(lastCall('expand').user, /Your task|lift recipe/);
    await engine.idle();
    const k = repo.getIdea(r2.data.ideas[0].id)!;
    assert.deepEqual([k.liftArm, k.liftType, k.liftFrom, k.liftBase], ['none', null, bare.id, 1]);
    assert.deepEqual(trialStats(repo.listIdeas(board.id)).none.total, { tries: 3, hits: 0 });
  } finally {
    trialLot = 0.99;
    judgeLift = {};
    judgeScores = { originality: 3, feasibility: 3, impact: 3 };
  }
});

test('recipe check: after the verdict the judge model rules, blind to scores, whether a recipe child applied its recipe; only applied hits count', async () => {
  const { liftStats, liftHit, appliedStats } = await import('../public/js/evolve.js');
  try {
    judgeScores = { originality: 3, feasibility: 3, impact: 3 }; // 9: bronze
    judgeLift = { liftType: 'impact', lift: 'Mät minskade bilresor.' };
    const board = await newBoard();
    const s = await seed(board.id, 'Lånecykel i trapphuset');
    await engine.idle();
    assert.equal(repo.getIdea(s.id)!.liftApplied, null, 'a seed has no recipe task, so no check');
    assert.ok(!calls.some((c) => c.schemaName === 'liftcheck' && c.user.includes('Lånecykel i trapphuset')));

    // The children ignore the recipe; the medal rises anyway.
    judgeScores = { originality: 4, feasibility: 4, impact: 3 }; // 11: silver
    judgeLift = {};
    liftCheckAnswer = { applied: false, reason: 'Ingen mätning av bilresor syns.' };
    const before = calls.length;
    const { data } = await api('POST', `/api/ideas/${s.id}/expand`, {});
    await engine.idle();
    const checks = calls.slice(before).filter((c) => c.schemaName === 'liftcheck');
    assert.equal(checks.length, 3, 'one check per recipe child');
    assert.match(checks[0].user, /Lånecykel i trapphuset[\s\S]*Mät minskade bilresor[\s\S]*Barn/, 'parent, recipe, child');
    assert.doesNotMatch(checks[0].user, /Stark mekanism|silver|bronze|\/15/i, 'blind: no scores, verdict or medal');
    assert.equal(checks[0].model, settings.models.judge);
    for (const i of data.ideas) {
      const k = repo.getIdea(i.id)!;
      assert.deepEqual([k.liftApplied, k.liftCheck], [false, 'Ingen mätning av bilresor syns.']);
      assert.equal(liftHit(k), null, 'an ignored recipe is neither hit nor miss');
    }
    assert.deepEqual(liftStats(repo.listIdeas(board.id)).impact, { tries: 0, hits: 0 });
    const { data: payload } = await api('GET', `/api/boards/${board.id}`);
    assert.equal(payload.ideas.find((i: any) => i.id === data.ideas[0].id).liftApplied, false, 'the board payload carries the ruling');

    // Re-judging does not re-check: the text has not changed.
    const n = calls.length;
    await api('POST', `/api/ideas/${data.ideas[0].id}/judge`, {});
    await engine.idle();
    assert.equal(calls.slice(n).filter((c) => c.schemaName === 'liftcheck').length, 0);

    // Applied children count as hits; a check with no ruling leaves the child unchecked, and it still counts as before.
    liftCheckAnswer = { applied: true, reason: 'Mäter bilresor per vecka.' };
    const cross = await api('POST', `/api/boards/${board.id}/combine`, { a: s.id, b: data.ideas[1].id });
    await engine.idle();
    const applied = repo.getIdea(cross.data.idea.id)!;
    assert.deepEqual([applied.liftArm, applied.liftApplied], ['recipe', true]);
    assert.equal(liftHit(applied), true);
    liftCheckAnswer = null;
    const e2 = await api('POST', `/api/ideas/${s.id}/expand`, {});
    await engine.idle();
    assert.equal(repo.getIdea(e2.data.ideas[0].id)!.liftApplied, null);
    const split = appliedStats(repo.listIdeas(board.id));
    assert.deepEqual(split, { applied: { tries: 1, hits: 1 }, ignored: { tries: 3, hits: 3 }, unchecked: { tries: 3, hits: 3 } });
    assert.deepEqual(liftStats(repo.listIdeas(board.id)).impact, { tries: 4, hits: 4 }, 'applied + unchecked, not ignored');

    // Placebo children get no check (they were told no recipe).
    trialLot = 0;
    const m = calls.length;
    await api('POST', `/api/ideas/${s.id}/expand`, {});
    await engine.idle();
    assert.equal(calls.slice(m).filter((c) => c.schemaName === 'liftcheck').length, 0);

    // A failing check never fails the verdict.
    trialLot = 0.99;
    liftCheckFails = true;
    const e3 = await api('POST', `/api/ideas/${s.id}/expand`, {});
    await engine.idle();
    for (const i of e3.data.ideas) {
      const k = repo.getIdea(i.id)!;
      assert.ok(k.judgedAt && k.originality === 4, 'judged all the same');
      assert.equal(k.liftApplied, null);
    }
  } finally {
    trialLot = 0.99;
    liftCheckAnswer = null;
    liftCheckFails = false;
    judgeLift = {};
    judgeScores = { originality: 3, feasibility: 3, impact: 3 };
  }
});

test('lift recipes: an old database gets the new columns', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const file = join(mkdtempSync(join(tmpdir(), 'ideagen-olddb-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE ideas (
    id INTEGER PRIMARY KEY, board_id INTEGER NOT NULL, title TEXT NOT NULL, pitch TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL, source_url TEXT, x REAL NOT NULL DEFAULT 0, y REAL NOT NULL DEFAULT 0,
    originality INTEGER, feasibility INTEGER, impact INTEGER, reason TEXT, judged_at TEXT, medal_override INTEGER,
    generation INTEGER NOT NULL DEFAULT 0, project_path TEXT, origin_idea_id INTEGER, origin_board_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  old.close();
  const r = openDb(file);
  const b = r.createBoard({ title: 'Gammal' });
  const i = r.insertIdea({ boardId: b.id, title: 'T', pitch: '', kind: 'seed', x: 0, y: 0, generation: 0 });
  r.saveJudgement(i.id, { originality: 3, feasibility: 3, impact: 3, reason: 'r', liftType: 'impact', lift: 'Gör så.' });
  const got = r.getIdea(i.id)!;
  assert.deepEqual([got.recipeType, got.recipe, got.liftType], ['impact', 'Gör så.', null]);
  assert.equal(got.retrial, null);
  r.saveRetrial(i.id, { originality: 2, feasibility: 3, impact: 3, reason: 'r2', model: 'm', at: 'now' });
  assert.equal(r.getIdea(i.id)!.retrial!.originality, 2, 'the retrial column was added too');
  const k = r.insertIdea({ boardId: b.id, title: 'K', pitch: '', kind: 'expand', x: 0, y: 0, generation: 1, lift: { type: 'impact', from: i.id, base: 1, arm: 'placebo' } }, [i.id]);
  assert.equal(r.getIdea(k.id)!.liftArm, 'placebo', 'the lift_arm column was added too');
  assert.equal(r.getIdea(k.id)!.liftApplied, null);
  r.saveLiftCheck(k.id, { applied: true, reason: 'Ja.' });
  assert.deepEqual([r.getIdea(k.id)!.liftApplied, r.getIdea(k.id)!.liftCheck], [true, 'Ja.'], 'the recipe-check columns were added too');
  const e = r.insertIdea({ boardId: b.id, title: 'E', pitch: '', kind: 'expand', x: 0, y: 0, generation: 1, escape: 'lift recipe' }, [i.id]);
  assert.equal(r.getIdea(e.id)!.escape, 'lift recipe', 'the escape column was added too');
  assert.equal(got.escape, null);
});

test('second opinion: an edge verdict on a self-improvement board is re-scored blind by the retrial model', async () => {
  const { confidenceBand } = await import('../public/js/score.js');
  const { breedScore } = await import('../public/js/evolve.js');
  try {
    judgeScores = { originality: 4, feasibility: 4, impact: 3 }; // 11: exactly on silver
    retrialScores = { originality: 3, feasibility: 3, impact: 3 }; // 9
    const configured = async (config: object) => {
      const b = await newBoard();
      return (await api('PATCH', `/api/boards/${b.id}`, { config })).data.board;
    };
    const self = await configured({ selfImprove: true });
    assert.equal(self.config.selfImprove, true);
    const before = calls.length;
    const s = await seed(self.id, 'Juryn tvivlar');
    await engine.idle();
    const judgeCalls = calls.slice(before).filter((c) => c.schemaName === 'judgement');
    assert.deepEqual(judgeCalls.map((c) => c.model), ['claudecode:sonnet', 'claudecode:opus'], 'jury first, then the second judge on another model');
    assert.doesNotMatch(judgeCalls[1].user, /Stark mekanism|11/, 'blind: the second judge never sees the first verdict');
    const idea = repo.getIdea(s.id)!;
    assert.deepEqual([idea.retrial!.originality, idea.retrial!.feasibility, idea.retrial!.impact, idea.retrial!.model], [3, 3, 3, 'claudecode:opus']);
    assert.equal(idea.retrial!.reason, 'Andra domaren tvekar.');
    assert.equal(idea.originality, 4, "the jury's own scores are untouched");
    assert.deepEqual(confidenceBand(idea), { first: 11, second: 9, low: 9, high: 11, gap: 2, medals: [1, 2], agree: false });
    assert.equal(breedScore(idea, {}), 10);
    // The board payload carries the second opinion, and the export does not break.
    const { data } = await api('GET', `/api/boards/${self.id}`);
    assert.equal(data.ideas.find((i: any) => i.id === s.id).retrial.impact, 3);
    assert.deepEqual(data.retrying, []);

    // Re-judging makes a new verdict: the old second opinion is cleared, then asked again (still on the edge).
    retrialScores = { originality: 4, feasibility: 4, impact: 3 };
    await api('POST', `/api/ideas/${s.id}/judge`, {});
    await engine.idle();
    assert.equal(confidenceBand(repo.getIdea(s.id)!)!.gap, 0);

    // Off the edge (10): no second opinion.
    judgeScores = { originality: 4, feasibility: 3, impact: 3 };
    const n = calls.length;
    const off = await seed(self.id, 'Mitt emellan');
    await engine.idle();
    assert.equal(calls.slice(n).filter((c) => c.schemaName === 'judgement').length, 1);
    assert.equal(repo.getIdea(off.id)!.retrial, null);

    // Same model for both roles: no point in asking twice.
    judgeScores = { originality: 3, feasibility: 3, impact: 3 };
    const same = await configured({ selfImprove: true, models: { retrial: 'claudecode:sonnet' } });
    assert.equal(same.config.models.retrial, 'claudecode:sonnet');
    const m = calls.length;
    await seed(same.id, 'Samma domare');
    await engine.idle();
    assert.equal(calls.slice(m).filter((c) => c.schemaName === 'judgement').length, 1);
  } finally {
    judgeScores = { originality: 3, feasibility: 3, impact: 3 };
    retrialScores = null;
  }
});

test('contested gold: a 13 the second judge put below gold is listed for a human in /api/builds', async () => {
  try {
    judgeScores = { originality: 5, feasibility: 4, impact: 4 }; // 13
    retrialScores = { originality: 4, feasibility: 4, impact: 4 }; // 12
    const b = await newBoard();
    await api('PATCH', `/api/boards/${b.id}`, { config: { selfImprove: true } });
    const s = await seed(b.id, 'Omstritt guld');
    await engine.idle();
    const { data } = await api('GET', '/api/builds');
    const c = data.contested.find((x: any) => x.id === s.id);
    assert.deepEqual([c.first, c.second, c.model, c.boardId], [13, 12, 'claudecode:opus', b.id]);
    // Agreement is not contested.
    retrialScores = { originality: 5, feasibility: 4, impact: 4 };
    const ok = await seed(b.id, 'Enigt guld');
    await engine.idle();
    assert.equal((await api('GET', '/api/builds')).data.contested.some((x: any) => x.id === ok.id), false);
  } finally {
    judgeScores = { originality: 3, feasibility: 3, impact: 3 };
    retrialScores = null;
  }
});

test('second opinion: on other boards only by hand, and only for judged ideas', async () => {
  try {
    judgeScores = { originality: 5, feasibility: 4, impact: 4 }; // 13: gold edge, but an ordinary board
    retrialScores = { originality: 4, feasibility: 3, impact: 4 };
    const board = await newBoard();
    await api('PATCH', `/api/boards/${board.id}`, { config: { autoProjectOnGold: false } });
    const s = await seed(board.id, 'Vanlig tavla');
    await engine.idle();
    assert.equal(repo.getIdea(s.id)!.retrial, null, 'no automatic second opinion off self-improvement boards');
    const r = await api('POST', `/api/ideas/${s.id}/retrial`, {});
    assert.equal(r.status, 200);
    assert.equal(r.data.idea.retrial.feasibility, 3);
    assert.equal(lastCall('judgement').model, 'claudecode:opus');

    const raw = repo.insertIdea({ boardId: board.id, title: 'Obedömd', pitch: '', kind: 'seed', x: 0, y: 0, generation: 0 });
    const bad = await api('POST', `/api/ideas/${raw.id}/retrial`, {});
    assert.equal(bad.status, 400);
    assert.equal(bad.data.error?.code ?? bad.data.code, 'not_judged');
  } finally {
    judgeScores = { originality: 3, feasibility: 3, impact: 3 };
    retrialScores = null;
  }
});
