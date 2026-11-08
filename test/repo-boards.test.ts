// Codebase boards: scan a folder, analyse it, create a board from the picked
// directions, and log gold ideas to a file. Fake LLM, temp folders, no network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, mergeConfig, defaultConfig } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { createAutopilot } from '../server/autopilot.ts';
import { createHandler } from '../server/app.ts';
import { scanRepo, scanText } from '../server/reposcan.ts';
import { DEFAULT_APP_SETTINGS, type ChatRequest } from '../server/providers.ts';

// A small fake codebase: a README, a package.json with tests, source files, and things the scan must skip.
const code = mkdtempSync(join(tmpdir(), 'ideagen-code-'));
writeFileSync(join(code, 'README.md'), '# Bikeshare\nA tiny app that books city bikes.\n' + 'Riders pick a station and a time. '.repeat(70));
writeFileSync(join(code, 'package.json'), JSON.stringify({ name: 'bikeshare', scripts: { test: 'node --test' } }));
mkdirSync(join(code, 'src'));
writeFileSync(join(code, 'src', 'server.ts'), 'export {}');
writeFileSync(join(code, 'src', 'ui.js'), 'export {}');
mkdirSync(join(code, 'node_modules', 'big'), { recursive: true });
writeFileSync(join(code, 'node_modules', 'big', 'index.js'), 'secret');
mkdirSync(join(code, '.git'));
writeFileSync(join(code, '.git', 'config'), '[core]');
writeFileSync(join(code, '.env'), 'API_KEY=hush');
const outside = mkdtempSync(join(tmpdir(), 'ideagen-outside-'));
writeFileSync(join(outside, 'private.txt'), 'not yours');
symlinkSync(outside, join(code, 'linked'));

const calls: ChatRequest[] = [];
let judgeScores = { originality: 3, feasibility: 3, impact: 3 };
async function fakeChat(r: ChatRequest) {
  calls.push(r);
  const value =
    r.schemaName === 'repoanalysis' ? {
      summary: 'A city bike booking app.', stack: 'TypeScript on Node, node --test.',
      focuses: [
        { label: 'New features', why: 'Only booking exists.', seed: 'Let riders reserve a bike for later' },
        { label: 'Performance', why: 'One server file.', seed: 'Cache the station list' },
        { label: '', why: 'dropped', seed: 'x' },
      ],
    }
    : r.schemaName === 'judgement' ? { reason: 'Clear and contained.', ...judgeScores, keywords: ['bikes'] }
    : { title: 'Idea', pitch: 'A pitch.' };
  return { value, costUsd: 0.001, citations: [] };
}

const goldRoot = mkdtempSync(join(tmpdir(), 'ideagen-gold-'));
const settings = structuredClone(DEFAULT_APP_SETTINGS);
const runtime = { get: () => settings, set: () => {}, received: () => true };
const repo = openDb(':memory:');
const engine = createEngine({ repo, chat: fakeChat, settings: () => settings, gitInit: false, goldRoot, trialRng: () => 0.99, duelRng: () => 0.9, styleRng: () => 0 });
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
  const res = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}

test('scan: reads the README and manifest, lists source files, skips node_modules, .git, dotfiles and symlinks', () => {
  const s = scanRepo(code);
  assert.equal(s.name, code.split('/').pop());
  assert.deepEqual(s.docs.map((d) => d.file), ['README.md', 'package.json']);
  assert.equal(s.testCommand, 'npm test');
  assert.match(s.tree, /src\/\n {2}server\.ts\n {2}ui\.js/);
  const text = scanText(s);
  for (const hidden of ['node_modules', 'secret', '.git', 'API_KEY', '.env', 'linked', 'not yours']) assert.ok(!text.includes(hidden), `scan leaks ${hidden}`);
  assert.equal(s.files, 4, 'README, package.json and the two source files');
});

test('scan: with little documentation it reads the start of the likeliest entry points', () => {
  const tiny = mkdtempSync(join(tmpdir(), 'ideagen-tiny-'));
  writeFileSync(join(tiny, 'index.html'), '<title>Four in a row</title>' + 'x'.repeat(5000));
  writeFileSync(join(tiny, 'zzz.js'), 'helper');
  writeFileSync(join(tiny, '.env'), 'TOKEN=1');
  const s = scanRepo(tiny);
  assert.deepEqual(s.docs.map((d) => d.file), ['index.html', 'zzz.js'], 'entry point first, dotfiles never');
  assert.ok(s.docs[0].text.startsWith('<title>Four in a row</title>'));
  assert.ok(s.docs[0].text.length < 3100, 'samples are cut');
  assert.equal(scanRepo(code).docs.length, 2, 'a documented codebase gets no code samples');
});

