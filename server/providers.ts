// One chat interface over many providers. A model is written "provider:model",
// e.g. "openrouter:anthropic/claude-sonnet-5.5", "anthropic:claude-opus-5-5",
// "ollama:qwen3:8b", "claudecode:sonnet". A bare "vendor/model" means OpenRouter.
//
// claudecode runs the local Claude Code CLI headless (`claude -p`), so the
// models come from the user's own Claude login: no API key in this app.
//
// App settings (keys, base URLs, models per role) live in the BROWSER's
// localStorage and are pushed to the server, which keeps them in memory only.
// Environment variables are a fallback for keys.

import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import Anthropic from '@anthropic-ai/sdk';

export type ProviderId = 'claudecode' | 'openrouter' | 'anthropic' | 'openai' | 'azure' | 'ollama' | 'mlx' | 'lmstudio' | 'custom';
export type Role = 'distill' | 'expand' | 'combine' | 'judge' | 'summary' | 'research' | 'x' | 'brief' | 'retrial';
export const ROLES: Role[] = ['distill', 'expand', 'combine', 'judge', 'summary', 'research', 'x', 'brief', 'retrial'];

export type AppSettings = {
  keys: Partial<Record<ProviderId, string>>;
  baseUrls: Partial<Record<ProviderId, string>>;
  models: Record<Role, string>;
  projectsRoot: string;
  /** Safety net across all boards, in USD per local calendar day. */
  maxUsdPerDay: number;
};

// This fork thinks with Claude Code: every role except the X scout (only
// OpenRouter's Grok can search X) runs on the local `claude` CLI.
const SONNET = 'claudecode:sonnet';
export const DEFAULT_APP_SETTINGS: AppSettings = {
  keys: {},
  baseUrls: {
    claudecode: 'claude',
    ollama: 'http://localhost:11434',
    mlx: 'http://localhost:8080/v1',
    lmstudio: 'http://localhost:1234/v1',
    azure: '',
    custom: '',
  },
  // Sonnet: calibrated judge (run `npm run calibrate -- --model claudecode:sonnet` after changes).
  // retrial: the blind second judge for verdicts on a medal edge. A different model from the judge on purpose.
  models: { distill: SONNET, expand: SONNET, combine: SONNET, judge: SONNET, summary: SONNET, research: SONNET, x: 'openrouter:x-ai/grok-4.3', brief: SONNET, retrial: 'claudecode:opus' },
  projectsRoot: '~/Projekt/idea-projects',
  maxUsdPerDay: 5,
};

type ProviderDef = {
  label: string;
  type: 'openai' | 'anthropic' | 'ollama' | 'cli';
  base?: string;
  env?: string;
  needsKey: boolean;
  local?: boolean;
  /** Can run OpenRouter's web-search plugin (needed for the X scout). */
  search?: boolean;
  note?: string;
};

export const PROVIDERS: Record<ProviderId, ProviderDef> = {
  claudecode: {
    label: 'Claude Code (headless, your Claude login)', type: 'cli', needsKey: false, local: true,
    note: 'Runs the local `claude` CLI with no tools and no settings, one process per call (about 2–5 s). Model = an alias (sonnet, opus, haiku) or a full ID. The address field is the command to run. Cost is Claude Code\'s own estimate at list price.',
  },
  openrouter: { label: 'OpenRouter', type: 'openai', base: 'https://openrouter.ai/api/v1', env: 'OPENROUTER_API_KEY', needsKey: true, search: true },
  anthropic: { label: 'Anthropic', type: 'anthropic', env: 'ANTHROPIC_API_KEY', needsKey: true },
  openai: { label: 'OpenAI', type: 'openai', base: 'https://api.openai.com/v1', env: 'OPENAI_API_KEY', needsKey: true },
  azure: {
    label: 'Azure OpenAI / Microsoft Foundry (Copilot models)', type: 'openai', env: 'AZURE_OPENAI_API_KEY', needsKey: true,
    note: 'Neither GitHub Copilot nor Microsoft Copilot has a completion API for apps, and GitHub Models was retired on 30 July 2026 (GitHub points to Microsoft Foundry). The models behind both Copilots are reachable here: base URL https://<resource>.openai.azure.com/openai/v1, model = deployment name.',
  },
  ollama: { label: 'Ollama (local)', type: 'ollama', needsKey: false, local: true },
  mlx: { label: 'MLX · mlx_lm.server (local)', type: 'openai', needsKey: false, local: true },
  lmstudio: { label: 'LM Studio (local)', type: 'openai', needsKey: false, local: true },
  custom: { label: 'Other OpenAI-compatible', type: 'openai', env: 'CUSTOM_API_KEY', needsKey: false },
};

