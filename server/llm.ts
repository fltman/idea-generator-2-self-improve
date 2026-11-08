// Every prompt in the app. Which model answers is decided per call (per role,
// optionally per board); providers.ts routes "provider:model" to the right API.
//
// Schemas avoid integer minimum/maximum (Anthropic rejects them), so ranges
// live in descriptions and are clamped in code.

import { clampScore, CRITERIA } from '../public/js/score.js';
import type { ChatFn } from './providers.ts';
export type { ChatFn, ChatRequest } from './providers.ts';

export type Lang = 'sv' | 'en';
type Pitch = { title: string; pitch: string };
/** A parent's lift recipe, handed to its offspring as their task. */
export type LiftTask = { type: string | null; change: string | null; from: Pitch; arm?: string };
type Flow = { system: string; expand: string; combine: string };
/** fixedLang: write in this language whatever the sources are in (self-improvement boards: the code and journal follow the board). */
type BoardCtx = { goal: string; fixedLang?: Lang };
export type Judgement = {
  originality: number; feasibility: number; impact: number; reason: string; keywords: string[];
  /** The lift recipe: which criterion, and the one change that would earn the next medal. null when the model gave none. */
  liftType: string | null; lift: string | null;
};

/** Placebo trials: what a child in the placebo arm is told instead of its parent's recipe. Deliberately vague. */
export const PLACEBO_TASK = 'Your task: improve it.';

/** The task line for a child bred under a lift recipe. */
function liftTaskText(t: LiftTask | null | undefined, many = false) {
  // Scrap heap (build 0012): a wilted idea's own jury reason is the task.
  if (t?.arm === 'scrap' && t.change) {
    return [
      `The jury's verdict on "${t.from.title}" (an idea that has bred many children and none rose above it):`,
      t.change,
      `Your task: ${many ? 'every new idea' : 'the new idea'} must overcome what this verdict says held it back, while staying a whole, concrete idea.`,
    ].join('\n');
  }
  // The no-task arm and the control sibling get nothing; the placebo arm gets a vague task with no criterion and no recipe.
  if (!t || t.arm === 'none' || t.arm === 'control' || !t.change) return t?.arm === 'placebo' ? PLACEBO_TASK : '';
  return [
    `The jury's lift recipe for "${t.from.title}" (the one change that would earn it the next medal, by raising its ${t.type}):`,
    t.change,
    `Your task: ${many ? 'every new idea' : 'the new idea'} must carry out exactly this change, while staying a whole, concrete idea.`,
  ].join('\n');
}

/** Idea styles (build 0010): the framing a bred idea must be written in, drawn by lot per breed. */
export const STYLE_TEXT: Record<string, string> = {
  scenario: 'a scenario: open with one concrete moment where a specific person uses it, and what changes for them',
  mechanism: 'a mechanism: say how it works, the parts and the one step that makes it run',
  analogy: 'an analogy: borrow something that already works in another field and say what it maps to here',
  metric: 'a metric: name the number it moves, how that number is measured, and a target',
};

/** The style line for a breed. Format only: no criterion and no recipe, so it can sit beside any trial arm. */
export function styleText(style: string | null | undefined, many = false) {
  const s = style ? STYLE_TEXT[style] : null;
  return s ? `Style: write ${many ? 'every new idea' : 'the new idea'} as ${s}.` : '';
}