test('scan: refuses relative paths, missing folders and files', () => {
  assert.throws(() => scanRepo('code/app'), /full path/);
  assert.throws(() => scanRepo(join(code, 'nope')), /No such folder/);
  assert.throws(() => scanRepo(join(code, 'README.md')), /Not a folder/);
});

test('analyze: the model sees the scan, never the skipped files; answers come back cleaned', async () => {
  const r = await api('POST', '/api/repo/analyze', { path: code, lang: 'en' });
  assert.equal(r.status, 200);
  assert.equal(r.data.scan.files, 4);
  assert.equal(r.data.scan.testCommand, 'npm test');
  assert.deepEqual(r.data.analysis.focuses.map((f: any) => f.label), ['New features', 'Performance'], 'a direction with no label is dropped');
  const call = calls.find((c) => c.schemaName === 'repoanalysis')!;
  assert.match(call.user, /A tiny app that books city bikes/);
  assert.ok(!call.user.includes('API_KEY') && !call.user.includes('secret'));
  assert.match(call.user, /Write in English/);
  const bad = await api('POST', '/api/repo/analyze', { path: 'relative/path' });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.code, 'bad_path');
});

test('create: the board carries the scan, the picked directions and a gold file; one seed per direction, autopilot on', async () => {
  const r = await api('POST', '/api/boards/repo', {
    path: code, lang: 'en', summary: 'A city bike booking app.', stack: 'TypeScript',
    focuses: [{ label: 'New features', seed: 'Let riders reserve a bike for later' }], extra: 'Make it work offline',
  });
  assert.equal(r.status, 200);
  const b = r.data.board;
  assert.equal(b.config.mode, 'auto');
  assert.equal(b.config.autoProjectOnGold, false, 'gold goes to the file, not to new project folders');
  assert.equal(b.config.repo.path, code);
  assert.deepEqual(b.config.repo.focus, ['New features', 'Make it work offline']);
  assert.equal(b.config.repo.goldFile, join(goldRoot, `board-${b.id}-${b.config.repo.name.toLowerCase()}.md`));
  assert.match(b.goal, /New features; Make it work offline/);
  assert.match(b.config.judgeGuidance, /codebase/);
  await engine.idle();
  const { ideas } = (await api('GET', `/api/boards/${b.id}`)).data;
  assert.deepEqual(ideas.map((i: any) => i.title).sort(), ['Let riders reserve a bike for later', 'Make it work offline']);
  // Every prompt on the board, the jury's included, knows the code and the directions.
  const judge = [...calls].reverse().find((c) => c.schemaName === 'judgement')!;
  assert.match(judge.system + judge.user, /A tiny app that books city bikes/);
  assert.match(judge.system + judge.user, /New features; Make it work offline/);
  const none = await api('POST', '/api/boards/repo', { path: code, focuses: [] });
  assert.equal(none.data.code, 'no_focus');
});

test('gold on a codebase board is appended to its gold file once, from the jury or by hand', async () => {
  judgeScores = { originality: 5, feasibility: 4, impact: 5 };
  const { board } = (await api('POST', '/api/boards/repo', { path: code, lang: 'en', focuses: [{ label: 'Performance', seed: 'Cache the station list' }] })).data;
  await engine.idle();
  const file = board.config.repo.goldFile;
  assert.ok(existsSync(file), 'the jury\'s gold was logged');
  let text = readFileSync(file, 'utf8');
  assert.match(text, /^# Gold ideas for /);
  assert.match(text, /## Cache the station list/);
  assert.match(text, /5\/4\/5 \(14\/15\)/);
  const idea = (await api('GET', `/api/boards/${board.id}`)).data.ideas[0];
  await api('POST', `/api/ideas/${idea.id}/judge`);
  await api('PATCH', `/api/ideas/${idea.id}`, { medalOverride: 3 });
  text = readFileSync(file, 'utf8');
  assert.equal(text.split('## Cache the station list').length - 1, 1, 'logged once, however often it turns gold');
  judgeScores = { originality: 3, feasibility: 3, impact: 3 };
});

test('config: a repo needs an absolute path, and ordinary boards have none', () => {
  assert.equal(defaultConfig().repo, null);
  assert.equal(mergeConfig(defaultConfig(), { repo: { path: 'relative' } }).repo, null);
  const c = mergeConfig(defaultConfig(), { repo: { path: '/code/app', goldFile: 'gold.md', focus: ['a', 5, 'b'] } });
  assert.equal(c.repo!.name, 'app');
  assert.equal(c.repo!.goldFile, '', 'a relative gold file is refused');
  assert.deepEqual(c.repo!.focus, ['a', 'b']);
  assert.equal(mergeConfig(c, { mode: 'auto' }).repo!.path, '/code/app', 'other patches keep the repo');
  assert.equal(mergeConfig(c, { repo: null }).repo, null);
});