export function parseModel(ref: string): { provider: ProviderId; model: string } {
  const i = ref.indexOf(':');
  const head = i > 0 ? ref.slice(0, i) : '';
  if (head in PROVIDERS) return { provider: head as ProviderId, model: ref.slice(i + 1) };
  return { provider: 'openrouter', model: ref };
}

/** Merge settings pushed from the browser onto the defaults, keeping only well-typed values. */
export function mergeAppSettings(raw: any): AppSettings {
  const s = (v: unknown, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const out: AppSettings = structuredClone(DEFAULT_APP_SETTINGS);
  for (const p of Object.keys(PROVIDERS) as ProviderId[]) {
    if (s(raw?.keys?.[p])) out.keys[p] = s(raw.keys[p]);
    if (typeof raw?.baseUrls?.[p] === 'string') out.baseUrls[p] = s(raw.baseUrls[p]).replace(/\/+$/, '');
  }
  for (const r of ROLES) if (s(raw?.models?.[r], 200)) out.models[r] = s(raw.models[r], 200);
  if (/^(~\/|\/)/.test(s(raw?.projectsRoot))) out.projectsRoot = s(raw.projectsRoot);
  const max = Number(raw?.maxUsdPerDay);
  if (Number.isFinite(max) && max >= 0) out.maxUsdPerDay = Math.min(1000, max);
  return out;
}

/** Browser-entered key first, then the environment. */
export function keyFor(settings: AppSettings, p: ProviderId): string | undefined {
  const k = settings.keys[p] || (PROVIDERS[p].env ? process.env[PROVIDERS[p].env!] : undefined);
  return k || undefined;
}

export function keySource(settings: AppSettings, p: ProviderId): 'browser' | 'env' | null {
  if (settings.keys[p]) return 'browser';
  if (PROVIDERS[p].env && process.env[PROVIDERS[p].env!]) return 'env';
  return null;
}

function baseFor(settings: AppSettings, p: ProviderId) {
  return (settings.baseUrls[p] || PROVIDERS[p].base || '').replace(/\/+$/, '');
}

export class ProviderError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// Anthropic first-party prices (USD per million tokens), for the budget limiter.
const ANTHROPIC_PRICES: Record<string, [number, number]> = {
  'claude-fable-5-1': [10, 50], 'claude-opus-5-5': [4, 20], 'claude-opus-5': [5, 25], 'claude-sonnet-5-5': [2, 10],
  'claude-sonnet-5': [2, 10], 'claude-haiku-5-5': [0.1, 0.5], 'claude-haiku-4-5': [1, 5],
};

export type ChatRequest = {
  model: string;
  system: string;
  user: string;
  schemaName: string;
  schema: object;
  temperature: number;
  maxTokens?: number;
  /** OpenRouter plugins, e.g. [{ id: 'web', engine: 'native' }] for live search. */
  plugins?: object[];
};
/** citations: URLs the search engine itself returned (not what the model wrote). costUsd: 0 when the provider does not report it. */
export type ChatResult = { value: any; costUsd: number; citations?: string[] };
export type ChatFn = (r: ChatRequest) => Promise<ChatResult>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pull a JSON object out of a model answer: drop <think> blocks and code fences, take the outermost braces. */
export function extractJson(text: string) {
  const t = text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error(`No JSON object in answer: ${t.slice(0, 160)}`);
  }
}

const promptJsonRule = (schema: object) =>
  `\n\nRespond with ONLY a JSON object that matches this JSON Schema. No prose, no code fences.\n${JSON.stringify(schema)}`;