/** One canonical form so "Public Spaces" and "public space" count as one trend. */
export function normalizeKeywords(raw: unknown): string[] {
  const out: string[] = [];
  for (const k of Array.isArray(raw) ? raw : []) {
    const w = String(k).toLowerCase().replace(/[^\p{L}\p{N} &+-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (w && !out.includes(w)) out.push(w);
  }
  return out.slice(0, 4);
}

// ---------------------------------------------------------------- schemas

const PITCH_PROPS = {
  title: { type: 'string', description: 'A concrete name for the idea, 2–6 words. No quotes, no trailing period.' },
  pitch: {
    type: 'string',
    description: 'One or two sentences, at most 40 words: what it is, for whom, and the mechanism that makes it work.',
  },
};
const PITCH_SCHEMA = { type: 'object', properties: PITCH_PROPS, required: ['title', 'pitch'], additionalProperties: false };
const EXPAND_SCHEMA = {
  type: 'object',
  properties: {
    ideas: { type: 'array', description: 'Exactly 3 ideas.', items: PITCH_SCHEMA },
  },
  required: ['ideas'],
  additionalProperties: false,
};
// The reason comes first so the model argues before it scores.
const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    reason: {
      type: 'string',
      description: 'One sentence, at most 25 words, in the language of the idea: the main strength and the main weakness.',
    },
    originality: { type: 'integer', description: 'Integer 1–5.' },
    feasibility: { type: 'integer', description: 'Integer 1–5.' },
    impact: { type: 'integer', description: 'Integer 1–5.' },
    keywords: {
      type: 'array',
      description: '2–4 keywords for what the idea is about: English, lowercase, singular, 1–2 words each. Reuse a keyword from the vocabulary when one fits.',
      items: { type: 'string' },
    },
    // The lift recipe comes after the scores, so writing it cannot pull them.
    liftType: {
      type: 'string',
      enum: [...CRITERIA],
      description: 'The one criterion whose score the lift recipe raises.',
    },
    lift: {
      type: 'string',
      description:
        'The lift recipe: ONE concrete change to the idea, at most 25 words, in the language of the reason, that would raise the total enough to earn the next medal (bronze 9, silver 11, gold 13). Say what to change, not what is wrong.',
    },
  },
  required: ['reason', 'originality', 'feasibility', 'impact', 'keywords', 'liftType', 'lift'],
  additionalProperties: false,
};

// The recipe check: did a child carry out its parent's recipe? Reason first, so it argues before it rules.
const LIFT_CHECK_SCHEMA = {
  type: 'object',
  properties: {
    reason: {
      type: 'string',
      description: 'One sentence, at most 25 words: where in the new idea the change shows, or that it does not.',
    },
    applied: {
      type: 'boolean',
      description: 'true only if the new idea clearly carries out the recipe\'s change (not just mentions it); false if it ignores or merely gestures at it.',
    },
  },
  required: ['reason', 'applied'],
  additionalProperties: false,
};

// The blind duel (build 0009): two ideas, labelled only A and B, one winner per criterion.
const DUEL_PICK = (what: string) => ({ type: 'string', enum: ['A', 'B', 'tie'], description: `Which idea is clearly stronger on ${what}: "A", "B", or "tie" if neither clearly is.` });
const DUEL_SCHEMA = {
  type: 'object',
  properties: {
    reason: { type: 'string', description: 'One sentence, at most 30 words: the decisive difference between A and B.' },
    originality: DUEL_PICK('originality (how new and surprising the idea is)'),
    feasibility: DUEL_PICK('feasibility (how realistic it is to carry out with reasonable means)'),
    impact: DUEL_PICK('impact (how much difference it makes if it works)'),
  },
  required: ['reason', 'originality', 'feasibility', 'impact'],
  additionalProperties: false,
};

// ---------------------------------------------------------------- prompts

/** Codebase boards: what the code is, and the directions ideas for it could take. */
const REPO_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'What this codebase is and does, for whom, in 2–4 plain sentences. Only what the files show.' },
    stack: { type: 'string', description: 'Languages, frameworks and how it runs and is tested, in one sentence.' },
    focuses: {
      type: 'array',
      description: '4–6 directions that ideas for improving this codebase could take, the most promising first. Mix kinds: new features, UX, performance, reliability and tests, security, developer experience, and what this particular codebase most lacks.',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'The direction in 1–4 words, e.g. "New features", "Faster startup".' },
          why: { type: 'string', description: 'One sentence: why this direction fits this codebase, citing something you saw in it.' },
          seed: { type: 'string', description: 'One concrete starter idea in this direction, at most 110 characters.' },
        },
        required: ['label', 'why', 'seed'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'stack', 'focuses'],
  additionalProperties: false,
};
export type RepoFocus = { label: string; why: string; seed: string };

