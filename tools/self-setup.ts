// Create the self-improvement board on a running server:
//   npm run dev            (in one terminal: restarts itself when a build is merged)
//   npm run self:setup     (once; prints the board's id)
// Options: --url http://localhost:8301  --manual (do not start the autopilot)  --no-seeds
//   --new                start another self-improvement board even if one exists
//   --title "…"          board title (default "Self-improvement")
//   --seed "…"           a seed idea, repeatable; replaces the default seeds
//   --usd N              the board's dollar limit per day (default 5)
//   --retire             switch the autopilot off on the other self-improvement boards
//   --focus users|ops|wild  aim the goal, jury and research at what users notice, at cost,
//                        speed and robustness, or at wild ideas (which never build there),
//                        instead of the evolution and the jury (default: evolution)
//   --spores             turn spores on: the autopilot trades its best ideas with other spore boards
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

const DEFAULT_SEEDS = [
  'The autopilot learns which kinds of crosses produce gold on a board and breeds more of those.',
  'The jury says what would lift each idea one medal; the next generation tries exactly that.',
  'Show viewers why one idea beat another: the jury’s reasons side by side.',
];
const FOCUS = {
  evolution: {
    goal: 'Make Idea Generator 2 a better idea generator: more original and useful ideas, a sharper and more honest jury, smarter evolution, and clearer insight for the people watching. Every idea is a concrete change to this app that Claude Code can build, test and document in one unattended session.',
    impact: 'IMPACT here means impact on the app as an idea generator: better ideas, sharper or more honest judging, smarter evolution, or clearer insight for the people using or watching it. Cosmetic tweaks score at most 2.',
    research: 'LLM idea generation, creativity evaluation, LLM-as-a-judge, evolutionary search with language models',
    seeds: DEFAULT_SEEDS,
    wordingGap: true, // build 0011: every verdict also gets a blind rescore of a plain rewrite
  },
  users: {
    goal: 'Make Idea Generator 2 better to use: what a person notices when they start a board, read and steer it, share what came out, or point it at their own code. Useful ideas sooner, screens that explain themselves, less waiting and fewer surprises. Every idea is a concrete change to this app that Claude Code can build, test and document in one unattended session.',
    impact: 'IMPACT here means impact on the people using the app: reaching useful ideas sooner, understanding a board at a glance, steering it with less effort, sharing or exporting results, or making codebase boards and spores worth using. A new measurement of the jury or the evolution that a user would not act on scores at most 2. Cosmetic tweaks score at most 2.',
    research: 'creativity support tools, brainstorming software usability, human-AI co-creation interfaces',
    seeds: [
      'When the autopilot pauses (hourly cap, daily budget, missing key), the top of the board says why in plain words and when it resumes.',
      'Type a word and only the matching ideas stay lit on the canvas; filter by medal or by age with one click.',
      'A new board asks three short questions about what you want and writes its goal and first seeds from the answers.',
      'Gold ideas on a codebase board get a button that hands them to Claude Code in that folder and shows the result next to the idea.',
    ],
    wordingGap: false,
  },
  ops: {
    goal: 'Make Idea Generator 2 faster, cheaper and sturdier to run: fewer and cheaper model calls per medal, less waiting, graceful recovery when a provider fails or the server restarts, and clear numbers on what each board and role costs. Every idea is a concrete change to this app that Claude Code can build, test and document in one unattended session.',
    impact: 'IMPACT here means impact on running the app: dollars or seconds saved per medal, fewer failed or lost steps, faster recovery after errors and restarts, or costs the user can see and act on. A change that saves nothing measurable, or only measures the jury or the evolution, scores at most 2. Cosmetic tweaks score at most 2.',
    research: 'LLM inference cost reduction, prompt caching, robust LLM pipelines, fault-tolerant job queues',
    seeds: [
      'The overview shows dollars and seconds per medal for each role, so you can see which step of the loop costs the most.',
      'When a provider call fails, the queue retries it once on a fallback model and the idea says which model judged it.',
      'After a server restart, queued judgements and half-finished autopilot steps resume instead of being lost.',
      'Skip the judge call for an exact repeat of an idea already on the board, and count the dollars saved.',
    ],
    wordingGap: false,
  },
  wild: {
    goal: 'Find wild, out-of-the-box changes to Idea Generator 2: ideas that would change what an idea generator is, not just tune this one. Surprising mechanisms, odd analogies, new kinds of boards, players or inputs. Every idea still names a concrete change to this app that Claude Code could build, so that a tamer board can take it in as a spore. This board never builds its own gold.',
    impact: 'IMPACT here means how far the idea would change what the app is or can do. A safe, incremental improvement scores at most 2, however useful. ORIGINALITY 5 is for something no idea tool does; a twist on a known feature scores at most 3.',
    research: 'computational creativity, open-endedness, novelty search, unusual human-AI co-creation',
    seeds: [
      'Two boards argue: each sends its best idea to the other, whose jury must attack it, and the survivors are crossed.',
      'The board dreams at night: while nobody watches, it recombines its rejected ideas only, and shows the morning the best of the scrap heap.',
      'Ideas age and die: every idea has a lifespan, and only one that has bred a medal-winning child lives on.',
      'A visitor hums, draws or photographs something, and the board turns it into its next seed.',
    ],
    wordingGap: false,
    builds: 0, // wild gold never builds here; it has to take root on a tamer board first
  },
} as const;
const focusName = (arg('--focus') ?? 'evolution') as keyof typeof FOCUS;
const F = FOCUS[focusName];
if (!F) throw new Error(`--focus must be one of: ${Object.keys(FOCUS).join(', ')}`);
const GOAL = F.goal;

const JURY = `Each idea is a proposed change to this app (Idea Generator 2). If it gets gold, a coding agent (Claude Code) builds it into the app's own code, unattended, in one session, and it is merged if the tests pass.
FEASIBILITY here means: can a coding agent build and test it in this codebase in about an hour, with no new npm dependencies, no new paid services or accounts, and without weakening security (loopback only, text nodes in the DOM, never trusting model-written URLs)? 5 = a contained change to a few files with an obvious way to test and show it. 3 = touches several modules but is clear. 1–2 = vague, needs new infrastructure, accounts, hardware, or a human to finish it.
${F.impact}
ORIGINALITY is judged against what the app already does (listed below). A feature the app already has scores 1.
An idea that does not say what the user would see, or how to verify it, scores at most 3 on feasibility.`;

const SEEDS = all('--seed').length ? all('--seed') : null; // null: the focus's seeds
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
    wordingGap: F.wordingGap,
    spores: has('--spores'),
    buildsPerDay: 'builds' in F ? F.builds : 4,
    buildModel: 'opus',
    judgeGuidance: JURY,
    researchers: {
      x: { enabled: false, focus: '' },
      research: { enabled: true, focus: F.research },
    },
    mode: has('--manual') ? 'manual' : 'auto',
    autopilotSeconds: 45,
    rate: { stepsPerHour: 40, usdPerDay: Number.isFinite(USD) ? USD : 5 },
    models: { distill: CC, expand: CC, combine: CC, judge: CC, summary: CC, research: CC, brief: CC },
  },
});
if (!has('--no-seeds')) {
  const seeds = SEEDS ?? F.seeds;
  await Promise.all(seeds.map((text, i) => {
    const a = (i / seeds.length) * Math.PI * 2;
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
