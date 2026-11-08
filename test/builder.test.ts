// The self-improvement loop end to end, without a real agent: a throwaway git
// repository stands in for the app, and a fake `claude -p` writes code, a
// journal and commits. The builder must verify, merge or refuse by itself.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { createBuilder, describeEvent, selfContext, type BuildEvent } from '../server/builder.ts';
import { DEFAULT_APP_SETTINGS, type ChatRequest } from '../server/providers.ts';

const app = mkdtempSync(join(tmpdir(), 'ideagen-selfapp-'));
const agentFile = join(mkdtempSync(join(tmpdir(), 'ideagen-agent-')), 'agent.mjs');
const git = (...args: string[]) => execFileSync('git', args, { cwd: app, encoding: 'utf8' }).trim();

before(() => {
  // A tiny "app": tests fail if BROKEN exists; the server answers / and /api/boards.
  writeFileSync(join(app, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node check.js' } }));
  writeFileSync(join(app, 'check.js'), "import { existsSync } from 'node:fs';\nif (existsSync('BROKEN')) { console.log('ℹ fail 1'); process.exit(1); }\nconsole.log('ℹ tests 1\\nℹ pass 1');\n");
  mkdirSync(join(app, 'server'));
  writeFileSync(join(app, 'server', 'index.ts'), "import { createServer } from 'node:http';\ncreateServer((q, s) => { s.writeHead(200); s.end('{}'); }).listen(Number(process.env.PORT), '127.0.0.1');\n");
  writeFileSync(join(app, 'README.md'), '# App\n\n## What it does\n\n- Seeds ideas and judges them.\n\n## Run\n\nnpm start\n');
  writeFileSync(join(app, '.gitignore'), 'data/\nnode_modules/\n'); // the trailing slash does not ignore a symlink: the guard must
  mkdirSync(join(app, 'node_modules'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');

  // The fake agent: reads the prompt, acts by FAKE_AGENT_MODE, speaks stream-json.
  writeFileSync(agentFile, `
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
let prompt = '';
for await (const c of process.stdin) prompt += c;
const jdir = /Journal folder: \`([^\`]+)\\/\`/.exec(prompt)[1];
const mode = process.env.FAKE_AGENT_MODE;
const say = (o) => console.log(JSON.stringify(o));
say({ type: 'system', subtype: 'init', session_id: 'sess-' + mode, model: 'fake-opus' });
say({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reading CLAUDE.md first.' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } });
mkdirSync(jdir, { recursive: true });
writeFileSync(jdir + '/README.md', '# Journal\\n\\nMode: ' + mode + '\\n');
if (mode !== 'decline') {
  writeFileSync('feature-' + mode + '.txt', 'new feature\\n');
  writeFileSync(jdir + '/02-after.png', 'png');
  if (mode === 'broken') writeFileSync('BROKEN', '');
  if (mode === 'sneaky') { mkdirSync('data', { recursive: true }); writeFileSync('data/leak.db', 'x'); execFileSync('git', ['add', '-f', 'data/leak.db']); }
  if (mode !== 'nocommit') {
    execFileSync('git', ['add', '-A']);
    execFileSync('git', ['commit', '-q', '-m', 'Build: ' + mode]);
  }
}
say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: process.cwd() + '/server/index.ts' } }] } });
say({ type: 'result', subtype: 'success', is_error: false, num_turns: 7, total_cost_usd: 1.25,
  structured_output: { status: mode === 'decline' ? 'declined' : 'done', summary: 'Summary for ' + mode, filmLine: 'It worked.' } });
`);
});

const repo = openDb(':memory:');
const events: BuildEvent[] = [];
const builder = createBuilder({
  repo, root: app, emit: (e) => events.push(e),
  agent: { cmd: process.execPath, args: () => [agentFile] },
});
const selfBoard = repo.createBoard({ title: 'Self', goal: 'Make the app better', config: { selfImprove: true, buildsPerDay: 1 } });
const plainBoard = repo.createBoard({ title: 'Plain', goal: 'Benches' });
const idea = (title: string, boardId = selfBoard.id) => repo.insertIdea({ boardId, title, pitch: `${title} pitch`, kind: 'seed', x: 0, y: 0, generation: 0 });

async function buildWith(mode: string, title: string) {
  process.env.FAKE_AGENT_MODE = mode;
  const r = builder.enqueue(idea(title).id, 'hand');
  assert.ok(r.build, r.reason);
  await builder.idle();
  return repo.getBuild(r.build!.id)!;
}

test('a passing build is verified, merged into main, and journaled', async () => {
  const b = await buildWith('good', 'Lineage replay');
  assert.equal(b.status, 'merged', b.error ?? '');
  assert.equal(b.seq, 1);
  assert.equal(b.branch, 'build/0001-lineage-replay');
  assert.equal(b.sessionId, 'sess-good');
  assert.equal(b.costUsd, 1.25);
  assert.equal(b.summary, 'Summary for good');
  assert.match(b.tests ?? '', /pass 1/);
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.ok(existsSync(join(app, 'feature-good.txt')), 'the feature is in main');
  const meta = JSON.parse(readFileSync(join(app, 'journal', '0001-lineage-replay', 'build.json'), 'utf8'));
  assert.equal(meta.status, 'merged');
  assert.equal(meta.filmLine, 'It worked.');
  assert.match(readFileSync(join(app, 'journal', 'INDEX.md'), 'utf8'), /0001 \| \[Lineage replay\]\(0001-lineage-replay\/README.md\) \| ✅ merged/);
  assert.match(git('log', '-1', '--format=%s', 'main'), /^Build 0001: Lineage replay/);
  assert.equal(git('status', '--porcelain'), '', 'nothing left behind in main');
  assert.ok(!existsSync(join(app, 'data', 'worktrees', '0001-lineage-replay')), 'worktree removed');
  assert.ok(git('branch', '--list', 'build/0001-lineage-replay'), 'branch kept');
  const lines = events.filter((e) => e.type === 'buildLog').flatMap((e: any) => e.lines);
  assert.ok(lines.includes('$ npm test') && lines.includes('✏️ Edit server/index.ts') && lines.some((l) => l.startsWith('🎉 merged')));
});

test('uncommitted work is committed for the agent and still verified', async () => {
  const b = await buildWith('nocommit', 'Lazy agent');
  assert.equal(b.status, 'merged', b.error ?? '');
  assert.ok(existsSync(join(app, 'feature-nocommit.txt')));
});

test('a build whose tests fail never reaches main, but its journal does', async () => {
  const head = git('rev-parse', 'main');
  const b = await buildWith('broken', 'Breaks everything');
  assert.equal(b.status, 'failed');
  assert.equal(b.error, 'Tests failed');
  assert.ok(!existsSync(join(app, 'BROKEN')) && !existsSync(join(app, 'feature-broken.txt')));
  assert.equal(git('log', '-1', '--format=%s', 'main'), 'Journal: build 0003 failed');
  assert.equal(git('rev-parse', 'main~1'), head, 'only the journal commit landed');
  const meta = JSON.parse(readFileSync(join(app, 'journal', '0003-breaks-everything', 'build.json'), 'utf8'));
  assert.equal(meta.status, 'failed');
  assert.ok(existsSync(join(app, 'journal', '0003-breaks-everything', '02-after.png')), "the agent's screenshots are kept");
});

test('a branch that commits node_modules or data/ is refused, never merged', async () => {
  const head = git('rev-parse', 'main');
  const b = await buildWith('sneaky', 'Commits its data');
  assert.equal(b.status, 'failed');
  assert.match(b.error ?? '', /never commit: data\/leak.db/);
  assert.ok(!existsSync(join(app, 'feature-sneaky.txt')));
  assert.equal(git('rev-parse', 'main~1'), head, 'only the journal commit landed');
});

test('the linked node_modules is never committed for the agent', async () => {
  const b = await buildWith('nocommit', 'Lazy agent again');
  assert.equal(b.status, 'merged', b.error ?? '');
  assert.equal(git('ls-files', 'node_modules'), '');
});

test('a declined idea is documented, not built', async () => {
  const b = await buildWith('decline', 'Impossible idea');
  assert.equal(b.status, 'declined');
  assert.match(readFileSync(join(app, 'journal', '0006-impossible-idea', 'README.md'), 'utf8'), /Mode: decline/);
  assert.match(readFileSync(join(app, 'journal', 'INDEX.md'), 'utf8'), /🚫 declined/);
});

test('enqueue rules: self-improvement boards only, no duplicates, the jury has a daily cap', () => {
  assert.equal(builder.enqueue(idea('Bench', plainBoard.id).id, 'hand').reason, 'not_self_improve');
  const merged = repo.listBuilds().find((b) => b.status === 'merged')!;
  assert.equal(builder.enqueue(merged.ideaId!, 'hand').reason, 'exists');
  process.env.FAKE_AGENT_MODE = 'good';
  const first = builder.enqueue(idea('Jury pick 1').id, 'jury');
  assert.ok(first.build);
  assert.equal(builder.enqueue(idea('Jury pick 2').id, 'jury').reason, 'daily_cap');
  builder.cancel(first.build!.id);
});

test('the self context carries the README features and what the loop has built', () => {
  const ctx = selfContext(app);
  assert.match(ctx, /Seeds ideas and judges them/);
  assert.match(ctx, /0001 Lineage replay: Summary for good/);
  assert.doesNotMatch(ctx, /Breaks everything/, 'only merged builds count as built');
});

test('agent events become short log lines', () => {
  const wt = '/w';
  assert.deepEqual(describeEvent({ type: 'assistant', message: { content: [
    { type: 'text', text: '  Plan:\n  do it ' }, { type: 'tool_use', name: 'Read', input: { file_path: '/w/server/llm.ts' } },
    { type: 'tool_use', name: 'TodoWrite', input: { todos: [{ status: 'in_progress', content: 'Write tests' }] } },
    { type: 'tool_use', name: 'StructuredOutput', input: {} },
  ] } }, wt), ['💬 Plan: do it', '📖 server/llm.ts', '☑ Write tests']);
  assert.deepEqual(describeEvent({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'Permission denied' }] } }, wt), ['⚠ Permission denied']);
});

test('the engine sends gold on a self-improvement board to the builder, with the app as context', async () => {
  const seen: ChatRequest[] = [];
  const gold: number[] = [];
  const chat = async (r: ChatRequest) => {
    seen.push(r);
    // 14: a clear gold, built at once (a 13 waits for the second judge; see the next test).
    const value = r.schemaName === 'judgement' ? { reason: 'r', originality: 5, feasibility: 5, impact: 4, keywords: ['x'] }
      : { ideas: [{ title: 'A', pitch: 'a' }, { title: 'B', pitch: 'b' }, { title: 'C', pitch: 'c' }] };
    return { value, costUsd: 0 };
  };
  const engine = createEngine({ repo, chat, settings: () => DEFAULT_APP_SETTINGS, gitInit: false, onGold: (i) => gold.push(i.id), selfContext: () => 'APP CONTEXT' });
  const self = idea('Self idea');
  await engine.judge(self.id);
  assert.deepEqual(gold, [self.id]);
  const byHand = idea('Hand-picked');
  engine.setMedal(byHand.id, 3);
  assert.deepEqual(gold, [self.id, byHand.id], 'gold set by hand also builds');
  assert.match(seen.at(-1)!.system, /APP CONTEXT/, 'the jury knows the app');
  assert.match(seen.at(-1)!.user, /Write the reason in Swedish\./, "the board's language wins");
  await engine.expand(self.id);
  assert.match(seen.find((r) => r.schemaName === 'expand')!.system, /APP CONTEXT/);
  assert.match(seen.find((r) => r.schemaName === 'expand')!.user, /Write in Swedish, even when the source ideas are in another language/);
  await engine.idle();

  const plain = idea('Plain idea', plainBoard.id);
  seen.length = 0;
  repo.updateBoard(plainBoard.id, { config: { autoProjectOnGold: false } });
  await engine.judge(plain.id);
  assert.deepEqual(gold.filter((id) => id === plain.id), [], 'other boards never build into the app');
  assert.doesNotMatch(seen[0].system, /APP CONTEXT/);
});

test('a jury gold on the edge waits for the blind second judge: built if both say gold, contested if not', async () => {
  const { judge, retrial } = DEFAULT_APP_SETTINGS.models;
  assert.notEqual(judge, retrial, 'the defaults use two different judges');
  const gold: { id: number; by: string }[] = [];
  let second = { originality: 5, feasibility: 4, impact: 4 };
  let release!: () => void;
  let held = new Promise<void>((r) => (release = r));
  const chat = async (r: ChatRequest) => {
    if (r.model === retrial) await held; // the second judge answers when the test lets it
    const s = r.model === retrial ? second : { originality: 5, feasibility: 4, impact: 4 }; // the jury: exactly 13
    return { value: { reason: 'r', ...s, keywords: ['x'] }, costUsd: 0 };
  };
  const engine = createEngine({ repo, chat, settings: () => DEFAULT_APP_SETTINGS, gitInit: false, onGold: (i, by) => gold.push({ id: i.id, by }) });
  const events: any[] = [];
  engine.bus.on(selfBoard.id, (e) => events.push(e));

  // Agreed: no build until the second judge has answered, then one by the jury.
  const agreed = idea('Edge gold, agreed');
  await engine.judge(agreed.id);
  assert.deepEqual(gold, [], 'a 13 does not build before the second opinion');
  release();
  await engine.idle();
  assert.deepEqual(gold, [{ id: agreed.id, by: 'jury' }]);

  // Contested: the second judge says silver, so nothing is built and the board hears about it.
  second = { originality: 4, feasibility: 4, impact: 4 };
  held = Promise.resolve();
  const contested = idea('Edge gold, contested');
  await engine.judge(contested.id);
  await engine.idle();
  assert.deepEqual(gold.map((g) => g.id), [agreed.id], 'a contested gold waits for a human');
  const e = events.find((x) => x.type === 'contested');
  assert.deepEqual([e.ideaId, e.first, e.second], [contested.id, 13, 12]);
  assert.equal(repo.getIdea(contested.id)!.originality, 5, "the jury's medal is untouched");

  // A person can still hand it gold, which builds at once.
  engine.setMedal(contested.id, 3);
  assert.deepEqual(gold.at(-1), { id: contested.id, by: 'hand' });
});