async function openaiChat(settings: AppSettings, p: ProviderId, model: string, r: ChatRequest): Promise<ChatResult> {
  const base = baseFor(settings, p);
  if (!base) throw new ProviderError('no_base_url', `${PROVIDERS[p].label}: set a base URL in Settings`);
  const key = keyFor(settings, p);
  if (PROVIDERS[p].needsKey && !key) throw new ProviderError('no_key', `${PROVIDERS[p].label}: no API key (Settings → Providers)`);
  if (r.plugins && !PROVIDERS[p].search) throw new ProviderError('no_search', `${PROVIDERS[p].label} cannot search the web; use an OpenRouter model such as openrouter:x-ai/grok-4.3`);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) {
    if (p === 'azure') headers['api-key'] = key;
    else headers.Authorization = `Bearer ${key}`;
  }
  if (p === 'openrouter') Object.assign(headers, { 'HTTP-Referer': 'http://localhost:8300', 'X-Title': 'Idea Generator 2' });

  let jsonMode: 'schema' | 'prompt' = p === 'mlx' ? 'prompt' : 'schema';
  const body: any = { model, temperature: r.temperature, max_tokens: r.maxTokens ?? 1200 };
  if (p === 'openrouter') {
    body.reasoning = { enabled: false };
    body.usage = { include: true };
    if (r.plugins) body.plugins = r.plugins;
  }
  let lastError = '';
  for (let attempt = 0, adjustments = 0; attempt < 3; ) {
    body.messages = [
      { role: 'system', content: r.system + (jsonMode === 'prompt' ? promptJsonRule(r.schema) : '') },
      { role: 'user', content: r.user },
    ];
    if (jsonMode === 'schema') body.response_format = { type: 'json_schema', json_schema: { name: r.schemaName, strict: true, schema: r.schema } };
    else delete body.response_format;

    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(r.plugins ? 150_000 : 120_000),
    });
    const text = await res.text();
    // Providers disagree on parameters; adapt and retry without spending an attempt.
    if (res.status === 400 && adjustments < 4) {
      adjustments++;
      if (body.reasoning && /reasoning/i.test(text)) {
        delete body.reasoning; // this model insists on reasoning; thinking counts against max_tokens
        body.max_tokens = Math.max(body.max_tokens * 4, 4000);
        continue;
      }
      if ('temperature' in body && /temperature/i.test(text)) { delete body.temperature; continue; }
      if (body.max_tokens && /max_tokens/i.test(text) && /max_completion_tokens/i.test(text)) {
        body.max_completion_tokens = body.max_tokens; delete body.max_tokens; continue;
      }
      if (jsonMode === 'schema' && /response_format|json_schema|structured/i.test(text)) { jsonMode = 'prompt'; continue; }
    }
    attempt++;
    if (!res.ok) {
      lastError = `${PROVIDERS[p].label} ${res.status}: ${text.slice(0, 300)}`;
      if (res.status === 401 || res.status === 403) throw new ProviderError('bad_key', lastError);
      if (res.status === 429 || res.status >= 500) { await sleep(1000 * attempt); continue; }
      throw new ProviderError('provider_error', lastError);
    }
    let data: any;
    try { data = JSON.parse(text); } catch { lastError = `${PROVIDERS[p].label}: not JSON: ${text.slice(0, 120)}`; continue; }
    const message = data.choices?.[0]?.message ?? {};
    const content: string | undefined = message.content;
    const citations: string[] = (message.annotations ?? [])
      .filter((a: any) => a?.type === 'url_citation' && a.url_citation?.url)
      .map((a: any) => a.url_citation.url);
    if (!content) { lastError = `Empty answer from ${model}`; continue; }
    try {
      return { value: extractJson(content), costUsd: Number(data.usage?.cost) || 0, citations };
    } catch (e: any) {
      lastError = e.message;
      if (jsonMode === 'schema') jsonMode = 'prompt';
    }
  }
  throw new ProviderError('provider_error', lastError || `${PROVIDERS[p].label} failed`);
}