const LANG_NAME: Record<Lang, string> = { sv: 'Swedish', en: 'English' };

function languageRule(lang: Lang, fixed?: Lang) {
  if (fixed) return `Write in ${LANG_NAME[fixed]}, even when the source ideas are in another language.`;
  return [
    `Write in the same language as the source idea(s). If that is unclear or mixed, write in ${LANG_NAME[lang]}.`,
    'If you write Swedish, write idiomatic Swedish: correct agreement, no invented compound words, no anglicisms where a Swedish word exists.',
  ].join(' ');
}

function context(board: BoardCtx, existingTitles: string[]) {
  const parts: string[] = [];
  if (board.goal.trim())
    parts.push(
      `The board's goal (the general direction): ${board.goal.trim()}\nEvery idea must serve this goal. Keep the source idea's substance, but steer it toward the goal.`,
    );
  if (existingTitles.length)
    parts.push(
      `Ideas already on the board (do not repeat or lightly reword them):\n${existingTitles
        .slice(-40)
        .map((t) => `- ${t}`)
        .join('\n')}`,
    );
  return parts.join('\n\n');
}

const fmtIdea = (i: Pitch) => (i.pitch ? `${i.title}: ${i.pitch}` : i.title);

export const JUDGE_SYSTEM = `You are a strict, experienced innovation jury. You score ideas on three criteria, each an integer 1–5.

ORIGINALITY
1 = a bare topic, a category or an obvious idea everyone has heard ("electric cars", "an app for X", "use AI for Y").
3 = a known concept applied in a genuinely new context.
5 = a non-obvious mechanism that few people would think of.

FEASIBILITY
1 = needs scientific breakthroughs or is impossible.
3 = hard, but doable with existing technology within a few years.
5 = could be piloted within months with means that exist today.

IMPACT
1 = trivial, or no clear benefit to anyone.
3 = meaningful for a specific group.
5 = large, lasting change for many people.

Rules:
- A bare topic or a single word is not an idea yet: originality 1, impact at most 2.
- Vague ideas that do not say what actually happens score at most 2 on feasibility and impact.
- Most ideas land around 2–3 per criterion. Reserve 5 for the exceptional; fewer than one idea in ten should reach a total of 13.
- Judge the idea as written, not the best idea it could become.
- If the board has a goal, judge against it: impact means impact on that goal, and an idea that does not serve the goal scores at most 2 on impact however good it is otherwise. Say in the reason how well it fits the goal.`;

// Wording gap (build 0011): the plain rewrite keeps every concrete claim and strips the packaging.
export const PLAIN_SYSTEM = `You rewrite ideas in plain, neutral wording, the way an editor strips a manuscript for blinded review.
Keep every concrete claim exactly: what it is, who it is for, the mechanism, every number, file, step and limit.
Remove everything else: catchy names, metaphors, analogies, scenes and characters, rhetorical framing, hype words and adjectives that carry no fact.
Do not add, improve, fix or drop any substance. The title is a dry, literal name of 2–6 words.`;

const list = (description: string) => ({ type: 'array', description, items: { type: 'string' } });
const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: 'One sentence: where the board stands right now.' },
    themes: {
      type: 'array',
      description: '2–5 themes the ideas cluster into.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Theme name, 1–4 words.' },
          insight: { type: 'string', description: 'What the ideas in this theme have in common and what they reveal, 1–2 sentences.' },
          ideas: list('Titles of the ideas in this theme, exactly as given.'),
        },
        required: ['name', 'insight', 'ideas'],
        additionalProperties: false,
      },
    },
    strongest: {
      type: 'array',
      description: 'The 1–3 strongest ideas.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Title exactly as given.' },
          why: { type: 'string', description: 'Why it stands out, one sentence.' },
        },
        required: ['title', 'why'],
        additionalProperties: false,
      },
    },
    gaps: list('2–4 directions toward the goal that no idea explores yet.'),
    nextSteps: list('2–4 concrete next moves on this board, e.g. which ideas to cross or expand.'),
  },
  required: ['headline', 'themes', 'strongest', 'gaps', 'nextSteps'],
  additionalProperties: false,
};

