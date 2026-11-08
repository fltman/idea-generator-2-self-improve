// The Claude Code provider against a fake `claude` CLI: the arguments we pass,
// stdin, structured output, cost, and how failures map to provider codes.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_APP_SETTINGS, claudeCodeArgs, listModels, makeChat, parseModel, ProviderError, type AppSettings } from '../server/providers.ts';

const dir = mkdtempSync(join(tmpdir(), 'ideagen-cc-'));
const fake = join(dir, 'claude');
const seenFile = join(dir, 'seen.json');

before(() => {
  // Behaves like `claude -p --output-format json`, steered by FAKE_CC_MODE.
  writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('9.9.9 (Claude Code)'); process.exit(0); }
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(seenFile)}, JSON.stringify({ args, input, cwd: process.cwd() }));
  const mode = process.env.FAKE_CC_MODE || 'ok';
  const out = (o) => console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.0042, ...o }));
  if (mode === 'ok') out({ result: '{"title":"ignored"}', structured_output: { title: 'Från Claude Code' } });
  else if (mode === 'text') out({ result: '\`\`\`json\\n{"title":"Ur text"}\\n\`\`\`' });
  else if (mode === 'error') out({ is_error: true, subtype: 'error_during_execution', result: 'API Error: 500' });
  else if (mode === 'limit') out({ is_error: true, result: 'Claude usage limit reached' });
  else if (mode === 'login') { console.error('Invalid API key · Please run /login'); process.exit(1); }
});
`);
  chmodSync(fake, 0o755);
});

const schema = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false };
const req = { model: 'claudecode:sonnet', system: 'Du är en jury.', user: 'Bedöm: cykelbibliotek', schemaName: 'idea', schema, temperature: 0.2 };
const settings = (cmd = fake): AppSettings => ({ ...structuredClone(DEFAULT_APP_SETTINGS), baseUrls: { ...DEFAULT_APP_SETTINGS.baseUrls, claudecode: cmd } });
const chatWith = (mode: string, cmd = fake) => {
  process.env.FAKE_CC_MODE = mode;
  return makeChat(() => settings(cmd))(req);
};

test('this fork defaults every role but the X scout to Claude Code', () => {
  for (const [role, model] of Object.entries(DEFAULT_APP_SETTINGS.models)) {
    assert.equal(parseModel(model).provider, role === 'x' ? 'openrouter' : 'claudecode', role);
  }
  assert.deepEqual(parseModel('claudecode:claude-opus-5-5'), { provider: 'claudecode', model: 'claude-opus-5-5' });
});

test('claudecode: no tools, no settings, system prompt and schema as flags, the user text on stdin', async () => {
  const r = await chatWith('ok');
  assert.deepEqual(r.value, { title: 'Från Claude Code' });
  assert.equal(r.costUsd, 0.0042);
  const seen = JSON.parse(readFileSync(seenFile, 'utf8'));
  assert.equal(seen.input, 'Bedöm: cykelbibliotek');
  assert.deepEqual(seen.args, claudeCodeArgs('sonnet', req));
  const at = (flag: string) => seen.args[seen.args.indexOf(flag) + 1];
  assert.equal(at('--model'), 'sonnet');
  assert.equal(at('--tools'), '');
  assert.equal(at('--setting-sources'), '');
  assert.equal(at('--system-prompt'), 'Du är en jury.');
  assert.deepEqual(JSON.parse(at('--json-schema')), schema);
  assert.ok(seen.args.includes('--no-session-persistence') && seen.args.includes('--strict-mcp-config'));
  assert.ok(!seen.cwd.includes('idea-generator'), 'runs outside the project so no CLAUDE.md leaks in');
});

test('claudecode: falls back to JSON in the text result', async () => {
  assert.deepEqual((await chatWith('text')).value, { title: 'Ur text' });
});

test('claudecode: errors keep a useful code', async () => {
  await assert.rejects(chatWith('error'), (e: any) => e instanceof ProviderError && e.code === 'provider_error' && /500/.test(e.message));
  await assert.rejects(chatWith('limit'), (e: any) => e.code === 'rate_limited');
  await assert.rejects(chatWith('login'), (e: any) => e.code === 'bad_key');
  await assert.rejects(chatWith('ok', join(dir, 'no-such-claude')), (e: any) => e.code === 'unreachable');
  await assert.rejects(makeChat(() => settings())({ ...req, plugins: [{ id: 'web' }] }), (e: any) => e.code === 'no_search');
});

test('claudecode: the connection test runs --version and lists the aliases', async () => {
  const models = await listModels(settings(), 'claudecode');
  assert.ok(models.includes('sonnet') && models.includes('opus'));
  await assert.rejects(listModels(settings(join(dir, 'nope')), 'claudecode'), (e: any) => e.code === 'unreachable');
});