async function ollamaChat(settings: AppSettings, model: string, r: ChatRequest): Promise<ChatResult> {
  if (r.plugins) throw new ProviderError('no_search', 'Ollama cannot search the web; use an OpenRouter model for the X scout');
  const base = baseFor(settings, 'ollama');
  // Native API: think:false stops reasoning models (qwen3) spending every token on thinking,
  // and format takes the JSON Schema directly. (Measured: qwen3:8b ~14 s, valid JSON.)
  const body: any = {
    model, stream: false, think: false, format: r.schema,
    options: { temperature: r.temperature, num_predict: r.maxTokens ?? 1200 },
    messages: [{ role: 'system', content: r.system }, { role: 'user', content: r.user }],
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(300_000) });
    } catch (e: any) {
      throw new ProviderError('unreachable', `Ollama at ${base} is not reachable (${e?.cause?.code ?? e.message}). Is it running?`);
    }
    const text = await res.text();
    if (res.status === 400 && 'think' in body && /think/i.test(text)) { delete body.think; continue; }
    if (!res.ok) throw new ProviderError('provider_error', `Ollama ${res.status}: ${text.slice(0, 300)}`);
    try {
      return { value: extractJson(JSON.parse(text).message?.content ?? ''), costUsd: 0 };
    } catch (e: any) {
      if (attempt === 2) throw new ProviderError('provider_error', `Ollama ${model}: ${e.message}`);
    }
  }
  throw new ProviderError('provider_error', `Ollama ${model} failed`);
}

const anthropicClients = new Map<string, Anthropic>();
function anthropicClient(key: string | undefined) {
  const id = key ?? '(default)';
  if (!anthropicClients.has(id)) anthropicClients.set(id, key ? new Anthropic({ apiKey: key }) : new Anthropic());
  return anthropicClients.get(id)!;
}

async function anthropicChat(settings: AppSettings, model: string, r: ChatRequest): Promise<ChatResult> {
  if (r.plugins) throw new ProviderError('no_search', 'The X scout needs OpenRouter (Grok with X search)');
  const client = anthropicClient(keyFor(settings, 'anthropic'));
  // Structured output via output_config.format. No temperature: current models reject
  // non-default sampling. Low effort: these are short, single-shot answers.
  const output_config: any = { format: { type: 'json_schema', schema: r.schema }, effort: 'low' };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const msg = await client.messages.create({
        model,
        max_tokens: Math.max(r.maxTokens ?? 1200, 4000),
        system: r.system,
        messages: [{ role: 'user', content: r.user }],
        output_config,
      } as any);
      if (msg.stop_reason === 'refusal') throw new ProviderError('refused', `${model} declined to answer`);
      const text = msg.content.map((b: any) => (b.type === 'text' ? b.text : '')).join('');
      const [pin, pout] = ANTHROPIC_PRICES[model] ?? [0, 0];
      const costUsd = (msg.usage.input_tokens * pin + msg.usage.output_tokens * pout) / 1e6;
      return { value: extractJson(text), costUsd };
    } catch (e) {
      // Older models (e.g. Haiku 4.5) do not take effort: drop it once and retry.
      if (e instanceof Anthropic.BadRequestError && 'effort' in output_config && /effort/i.test(e.message)) {
        delete output_config.effort;
        continue;
      }
      if (e instanceof Anthropic.AuthenticationError) throw new ProviderError('bad_key', `Anthropic: ${e.message}`);
      if (e instanceof Anthropic.APIError) throw new ProviderError('provider_error', `Anthropic ${e.status}: ${e.message}`);
      throw e;
    }
  }
  throw new ProviderError('provider_error', `Anthropic ${model} failed`);
}

// ---------------------------------------------------------------- Claude Code (headless CLI)

/** What we pass to `claude -p`: no tools, no settings or MCP, a fixed system prompt, structured output. */
export function claudeCodeArgs(model: string, r: ChatRequest) {
  return [
    '-p', '--output-format', 'json', '--model', model,
    '--tools', '', '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands',
    '--system-prompt', r.system,
    '--json-schema', JSON.stringify(r.schema),
  ];
}

/** Run a command, feed stdin, collect stdout and stderr. Rejects only if it cannot start. */
export function run(cmd: string, args: string[], o: { input?: string; cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = o.timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, o.timeoutMs) : null;
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
    child.stdin.on('error', () => {}); // a child that exits early must not crash us
    child.stdin.end(o.input ?? '');
  });
}