/** Every function takes `model`: a "provider:model" string chosen per role. */
const SYNTHESIS_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: 'One or two sentences: what the idea work as a whole has produced so far.' },
    insights: list('3–6 insights that hold across boards: patterns, recurring weaknesses, what the jury rewards.'),
    standouts: {
      type: 'array',
      description: 'The 1–5 ideas most worth pursuing, across all boards.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Title exactly as given.' },
          board: { type: 'string', description: 'Board title exactly as given.' },
          why: { type: 'string', description: 'Why it stands out, one sentence.' },
        },
        required: ['title', 'board', 'why'],
        additionalProperties: false,
      },
    },
    opportunities: list('2–4 opportunities: boards whose ideas should cross-breed, or directions nobody has explored.'),
    nextSteps: list('2–4 concrete next steps, including which Claude Code projects to start on first.'),
  },
  required: ['headline', 'insights', 'standouts', 'opportunities', 'nextSteps'],
  additionalProperties: false,
};

export function makeLLM(chat: ChatFn) {
  const gen = async (model: string, system: string, user: string, schemaName: string, schema: object) => {
    return chat({ model, system, user, schemaName, schema, temperature: 0.9 });
  };

  const tidy = (p: any): Pitch => ({
    title: String(p?.title ?? '').trim().replace(/^["'«»“”]+|["'«»“”.]+$/g, '').slice(0, 120),
    pitch: String(p?.pitch ?? '').trim().slice(0, 600),
  });

  return {
    async expand(a: { model: string; flow: Flow; board: BoardCtx; idea: Pitch; existingTitles: string[]; lang: Lang; task?: LiftTask | null; style?: string | null }) {
      const user = [
        a.flow.expand,
        `The concept:\n${fmtIdea(a.idea)}`,
        liftTaskText(a.task, true),
        styleText(a.style, true),
        context(a.board, a.existingTitles),
        languageRule(a.lang, a.board.fixedLang),
      ]
        .filter(Boolean)
        .join('\n\n');
      const { value, costUsd } = await gen(a.model, a.flow.system, user, 'expand', EXPAND_SCHEMA);
      const ideas = (Array.isArray(value?.ideas) ? value.ideas : []).map(tidy).filter((i: Pitch) => i.title);
      if (!ideas.length) throw new Error('The model returned no ideas');
      return { ideas: ideas.slice(0, 3), costUsd };
    },

    async combine(a: { model: string; flow: Flow; board: BoardCtx; a: Pitch; b: Pitch; existingTitles: string[]; lang: Lang; task?: LiftTask | null; style?: string | null }) {
      const user = [
        a.flow.combine,
        `Idea 1:\n${fmtIdea(a.a)}`,
        `Idea 2:\n${fmtIdea(a.b)}`,
        liftTaskText(a.task),
        styleText(a.style),
        context(a.board, a.existingTitles),
        languageRule(a.lang, a.board.fixedLang),
      ]
        .filter(Boolean)
        .join('\n\n');
      const { value, costUsd } = await gen(a.model, a.flow.system, user, 'combine', PITCH_SCHEMA);
      const idea = tidy(value);
      if (!idea.title) throw new Error('The model returned no idea');
      return { idea, costUsd };
    },

    /** Turn a long text or a fetched web page into one seed idea. */
    async distill(a: { model: string; flow: Flow; board: BoardCtx; text: string; url?: string; lang: Lang }) {
      const user = [
        'Distill the source below into ONE seed idea for a brainstorm: the most promising concept, problem or opportunity in it. Do not summarise the whole text.',
        a.url ? `Source: ${a.url}` : '',
        `---\n${a.text}\n---`,
        context(a.board, []),
        languageRule(a.lang, a.board.fixedLang),
      ]
        .filter(Boolean)
        .join('\n\n');
      const { value, costUsd } = await gen(a.model, a.flow.system, user, 'seed', PITCH_SCHEMA);
      const idea = tidy(value);
      if (!idea.title) throw new Error('The model returned no idea');
      return { idea, costUsd };
    },

    /** A synthesis of everything on a board. ideas: sorted strongest first. */
    async summarize(a: {
      model: string; board: BoardCtx; lang: Lang;
      ideas: { title: string; pitch: string; kind: string; sum: number | null; reason: string | null }[];
    }) {
      const lines = a.ideas
        .slice(0, 120)
        .map((i) => `- ${fmtIdea(i)}${i.sum != null ? ` [jury ${i.sum}/15${i.reason ? `: ${i.reason}` : ''}]` : ' [not judged]'}${i.kind === 'guest' ? ' (guest from another board)' : ''}`)
        .join('\n');
      const user = [
        a.board.goal.trim() ? `The board's goal: ${a.board.goal.trim()}` : 'The board has no stated goal.',
        `The ${a.ideas.length} ideas on the board, strongest first:\n${lines}`,
        'Summarise the board for the people working on it: the themes, the strongest ideas, the gaps toward the goal, and what to do next. Be specific and honest; do not praise.',
        `Write in ${LANG_NAME[a.lang]}${a.lang === 'sv' ? ' (idiomatic Swedish)' : ''}. Keep idea titles exactly as given.`,
      ].join('\n\n');
      const { value, costUsd } = await chat({
        model: a.model,
        system: 'You are a facilitator who has watched a whole brainstorm and now sums it up crisply for the team.',
        user,
        schemaName: 'summary',
        schema: SUMMARY_SCHEMA,
        temperature: 0.4,
        maxTokens: 2500,
      });
      const strs = (x: unknown, n: number) => (Array.isArray(x) ? x.map((s) => String(s).trim()).filter(Boolean).slice(0, n) : []);
      const summary = {
        headline: String(value?.headline ?? '').trim(),
        themes: (Array.isArray(value?.themes) ? value.themes : []).slice(0, 6).map((t: any) => ({
          name: String(t?.name ?? '').trim(), insight: String(t?.insight ?? '').trim(), ideas: strs(t?.ideas, 30),
        })),
        strongest: (Array.isArray(value?.strongest) ? value.strongest : []).slice(0, 3).map((s: any) => ({
          title: String(s?.title ?? '').trim(), why: String(s?.why ?? '').trim(),
        })),
        gaps: strs(value?.gaps, 5),
        nextSteps: strs(value?.nextSteps, 5),
      };
      return { summary, costUsd };
    },

    /** The report's conclusions: one synthesis across every board. */
    async synthesize(a: {
      model: string; lang: Lang; days: number;
      boards: { title: string; goal: string; summary: string; best: { title: string; pitch: string; sum: number | null }[]; projects: string[] }[];
    }) {
      const blocks = a.boards
        .map((b) =>
          [
            `## ${b.title}`,
            b.goal ? `Goal: ${b.goal}` : 'No goal.',
            b.summary ? `Board summary: ${b.summary}` : '',
            b.best.length ? `Best ideas:\n${b.best.map((i) => `- ${fmtIdea(i)}${i.sum != null ? ` [jury ${i.sum}/15]` : ''}`).join('\n')}` : 'No judged ideas yet.',
            b.projects.length ? `Claude Code projects: ${b.projects.join('; ')}` : '',
          ].filter(Boolean).join('\n'),
        )
        .join('\n\n');
      const user = [
        `These are the idea boards and what they produced (the report covers the last ${a.days} days):`,
        blocks,
        'Write the conclusions of the report for the people running the boards: what holds across boards, which ideas are most worth pursuing, where boards should cross-breed, and what to do next. Be specific and honest; do not praise.',
        `Write in ${LANG_NAME[a.lang]}${a.lang === 'sv' ? ' (idiomatic Swedish)' : ''}. Keep idea and board titles exactly as given.`,
      ].join('\n\n');
      const { value, costUsd } = await chat({
        model: a.model,
        system: 'You are an innovation lead who reads the results of several idea boards and writes the conclusions of a short report.',
        user,
        schemaName: 'synthesis',
        schema: SYNTHESIS_SCHEMA,
        temperature: 0.4,
        maxTokens: 2500,
      });
      const strs = (x: unknown, n: number) => (Array.isArray(x) ? x.map((s) => String(s).trim()).filter(Boolean).slice(0, n) : []);
      return {
        synthesis: {
          headline: String(value?.headline ?? '').trim(),
          insights: strs(value?.insights, 8),
          standouts: (Array.isArray(value?.standouts) ? value.standouts : []).slice(0, 5).map((s: any) => ({
            title: String(s?.title ?? '').trim(), board: String(s?.board ?? '').trim(), why: String(s?.why ?? '').trim(),
          })),
          opportunities: strs(value?.opportunities, 6),
          nextSteps: strs(value?.nextSteps, 6),
        },
        costUsd,
      };
    },

    /** guidance: the board's own jury instructions, on top of the fixed scale. */
    async judge(a: { model: string; board: BoardCtx; idea: Pitch; lang: Lang; guidance?: string; vocabulary?: string[] }) {
      const guidance = (a.guidance ?? '').trim();
      const system = guidance ? `${JUDGE_SYSTEM}\n\nAdditional guidance from this board's facilitator:\n${guidance}` : JUDGE_SYSTEM;
      const user = [
        a.board.goal.trim() ? `The board's goal (the general direction): ${a.board.goal.trim()}` : '',
        `The idea:\n${fmtIdea(a.idea)}`,
        a.board.fixedLang ? `Write the reason in ${LANG_NAME[a.board.fixedLang]}.` : `Write the reason in the language of the idea; if unclear, in ${LANG_NAME[a.lang]}.`,
        a.vocabulary?.length ? `Keyword vocabulary in use (reuse when one fits): ${a.vocabulary.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      const { value, costUsd } = await chat({
        model: a.model,
        system,
        user,
        schemaName: 'judgement',
        schema: JUDGE_SCHEMA,
        temperature: 0.2,
        maxTokens: 600, // room for the lift recipe after the scores
      });
      const judgement: Judgement = {
        originality: clampScore(value?.originality),
        feasibility: clampScore(value?.feasibility),
        impact: clampScore(value?.impact),
        reason: String(value?.reason ?? '').trim().slice(0, 400),
        keywords: normalizeKeywords(value?.keywords),
        liftType: null,
        lift: null,
      };
      // A recipe counts only whole: a known type and a non-empty change.
      const liftType = String(value?.liftType ?? '').trim().toLowerCase();
      const lift = String(value?.lift ?? '').trim().slice(0, 300);
      if ((CRITERIA as readonly string[]).includes(liftType) && lift) Object.assign(judgement, { liftType, lift });
      return { judgement, costUsd };
    },

    /**
     * The recipe check (build 0008): shown the parent, its recipe and the
     * child, rule whether the child really carried out the recipe. It never
     * sees any scores or medals, so the ruling cannot follow the medal.
     * applied is null when the model gave no boolean.
     */
    async checkLift(a: { model: string; parent: Pitch; recipe: { type: string; change: string }; child: Pitch; lang: Lang }) {
      const user = [
        `The parent idea:\n${fmtIdea(a.parent)}`,
        `The recipe the new idea was told to carry out (it raises the parent's ${a.recipe.type}):\n${a.recipe.change}`,
        `The new idea:\n${fmtIdea(a.child)}`,
        `Did the new idea carry out exactly this change? Write the reason in the language of the new idea; if unclear, in ${LANG_NAME[a.lang]}.`,
      ].join('\n\n');
      const { value, costUsd } = await chat({
        model: a.model,
        system:
          'You check whether an instruction was followed. You do not judge whether the idea is good, only whether the stated change is visibly carried out in the new idea. Be strict: a vague nod to the change is not carrying it out.',
        user,
        schemaName: 'liftcheck',
        schema: LIFT_CHECK_SCHEMA,
        temperature: 0,
        maxTokens: 300,
      });
      const applied = typeof value?.applied === 'boolean' ? value.applied : null;
      return { applied, reason: String(value?.reason ?? '').trim().slice(0, 300), costUsd };
    },

    /**
     * The blind duel (build 0009): two ideas as "A" and "B", nothing else. No
     * recipe, no scores, no medals, no lineage, so the model cannot know which
     * is the parent. The caller decides the order (at random) and maps A/B
     * back. A criterion with no valid answer comes back null.
     */
    async duel(a: { model: string; a: Pitch; b: Pitch; lang: Lang }) {
      const user = [
        `Idea A:\n${fmtIdea(a.a)}`,
        `Idea B:\n${fmtIdea(a.b)}`,
        `Compare A and B on each criterion. Write the reason in the language of the ideas; if unclear, in ${LANG_NAME[a.lang]}.`,
      ].join('\n\n');
      const { value, costUsd } = await chat({
        model: a.model,
        system:
          'You compare two ideas side by side and pick the stronger one on each criterion separately. Judge only the text in front of you. The order of A and B means nothing. Say "tie" when the difference on a criterion is not clear.',
        user,
        schemaName: 'duel',
        schema: DUEL_SCHEMA,
        temperature: 0,
        maxTokens: 300,
      });
      const pick = (v: unknown) => (v === 'A' || v === 'B' || v === 'tie' ? v : null);
      const out = Object.fromEntries(CRITERIA.map((c) => [c, pick(value?.[c])])) as Record<(typeof CRITERIA)[number], 'A' | 'B' | 'tie' | null>;
      return { ...out, reason: String(value?.reason ?? '').trim().slice(0, 300), costUsd };
    },

    /**
     * Wording gap (build 0011): rewrite an idea in plain wording, like a
     * manuscript stripped for blinded review. Same substance, no rhetoric.
     * It sees only the idea's text: no scores, reason, medal or style. The
     * engine then rescores the rewrite with the ordinary jury prompt.
     * Returns null for the rewrite when the model gave no usable text.
     */
    async plainRewrite(a: { model: string; idea: Pitch; lang: Lang }) {
      const user = [
        `The idea:\n${fmtIdea(a.idea)}`,
        `Rewrite it in plain wording. Write in the language of the idea; if unclear, in ${LANG_NAME[a.lang]}.`,
      ].join('\n\n');
      const { value, costUsd } = await chat({
        model: a.model,
        system: PLAIN_SYSTEM,
        user,
        schemaName: 'plain',
        schema: PITCH_SCHEMA,
        temperature: 0,
        maxTokens: 300,
      });
      const title = String(value?.title ?? '').trim().slice(0, 120);
      const pitch = String(value?.pitch ?? '').trim().slice(0, 600);
      return { rewrite: title && pitch ? { title, pitch } : null, costUsd };
    },

    /**
     * Codebase boards: read a scanned folder (file tree and docs, never code
     * that was run) and propose directions for ideas. The person picks the
     * directions; the board's goal and jury guidance are built from them.
     */
    async analyzeRepo(a: { model: string; scan: string; lang: Lang }) {
      const { value, costUsd } = await chat({
        model: a.model,
        system:
          'You are a senior engineer reading an unfamiliar codebase for the first time, to help its owner decide what kind of improvements to brainstorm. Base everything on the files shown; never invent features the files do not show.',
        user: `${a.scan}

Describe the codebase and propose directions for improvement ideas. Write in ${LANG_NAME[a.lang]}${a.lang === 'sv' ? ' (idiomatic Swedish)' : ''}.`,
        schemaName: 'repoanalysis',
        schema: REPO_SCHEMA,
        temperature: 0.3,
        maxTokens: 1200,
      });
      const cut = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);
      const focuses: RepoFocus[] = (Array.isArray(value?.focuses) ? value.focuses : [])
        .map((f: any) => ({ label: cut(f?.label, 60), why: cut(f?.why, 300), seed: cut(f?.seed, 120) }))
        .filter((f: RepoFocus) => f.label)
        .slice(0, 6);
      if (!focuses.length) throw new Error('The model proposed no directions');
      return { summary: cut(value?.summary, 800), stack: cut(value?.stack, 300), focuses, costUsd };
    },
  };
}

export type LLM = ReturnType<typeof makeLLM>;
