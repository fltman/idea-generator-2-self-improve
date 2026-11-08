// Create the self-improvement board on a running server:
//   npm run dev            (in one terminal: restarts itself when a build is merged)
//   npm run self:setup     (once; prints the board's id)
// Options: --url http://localhost:8301  --manual (do not start the autopilot)  --no-seeds
//   --new                start another self-improvement board even if one exists
//   --title "…"          board title (default "Self-improvement")
//   --seed "…"           a seed idea, repeatable; replaces the default seeds
//   --usd N              the board's dollar limit per day (default 5)
//   --retire             switch the autopilot off on the other self-improvement boards
// A fresh board is how you restart the loop after many builds: the old board's
// pool was bred before those builds existed and keeps proposing them again.
//
// The board's ideas are changes to this app. Every role runs on Claude Code
// (claudecode:sonnet), the jury is told what "buildable" means here, and gold
// ideas go to the builder (server/builder.ts), which builds them with Claude
// Code (opus) and merges them into main when the tests and a boot check pass.

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const base = (arg('--url') ?? `http://localhost:${process.env.PORT ?? 8301}`).replace(/\/+$/, '');
const has = (flag: string) => process.argv.includes(flag);
const all = (name: string) => process.argv.flatMap((a, i) => (a === name && process.argv[i + 1] ? [process.argv[i + 1]] : []));

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data: any = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${data?.error ?? res.status}`);
  return data;
}

const GOAL =
  'Make Idea Generator 2 a better idea generator: more original and useful ideas, a sharper and more honest jury, smarter evolution, and clearer insight for the people watching. Every idea is a concrete change to this app that Claude Code can build, test and document in one unattended session.';

const JURY = `Each idea is a proposed change to this app (Idea Generator 2). If it gets gold, a coding agent (Claude Code) builds it into the app's own code, unattended, in one session, and it is merged if the tests pass.
FEASIBILITY here means: can a coding agent build and test it in this codebase in about an hour, with no new npm dependencies, no new paid services or accounts, and without weakening security (loopback only, text nodes in the DOM, never trusting model-written URLs)? 5 = a contained change to a few files with an obvious way to test and show it. 3 = touches several modules but is clear. 1–2 = vague, needs new infrastructure, accounts, hardware, or a human to finish it.
IMPACT here means impact on the app as an idea generator: better ideas, sharper or more honest judging, smarter evolution, or clearer insight for the people using or watching it. Cosmetic tweaks score at most 2.
ORIGINALITY is judged against what the app already does (listed below). A feature the app already has scores 1.
An idea that does not say what the user would see, or how to verify it, scores at most 3 on feasibility.`;

const DEFAULT_SEEDS = [
  'The autopilot learns which kinds of crosses produce gold on a board and breeds more of those.',
  'The jury says what would lift each idea one medal; the next generation tries exactly that.',
  'Show viewers why one idea beat another: the jury’s reasons side by side.',
];
const SEEDS = all('--seed').length ? all('--seed') : DEFAULT_SEEDS;
const USD = Number(arg('--usd') ?? 5);

const CC = 'claudecode:sonnet';
const { templates } = await api('GET', '/api/templates');
const tpl = templates.find((t: any) => t.name.startsWith('Självförbättraren'));
const { boards } = await api('GET', '/api/boards');
const others = boards.filter((b: any) => b.config?.selfImprove);
const existing = others[0];
if (existing && !has('--new')) {
  console.log(`A self-improvement board already exists: #${existing.id} "${existing.title}". Open ${base} and pick it.`);
  process.exit(0);
}

const { board } = await api('POST', '/api/boards', { title: arg('--title') ?? 'Self-improvement', goal: GOAL, templateId: tpl?.id ?? null, lang: 'en' });
await api('PATCH', `/api/boards/${board.id}`, {
  config: {
    lang: 'en',
    selfImprove: true,
    autoProjectOnGold: false,
    wordingGap: true, // build 0011: every verdict also gets a blind rescore of a plain rewrite
    buildsPerDay: 4,
    buildModel: 'opus',
    judgeGuidance: JURY,
    researchers: {
      x: { enabled: false, focus: '' },
      research: { enabled: true, focus: 'LLM idea generation, creativity evaluation, LLM-as-a-judge, evolutionary search with language models' },
    },
    mode: has('--manual') ? 'manual' : 'auto',
    autopilotSeconds: 45,
    rate: { stepsPerHour: 40, usdPerDay: Number.isFinite(USD) ? USD : 5 },
    models: { distill: CC, expand: CC, combine: CC, judge: CC, summary: CC, research: CC, brief: CC },
  },
});
if (!has('--no-seeds')) {
  await Promise.all(SEEDS.map((text, i) => {
    const a = (i / SEEDS.length) * Math.PI * 2;
    return api('POST', `/api/boards/${board.id}/seed`, { text, x: Math.cos(a) * 260, y: Math.sin(a) * 260 });
  }));
}
if (has('--retire')) {
  for (const b of others) {
    await api('PATCH', `/api/boards/${b.id}`, { config: { ...b.config, mode: 'manual' } });
    console.log(`Autopilot off on #${b.id} "${b.title}" (its ideas and builds stay).`);
  }
}
console.log(`Self-improvement board #${board.id} created${has('--manual') ? '' : ', autopilot on'}. Open ${base}`);