async function claudeCodeChat(settings: AppSettings, model: string, r: ChatRequest): Promise<ChatResult> {
  if (r.plugins) throw new ProviderError('no_search', 'Claude Code cannot search X; use openrouter:x-ai/grok-4.3 for the X scout');
  const cmd = baseFor(settings, 'claudecode') || 'claude';
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    let out;
    try {
      // A neutral folder, so no project CLAUDE.md leaks into the prompt.
      out = await run(cmd, claudeCodeArgs(model, r), { input: r.user, cwd: tmpdir(), timeoutMs: r.plugins ? 300_000 : 180_000 });
    } catch (e: any) {
      throw new ProviderError('unreachable', `Claude Code: cannot run "${cmd}" (${e?.code ?? e?.message}). Is Claude Code installed and logged in?`);
    }
    if (out.timedOut) { lastError = `Claude Code ${model}: timed out`; continue; }
    let data: any;
    try {
      data = JSON.parse(out.stdout);
    } catch {
      lastError = `Claude Code exit ${out.code}: ${(out.stderr || out.stdout).trim().slice(0, 300)}`;
      if (/log ?in|auth|credential/i.test(lastError)) throw new ProviderError('bad_key', `${lastError} (run \`claude\` once and log in)`);
      continue;
    }
    const costUsd = Number(data.total_cost_usd) || 0;
    if (data.is_error) {
      lastError = `Claude Code ${model}: ${String(data.result ?? data.subtype ?? 'error').slice(0, 300)}`;
      if (/rate limit|usage limit|overloaded/i.test(lastError)) throw new ProviderError('rate_limited', lastError);
      continue;
    }
    try {
      const value = data.structured_output ?? extractJson(String(data.result ?? ''));
      return { value, costUsd };
    } catch (e: any) {
      lastError = `Claude Code ${model}: ${e.message}`;
    }
  }
  throw new ProviderError('provider_error', lastError || `Claude Code ${model} failed`);
}

export const CLAUDE_CODE_MODELS = ['sonnet', 'opus', 'haiku', 'fable', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];

/** A chat function that routes every request by its "provider:model" string. */
export function makeChat(getSettings: () => AppSettings): ChatFn {
  return async (r) => {
    const settings = getSettings();
    const { provider, model } = parseModel(r.model);
    if (!model) throw new ProviderError('bad_model', `No model given in "${r.model}"`);
    const def = PROVIDERS[provider];
    if (def.type === 'cli') return claudeCodeChat(settings, model, r);
    if (def.type === 'anthropic') return anthropicChat(settings, model, r);
    if (def.type === 'ollama') return ollamaChat(settings, model, r);
    return openaiChat(settings, provider, model, r);
  };
}

/** List a provider's models, also used as a connection test. */
export async function listModels(settings: AppSettings, p: ProviderId): Promise<string[]> {
  const base = baseFor(settings, p);
  const key = keyFor(settings, p);
  const get = async (url: string, headers: Record<string, string> = {}) => {
    const res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    if (!res.ok) throw new ProviderError(res.status === 401 || res.status === 403 ? 'bad_key' : 'provider_error', `${res.status}: ${text.slice(0, 200)}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new ProviderError('provider_error', `Not JSON: ${text.slice(0, 120)}`);
    }
  };
  try {
    if (p === 'claudecode') {
      // A connection test that costs nothing: is the CLI there, and which version?
      const cmd = base || 'claude';
      const out = await run(cmd, ['--version'], { timeoutMs: 15_000 });
      if (out.code !== 0) throw new ProviderError('unreachable', `Claude Code: "${cmd} --version" failed: ${out.stderr.trim().slice(0, 200)}`);
      return CLAUDE_CODE_MODELS;
    }
    if (p === 'anthropic') {
      const out: string[] = [];
      for await (const m of anthropicClient(key).models.list()) out.push(m.id);
      return out;
    }
    if (p === 'ollama') return ((await get(`${base}/api/tags`)).models ?? []).map((m: any) => m.name);
    if (!base) throw new ProviderError('no_base_url', 'Set a base URL first');
    if (PROVIDERS[p].needsKey && !key) throw new ProviderError('no_key', 'No API key');
    const headers: Record<string, string> = key ? (p === 'azure' ? { 'api-key': key } : { Authorization: `Bearer ${key}` }) : {};
    return ((await get(`${base}/models`, headers)).data ?? []).map((m: any) => m.id).sort();
  } catch (e: any) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError('unreachable', `${PROVIDERS[p].label}: ${e?.cause?.code ?? e.message}`);
  }
}
