// The app: boards, the canvas, panels, dialogs, live updates.

import { api, follow } from './api.js';
import { $, h, clear, toast, debounce, svg } from './dom.js';
import { t, getLang, setLang, applyI18n, errorText } from './i18n.js';
import { Graph, KIND_COLORS } from './graph.js';
import { loadSettings, saveSettings, pushSettings, ROLES, PROVIDER_IDS, providersInUse, DEFAULTS } from './settings.js';
import { medal, scoreSum, fitness, CRITERIA, isJudged, onMedalEdge, confidenceBand, MEDAL_MIN_SUM, goldGate, retrialSum } from './score.js';
import {
  evolutionStats, liftStats, LIFT_TYPES, doubtPenalty, armOf, armHit, trialStats, trialVerdict, ARMS, TRIAL_MIN,
  diversity, diversitySeries, pressureStats, MONOCULTURE_SHARE, DIVERSITY_WINDOW, netLiftStats, CONTROL_EVERY,
  appliedStatus, appliedStats, APPLIED_STATUSES, duelHit, duelStats,
} from './evolve.js';

/** A net lift in medal steps, signed, two decimals: +0.33, −0.50, ±0.00. */
const signed = (x) => (x > 0 ? '+' : x < 0 ? '−' : '±') + Math.abs(x).toFixed(2);
const netClass = (net) => (net == null ? 'none' : net > 0 ? 'up' : net < 0 ? 'down' : 'flat');
import { openDashboard } from './dashboard.js';
import { openReport } from './report.js';
import { initBuilds, onBuildEvent, buildFor, startBuild, openBuilds, buildIcon, formatSeq } from './builds.js';

const MEDAL_ICON = ['–', '🥉', '🥈', '🥇'];
const S = {
  boards: [], board: null, ideas: new Map(), edges: [], leads: [], spinoffs: [], judging: new Set(), retrying: new Set(),
  autopilot: { state: 'manual' }, spentToday: 0, selected: null, templates: [], providers: null,
  settings: loadSettings(), stopFollow: null, createAt: null, leadsTab: 'x', refreshing: {}, exhibit: false,
  version: null,
};
const fail = (e) => toast(errorText(e), 'error', 8000);
// ?camera: the server's progress camera is looking. It must never push its blank settings over yours.
const CAMERA = new URLSearchParams(location.search).has('camera');
const push = (s) => (CAMERA ? api('GET', '/api/providers') : pushSettings(s));
/** Built-in template names are bilingual ("Uppfinnaren · Inventor"); show the half that matches the UI. */
const localName = (name) => {
  const m = /^(.+?) · (.+)$/.exec(name);
  return m ? (getLang() === 'en' ? m[2] : m[1]) : name;
};
const ideaList = () => [...S.ideas.values()];

// ================================================================ canvas

const graph = new Graph($('#canvas'), {
  select(id) {
    S.selected = id;
    graph.select(id);
    renderPanel();
  },
  hover(id, e) {
    const card = $('#hovercard');
    if (id == null || S.exhibit) return card.classList.remove('show');
    const idea = S.ideas.get(id);
    if (!idea) return;
    const sum = scoreSum(idea);
    clear(card, h('strong', {}, idea.title), idea.pitch ? h('p', {}, idea.pitch) : null,
      sum != null ? h('div', { class: 'muted' }, `${sum}/15 ${medal(idea) ? MEDAL_ICON[medal(idea)] : ''}`) : null);
    card.classList.add('show');
    if (e) moveCard(e);
  },
  combine: (a, b) => combine(a, b),
  expand: (id) => expand(id),
  create(x, y) {
    S.createAt = { x, y };
    $('#seed-input').focus();
  },
  moved: debounce(() => savePositions(), 1200),
  dropLead: (id, x, y) => seedLead(id, x, y),
});
// ?debug exposes the canvas for scripted demos and tests (node positions, camera).
if (new URLSearchParams(location.search).has('debug')) window.ideagen = { graph, state: () => S };

const moveCard = (e) => {
  const card = $('#hovercard');
  card.style.left = `${Math.min(e.clientX + 16, innerWidth - card.offsetWidth - 12)}px`;
  card.style.top = `${Math.min(e.clientY + 16, innerHeight - card.offsetHeight - 12)}px`;
};
$('#canvas').addEventListener('pointermove', (e) => $('#hovercard').classList.contains('show') && moveCard(e));

async function savePositions() {
  if (!S.board) return;
  try {
    await api('PUT', `/api/boards/${S.board.id}/positions`, { positions: graph.positions() });
  } catch (e) {
    console.warn('positions', e);
  }
}

// ================================================================ boards

async function loadBoards() {
  S.boards = (await api('GET', '/api/boards')).boards;
  renderBoardMenu();
}

async function openBoard(id) {
  S.stopFollow?.();
  const data = await api('GET', `/api/boards/${id}`);
  S.board = data.board;
  S.ideas = new Map(data.ideas.map((i) => [i.id, i]));
  S.edges = data.edges;
  S.leads = data.leads;
  S.spinoffs = data.spinoffs;
  S.judging = new Set(data.judging);
  S.retrying = new Set(data.retrying ?? []);
  S.autopilot = data.autopilot;
  S.spentToday = data.spentToday;
  S.selected = null;
  localStorage.setItem('ideagen.board', String(id));
  graph.setData(data.ideas, data.edges, data.judging);
  S.stopFollow = follow(id, onEvent);
  renderAll();
}

function onEvent(e) {
  switch (e.type) {
    case 'hello':
      S.autopilot = e.autopilot;
      renderAutopilot();
      // A different commit than the one this page came from: a build was merged and the server restarted.
      if (e.version && S.version && e.version !== S.version) {
        toast(t('newVersion', { v: e.version }), 'good');
        setTimeout(() => location.reload(), 1500);
      }
      S.version ??= e.version;
      // The server restarted and lost the settings it only keeps in memory: hand them over again.
      if (!e.settingsReceived) push(S.settings).then((p) => (S.providers = p)).catch(fail);
      break;
    case 'ideas':
      for (const idea of e.ideas) {
        const before = S.ideas.get(idea.id);
        S.ideas.set(idea.id, idea);
        graph.upsert(idea);
        if (medal(idea) === 3 && (!before || medal(before) !== 3)) {
          graph.burst(idea.id);
          toast(t('gold', { t: idea.title }), 'good');
        }
      }
      renderPanelSoon();
      break;
    case 'edges':
      for (const ed of e.edges) if (!S.edges.some((x) => x.from === ed.from && x.to === ed.to)) S.edges.push(ed);
      graph.addEdges(e.edges);
      break;
    case 'removed':
      for (const id of e.ids) {
        S.ideas.delete(id);
        S.edges = S.edges.filter((x) => x.from !== id && x.to !== id);
        graph.remove(id);
        if (S.selected === id) S.selected = null;
      }
      renderPanelSoon();
      break;
    case 'judging':
      for (const id of e.ids) e.on ? S.judging.add(id) : S.judging.delete(id);
      graph.setJudging(e.ids, e.on);
      if (e.ids.includes(S.selected)) renderPanelSoon();
      break;
    case 'retrying':
      for (const id of e.ids) e.on ? S.retrying.add(id) : S.retrying.delete(id);
      if (e.ids.includes(S.selected)) renderPanelSoon();
      break;
    case 'board':
      S.board = e.board;
      renderHeader();
      renderPanelSoon();
      renderLeads();
      break;
    case 'leads':
      S.leads = [...S.leads.filter((l) => l.source !== e.source), ...e.leads];
      renderLeads();
      break;
    case 'autopilot':
      S.autopilot = e.status;
      if (e.status.spentToday != null) S.spentToday = e.status.spentToday;
      renderAutopilot();
      if (e.status.state === 'error' && e.status.code === 'no_key') toast(errorText(e.status), 'error', 8000);
      break;
    case 'project':
      toast(t('projectCreated', { p: e.path }), 'good', 9000);
      break;
    case 'spinoff':
      S.spinoffs.push({ ideaId: e.ideaId, boardId: e.boardId, title: e.title });
      renderPanelSoon();
      break;
    case 'build':
    case 'buildLog':
    case 'contested':
      onBuildEvent(e);
      break;
    case 'error':
      fail(e);
      break;
  }
}

// ================================================================ actions

async function seedFromBar(ev) {
  ev.preventDefault();
  const input = $('#seed-input');
  const text = input.value.trim();
  if (!text || !S.board) return;
  const at = S.createAt ?? graph.viewCenter();
  S.createAt = null;
  input.disabled = true;
  const isLink = /^(https?:\/\/|www\.)\S+$/i.test(text);
  input.value = '';
  input.placeholder = isLink ? t('readingPage') : text.length > 160 ? t('thinking') : input.placeholder;
  const clearGhost = graph.addGhosts([at]);
  try {
    const { idea } = await api('POST', `/api/boards/${S.board.id}/seed`, { text, x: at.x, y: at.y });
    S.ideas.set(idea.id, idea);
    graph.upsert(idea);
  } catch (e) {
    input.value = text;
    fail(e);
  } finally {
    clearGhost();
    input.disabled = false;
    input.placeholder = t('seedPlaceholder');
    input.focus();
  }
}

async function expand(id) {
  graph.setBusy([id], true);
  const clearGhosts = graph.addGhosts(graph.ghostsAround(id));
  try {
    const r = await api('POST', `/api/ideas/${id}/expand`, {});
    for (const i of r.ideas) { S.ideas.set(i.id, i); graph.upsert(i); }
    graph.addEdges(r.edges);
  } catch (e) {
    fail(e);
  } finally {
    clearGhosts();
    graph.setBusy([id], false);
  }
}

async function combine(a, b) {
  const na = graph.nodes.get(a), nb = graph.nodes.get(b);
  graph.setBusy([a, b], true);
  const clearGhosts = na && nb ? graph.addGhosts([{ x: (na.x + nb.x) / 2, y: (na.y + nb.y) / 2 }]) : () => {};
  try {
    const r = await api('POST', `/api/boards/${S.board.id}/combine`, { a, b });
    S.ideas.set(r.idea.id, r.idea);
    graph.upsert(r.idea);
    graph.addEdges(r.edges);
  } catch (e) {
    fail(e);
  } finally {
    clearGhosts();
    graph.setBusy([a, b], false);
  }
}

async function seedLead(id, x, y) {
  try {
    const r = await api('POST', `/api/leads/${id}/seed`, x == null ? {} : { x, y });
    S.ideas.set(r.idea.id, r.idea);
    graph.upsert(r.idea);
    graph.focusOn(r.idea.id, null);
  } catch (e) {
    fail(e);
  }
}

async function refreshLeads(source) {
  S.refreshing[source] = Date.now();
  renderLeads();
  const tick = setInterval(renderLeads, 1000);
  try {
    const r = await api('POST', `/api/boards/${S.board.id}/leads/${source}`, {});
    S.leads = [...S.leads.filter((l) => l.source !== source), ...r.leads];
    if (r.empty) toast(t('leadsNone'));
    else if (r.dropped) toast(t('leadsDropped', { n: r.dropped }));
  } catch (e) {
    fail(e);
  } finally {
    clearInterval(tick);
    delete S.refreshing[source];
    renderLeads();
  }
}

async function patchBoard(patch) {
  try {
    const { board } = await api('PATCH', `/api/boards/${S.board.id}`, patch);
    S.board = board;
    S.boards = S.boards.map((b) => (b.id === board.id ? { ...b, ...board } : b));
    renderHeader();
    renderBoardMenu();
    return board;
  } catch (e) {
    fail(e);
  }
}

// ================================================================ header

function renderHeader() {
  const b = S.board;
  if (!b) return;
  $('#board-title').value = b.title;
  $('#board-goal').value = b.goal;
  $('#board-goal').title = b.goal || t('goal');
  $('#board-goal').placeholder = t('noGoal');
  $('#board-origin').replaceChildren(
    b.originBoardId
      ? h('button', { class: 'linkish', onclick: () => openBoard(b.originBoardId) }, `↳ ${b.originIdeaTitle} · ${b.originBoardTitle}`)
      : '',
  );
  const auto = b.config.mode === 'auto';
  const btn = $('#mode-toggle');
  btn.textContent = auto ? t('auto') : t('manual');
  btn.classList.toggle('on', auto);
  btn.setAttribute('aria-pressed', String(auto));
  $('#ex-title').textContent = b.title;
  $('#ex-goal').textContent = b.goal;
  renderAutopilot();
}

function renderAutopilot() {
  const st = S.autopilot ?? { state: 'manual' };
  const chip = $('#ap-status');
  if (S.board?.config.mode !== 'auto') {
    chip.textContent = '';
    chip.className = 'ap-chip';
    return;
  }
  const secs = st.until ? Math.max(0, Math.ceil((st.until - Date.now()) / 1000)) : 0;
  const time = st.until ? new Date(st.until).toLocaleTimeString(getLang() === 'sv' ? 'sv-SE' : 'en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
  const key = st.state === 'idle' ? (st.last === 'empty' ? 'ap_idle_empty' : st.last === 'nothing_to_do' ? 'ap_idle_nothing' : 'ap_idle') : `ap_${st.state}`;
  chip.textContent = t(key, { s: `${secs} s`, time, m: st.message ?? '' });
  chip.title = t('apMeta', { n: st.stepsLastHour ?? 0, usd: (st.spentToday ?? S.spentToday ?? 0).toFixed(3) });
  chip.className = `ap-chip ${['error', 'backoff', 'board_budget', 'global_budget', 'hourly'].includes(st.state) ? 'warn' : st.state === 'running' ? 'busy' : ''}`;
  $('#ex-status').textContent = chip.textContent;
}
setInterval(() => S.autopilot?.until && renderAutopilot(), 1000);

function renderBoardMenu() {
  const menu = $('#board-menu');
  clear(
    menu,
    S.boards.map((b) =>
      h('button', { class: `menu-item ${b.id === S.board?.id ? 'current' : ''}`, onclick: () => { menu.hidden = true; openBoard(b.id); } },
        h('span', { class: `dot ${b.config.mode === 'auto' ? 'auto' : ''}` }),
        h('span', { class: 'grow' }, b.title),
        h('span', { class: 'muted' }, String(b.ideaCount ?? '')),
      ),
    ),
    h('hr'),
    h('button', { class: 'menu-item', onclick: () => { menu.hidden = true; newBoardDialog(); } }, `＋ ${t('newBoard')}`),
  );
  $('#board-menu-btn').textContent = `${t('boards')} ▾`;
}

// ================================================================ right panel

let panelQueued = false;
function renderPanelSoon() {
  if (panelQueued) return;
  panelQueued = true;
  requestAnimationFrame(() => {
    panelQueued = false;
    renderPanel();
    if (S.exhibit) renderExhibit();
  });
}

function renderPanel() {
  const idea = S.selected != null ? S.ideas.get(S.selected) : null;
  if (idea) renderIdea(idea);
  else renderOverview();
}

function kindTag(idea) {
  return h('span', { class: 'kind' }, h('span', { class: 'swatch', style: { background: KIND_COLORS[idea.kind] } }), t(`kind_${idea.kind}`));
}

function scoreBlock(idea) {
  if (S.judging.has(idea.id)) return h('div', { class: 'judging' }, h('span', { class: 'spinner' }), t('judging'));
  const sum = scoreSum(idea);
  const m = medal(idea);
  if (sum == null && m == null) {
    return h('div', { class: 'muted row' }, t('notJudged'), h('button', { class: 'btn small', onclick: () => rejudge(idea.id) }, t('rejudge')));
  }
  return h('div', { class: 'score' },
    h('div', { class: 'score-head' },
      sum != null ? h('span', { class: 'big' }, `${sum}`, h('small', {}, '/15')) : null,
      m ? h('span', { class: `medal m${m}` }, MEDAL_ICON[m]) : null,
      idea.medalOverride != null ? h('span', { class: 'muted' }, `(${t('medal')}: ${MEDAL_ICON[idea.medalOverride]})`) : null,
    ),
    sum != null
      ? CRITERIA.map((c) =>
          h('div', { class: 'meter-row' },
            h('span', { class: 'meter-label' }, t(c)),
            h('span', { class: 'meter', role: 'img', 'aria-label': `${t(c)} ${idea[c]}/5` },
              [1, 2, 3, 4, 5].map((n) => h('span', { class: n <= idea[c] ? 'on' : '' }))),
            h('span', { class: 'meter-value' }, `${idea[c]}`),
          ),
        )
      : null,
    idea.reason ? h('p', { class: 'reason' }, idea.reason) : null,
  );
}

/** The jury's lift recipe for this idea, how often that type of recipe has worked here, and the task this idea was bred under. */
function liftBlock(idea) {
  const all = ideaList();
  const stats = liftStats(all);
  const typeName = (type) => t(type).toLowerCase();
  const recipe = idea.recipeType && idea.recipe ? (() => {
    const s = stats[idea.recipeType] ?? { tries: 0, hits: 0 };
    const n = netLiftStats(all)[idea.recipeType];
    return [
      h('div', { class: 'lift-head', title: t('liftRecipeHint') }, `⬆ ${t('liftRecipe')} · ${t(idea.recipeType)}`),
      h('p', { class: 'lift-text' }, idea.recipe),
      h('div', { class: 'lift-rate muted' },
        s.tries ? t('liftHitRate', { type: typeName(idea.recipeType), hits: s.hits, tries: s.tries }) : t('liftHitNone', { type: typeName(idea.recipeType) })),
      n ? h('div', { class: `lift-net net-${netClass(n.net)}`, title: t('netHint', { n: CONTROL_EVERY }) },
        n.net == null ? t('netPanelNone', { n: n.n, c: n.controlN }) : t('netPanel', { net: signed(n.net), n: n.n, c: n.controlN })) : null,
    ];
  })() : null;
  let task = null;
  const arm = armOf(idea);
  if (arm) {
    const parent = S.ideas.get(idea.liftFrom);
    const hit = armHit(idea);
    const key = { placebo: 'liftTaskPlacebo', none: 'liftTaskNone', control: 'liftTaskControl' }[arm] ?? 'liftTask';
    task = h('div', { class: `lift-task arm-${arm}` },
      h('button', { class: 'linkish', disabled: !parent, onclick: () => parent && graph.h.select(parent.id) },
        t(key, { p: parent ? `"${parent.title}"` : '?', type: idea.liftType ? typeName(idea.liftType) : '' })),
      h('div', { class: hit == null ? 'muted' : hit ? 'lift-hit' : 'lift-miss' },
        hit == null ? t('liftTaskPending') : hit ? t('liftTaskHit') : t('liftTaskMiss')),
      appliedLine(idea),
      duelLine(idea),
    );
  }
  if (!recipe && !task) return null;
  return h('div', { class: 'lift' }, task, recipe);
}

/**
 * The second opinion: for a verdict on a medal edge, a blind second judge on
 * another model. Shows the band between the two sums on the 3–15 scale with
 * the medal thresholds, and what the disagreement costs the idea when breeding.
 */
function doubtBlock(idea) {
  if (S.judging.has(idea.id) || !isJudged(idea)) return null;
  const busy = S.retrying.has(idea.id);
  const band = confidenceBand(idea);
  if (!band && !busy && !onMedalEdge(idea)) return null;
  const sum = scoreSum(idea);
  // 13 cells, one per possible sum 3–15; v is a cell's centre, v - 0.5 its left edge.
  const pos = (v) => `${((v - 2.5) / 13) * 100}%`;
  const ask = h('button', { class: 'btn small', onclick: (ev) => askRetrial(idea.id, ev.currentTarget) }, band ? t('retrialAgain') : t('retrialAsk'));
  const head = h('div', { class: 'doubt-head', title: t('retrialHint') }, `⚖ ${t('retrialTitle')}`);
  if (!band) {
    return h('div', { class: 'doubt' }, head,
      h('p', { class: 'muted' }, t('retrialEdge', { sum, medal: MEDAL_ICON[medal(idea)] })),
      busy ? h('div', { class: 'judging' }, h('span', { class: 'spinner' }), t('retrialBusy')) : ask);
  }
  const r = idea.retrial;
  const penalty = doubtPenalty(idea);
  return h('div', { class: `doubt ${band.agree ? 'agree' : 'disagree'}` }, head,
    h('div', { class: 'band', role: 'img', 'aria-label': t('retrialBandAria', { low: band.low, high: band.high }) },
      h('div', { class: 'band-track' },
        Object.values(MEDAL_MIN_SUM).map((v) => h('span', { class: 'band-edge', style: { left: pos(v - 0.5) } })),
        h('span', { class: 'band-fill', style: { left: pos(band.low - 0.5), width: `${((band.gap + 1) / 13) * 100}%` } }),
        h('span', { class: 'band-mark first', style: { left: pos(band.first) }, title: t('retrialFirst') }),
        h('span', { class: 'band-mark second', style: { left: pos(band.second) }, title: t('retrialSecond') }),
      ),
      h('div', { class: 'band-scale muted' }, h('span', {}, '3'), h('span', {}, '15')),
    ),
    h('div', { class: 'doubt-line' },
      h('span', { class: 'band-key first' }), `${t('retrialFirst')} ${band.first}`, ' · ',
      h('span', { class: 'band-key second' }), `${t('retrialSecond')} ${band.second}`,
      h('span', { class: 'muted' }, ` (${CRITERIA.map((c) => r[c]).join('·')}, ${r.model})`),
    ),
    h('div', { class: 'doubt-verdict' },
      band.gap === 0 ? t('retrialSame', { sum: band.first })
      : band.agree ? t('retrialBandSameMedal', { low: band.low, high: band.high })
      : t('retrialBand', { low: band.low, high: band.high, a: MEDAL_ICON[band.medals[0]], b: MEDAL_ICON[band.medals[1]] })),
    r.reason ? h('p', { class: 'reason' }, r.reason) : null,
    penalty ? h('div', { class: 'muted' }, t('retrialPenalty', { p: penalty.toFixed(1) })) : null,
    busy ? h('div', { class: 'judging' }, h('span', { class: 'spinner' }), t('retrialBusy')) : ask,
  );
}

async function askRetrial(id, btn) {
  if (btn) btn.disabled = true;
  try {
    await api('POST', `/api/ideas/${id}/retrial`, {});
  } catch (e) {
    fail(e);
    if (btn) btn.disabled = false;
  }
}

/**
 * Overview: placebo trials. Hits per recipe type in the recipe arm and the
 * placebo arm side by side, the no-task arm in total, and a plain reading of
 * whether recipes beat chance yet.
 */
function liftOverview(ideas) {
  const stats = trialStats(ideas);
  const any = ARMS.some((a) => stats[a].total.tries);
  if (!any && !ideas.some((i) => i.recipe)) return null;
  const cell = (c) => h('td', { class: c.tries ? '' : 'muted' },
    c.tries ? `${c.hits}/${c.tries}` : '–',
    c.tries ? h('span', { class: 'muted' }, ` ${Math.round((100 * c.hits) / c.tries)}%`) : null);
  const v = trialVerdict(stats);
  const pct = (c) => (c.tries ? Math.round((100 * c.hits) / c.tries) : 0);
  return h('div', { class: 'evo lift-overview' },
    h('span', { class: 'muted', title: t('trialHint') }, t('trialTitle')),
    !any ? h('div', { class: 'muted' }, t('liftNoData')) : h('table', { class: 'trial' },
      h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, t('armRecipe')), h('th', {}, t('armPlacebo')))),
      h('tbody', {},
        LIFT_TYPES.map((type) => h('tr', {}, h('th', {}, t(type)), cell(stats.recipe.byType[type]), cell(stats.placebo.byType[type]))),
        h('tr', { class: 'trial-total' }, h('th', {}, t('armTotal')), cell(stats.recipe.total), cell(stats.placebo.total)),
        h('tr', {}, h('th', {}, t('armNone')), cell(stats.none.total), h('td', {}, '')),
      ),
    ),
    any ? h('div', { class: `trial-verdict ${v.verdict}` },
      v.verdict === 'early'
        ? t('trialEarly', { n: TRIAL_MIN, r: stats.recipe.total.tries, p: stats.placebo.total.tries })
        : t(`trial_${v.verdict}`, { r: pct(stats.recipe.total), p: pct(stats.placebo.total) })) : null,
    any ? netChips(ideas) : null,
    any ? appliedSplit(ideas) : null,
    any ? duelSplit(ideas) : null,
  );
}

const DUEL_MARK = { child: '▲', parent: '▼', tie: '=' };

/**
 * A recipe child's blind duel against its parent: one badge per criterion
 * (child won, parent won, tie), the recipe's own criterion ringed, and what
 * the duel made of the recipe. null for other arms and for children with no duel.
 */
function duelLine(idea) {
  if (armOf(idea) !== 'recipe' || !idea.duel) return null;
  const hit = duelHit(idea);
  const ignored = idea.liftApplied === false;
  return h('div', { class: 'duel', title: t('duelHint') },
    h('div', { class: 'duel-head' }, `⇄ ${t('duelTitle')}`),
    h('div', { class: 'duel-badges' },
      CRITERIA.map((c) => {
        const w = idea.duel[c];
        return h('span', {
          class: `duel-badge ${w}${c === idea.liftType ? ' recipe' : ''}`,
          title: t(`duel_${w}`), 'aria-label': `${t(c)}: ${t(`duel_${w}`)}`,
        }, `${DUEL_MARK[w] ?? '?'} ${t(c)}`);
      })),
    h('div', { class: ignored ? 'muted' : hit ? 'lift-hit' : 'lift-miss' },
      ignored ? t('duelIgnored') : t(hit ? 'duelHit' : 'duelMiss', { type: t(idea.liftType).toLowerCase() })),
    idea.duel.reason ? h('div', { class: 'muted duel-reason' }, idea.duel.reason) : null,
  );
}

/** Overview: on the same recipe children, how often the blind duel and the medal call a hit, and who won each criterion. */
function duelSplit(ideas) {
  const s = duelStats(ideas);
  if (!s.n) return null;
  const pct = (k) => Math.round((100 * k) / s.n);
  return h('div', { class: 'duel-split' },
    h('span', { class: 'muted', title: t('duelHint') }, t('duelSplitTitle', { n: s.n })),
    h('div', { class: 'applied-cells' },
      h('span', { class: 'applied-cell' }, t('duelSplitDuel'), ' ', h('b', {}, `${s.duelHits}/${s.n}`), h('span', { class: 'muted' }, ` ${pct(s.duelHits)}%`)),
      h('span', { class: 'applied-cell' }, t('duelSplitMedal'), ' ', h('b', {}, `${s.medalHits}/${s.n}`), h('span', { class: 'muted' }, ` ${pct(s.medalHits)}%`))),
    h('div', { class: 'duel-badges' },
      LIFT_TYPES.map((c) => {
        const b = s.byCriterion[c];
        return h('span', { class: 'duel-tally', title: t('duelTallyHint') },
          `${t(c)} `, h('span', { class: 'duel-badge child' }, `▲${b.child}`), ' ',
          h('span', { class: 'duel-badge parent' }, `▼${b.parent}`), ' ',
          h('span', { class: 'duel-badge tie' }, `=${b.tie}`));
      })),
  );
}

/** A recipe child's check: did it really carry out the recipe? (null for other arms.) */
function appliedLine(idea) {
  const status = appliedStatus(idea);
  if (!status) return null;
  if (status === 'unchecked') return h('div', { class: 'lift-check muted', title: t('appliedHint') }, t('appliedUnchecked'));
  return h('div', { class: `lift-check ${status}`, title: t('appliedHint') },
    h('span', { class: 'applied-badge' }, t(status === 'applied' ? 'appliedYes' : 'appliedNo')),
    idea.liftCheck ? h('span', { class: 'muted' }, ` ${idea.liftCheck}`) : null);
}

/** Overview: the recipe arm's hit rate split by the recipe check's ruling. */
function appliedSplit(ideas) {
  const s = appliedStats(ideas);
  if (!APPLIED_STATUSES.some((k) => s[k].tries)) return null;
  const cell = (k) => {
    const c = s[k];
    return h('span', { class: `applied-cell ${k}${c.tries ? '' : ' muted'}` },
      h('span', {}, t(`applied_${k}`)), ' ',
      h('b', {}, c.tries ? `${c.hits}/${c.tries}` : '–'),
      c.tries ? h('span', { class: 'muted' }, ` ${Math.round((100 * c.hits) / c.tries)}%`) : null);
  };
  return h('div', { class: 'applied-split' },
    h('span', { class: 'muted', title: t('appliedHint') }, t('appliedTitle')),
    h('div', { class: 'applied-cells' }, APPLIED_STATUSES.map(cell)));
}

/** One chip per recipe type: mean medal gain of recipe children minus that of their control siblings, with both n. */
function netChips(ideas) {
  const net = netLiftStats(ideas);
  return h('div', { class: 'net-lift' },
    h('span', { class: 'muted', title: t('netHint', { n: CONTROL_EVERY }) }, t('netTitle')),
    h('div', { class: 'net-chips' },
      LIFT_TYPES.map((type) => {
        const s = net[type];
        const vars = { type: t(type), net: s.net == null ? '–' : signed(s.net), n: s.n, c: s.controlN };
        return h('span', { class: `net-chip net-${netClass(s.net)}`, role: 'img', 'aria-label': t('netChipAria', vars), title: t('netChipAria', vars) },
          t(s.net == null ? 'netChipNone' : 'netChip', vars));
      })));
}

/**
 * Overview: the diversity gauge. One bar per bred idea: the share of the
 * last DIVERSITY_WINDOW bred ideas that carry the board's most common
 * keyword, with the monoculture line. Says which theme dominates, when the
 * current monoculture began, and what the autopilot's pressure has done.
 */
function diversityOverview(ideas) {
  const series = diversitySeries(ideas);
  if (!series.length) return null;
  const now = diversity(ideas);
  const p = pressureStats(ideas);
  const W = 260, H = 44, line = H - MONOCULTURE_SHARE * H;
  const shown = series.slice(-120); // keep bars at least ~2 px wide
  const bw = W / shown.length;
  const pct = (x) => Math.round(x * 100);
  const time = (at) => (at ? new Date(`${at.replace(' ', 'T')}Z`).toLocaleString(getLang() === 'sv' ? 'sv-SE' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '');
  const bars = shown.map((pt, n) =>
    svg('rect', { x: (n * bw).toFixed(2), y: (H - pt.share * H).toFixed(2), width: Math.max(1, bw - 0.6).toFixed(2), height: (pt.share * H).toFixed(2),
      class: pt.monoculture ? 'div-bar mono' : 'div-bar' },
      svg('title', {}, `#${pt.id} · ${pt.keyword} ${pct(pt.share)}%`)));
  return h('div', { class: `evo diversity ${now.monoculture ? 'mono' : ''}` },
    h('span', { class: 'muted', title: t('divHint', { pct: pct(MONOCULTURE_SHARE), n: DIVERSITY_WINDOW }) }, t('divTitle')),
    h('div', {}, t('divNow', { kw: now.keyword, c: now.count, n: now.total, pct: pct(now.share) })),
    svg('svg', { class: 'div-gauge', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': t('divAria', { pct: pct(now.share) }) },
      bars,
      svg('line', { x1: 0, x2: W, y1: line, y2: line, class: 'div-line' })),
    h('div', { class: `div-state ${now.monoculture ? 'mono' : 'ok'}` },
      now.monoculture
        ? t('divMono', { kw: now.keyword, id: p.since?.id ?? '?', at: time(p.since?.at) })
        : t('divOk', { pct: pct(MONOCULTURE_SHARE) })),
    p.escapes
      ? h('div', { class: 'muted' }, t('divEscapes', { n: p.escapes, j: p.judged, left: p.left, at: time(p.last?.createdAt) }))
      : now.monoculture ? h('div', { class: 'muted' }, t('divNoEscapes')) : null,
  );
}

function renderIdea(idea) {
  const panel = $('#panel');
  const spun = S.spinoffs.filter((s) => s.ideaId === idea.id);
  const startCmd = idea.projectPath ? `cd "${idea.projectPath}" && claude` : '';
  const medalBtn = (value, label) =>
    h('button', {
      class: `seg ${idea.medalOverride === value ? 'on' : ''}`,
      onclick: async () => {
        try { await api('PATCH', `/api/ideas/${idea.id}`, { medalOverride: value }); } catch (e) { fail(e); }
      },
    }, label);

  clear(panel,
    h('div', { class: 'panel-top' },
      h('button', { class: 'icon-btn', title: t('close'), 'aria-label': t('close'), onclick: () => graph.h.select(null) }, '✕'),
      kindTag(idea),
      h('span', { class: 'muted' }, t('generation', { n: idea.generation })),
    ),
    idea.kind === 'guest' && idea.originBoardId
      ? h('button', { class: 'linkish', onclick: () => openBoard(idea.originBoardId) }, `↗ ${t('fromBoard', { b: idea.originBoardTitle ?? '?' })}`)
      : null,
    h('h2', {}, idea.title),
    idea.pitch ? h('p', { class: 'pitch' }, idea.pitch) : null,
    idea.sourceUrl ? h('a', { class: 'source', href: idea.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }, `${t('source')} ↗`) : null,
    scoreBlock(idea),
    doubtBlock(idea),
    idea.escape
      ? h('p', { class: 'escape-note', title: t('divHint', { pct: Math.round(MONOCULTURE_SHARE * 100), n: DIVERSITY_WINDOW }) },
          `🌱 ${t('escapeNote', { kw: idea.escape })}`,
          idea.keywords?.length ? h('span', { class: 'muted' }, ' · ', idea.keywords.includes(idea.escape) ? t('escapeStill') : t('escapeLeft')) : null)
      : null,
    liftBlock(idea),
    idea.keywords?.length
      ? h('div', { class: 'chips' }, idea.keywords.map((k) => h('button', { class: 'chip', onclick: () => openDashboard({ keyword: k, onOpenIdea }) }, k)))
      : null,
    h('div', { class: 'seg-row', role: 'group', 'aria-label': t('medal') },
      h('span', { class: 'muted' }, t('medal')),
      medalBtn(null, t('medalAuto')), medalBtn(0, '–'), medalBtn(1, '🥉'), medalBtn(2, '🥈'), medalBtn(3, '🥇'),
    ),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', title: t('expandHint'), onclick: () => expand(idea.id) }, `＋ ${t('expand')}`),
      h('button', { class: 'btn', onclick: () => { graph.setPick(idea.id); toast(t('combinePick')); } }, `⚡ ${t('combineWith')}`),
      h('button', { class: 'btn', onclick: () => rejudge(idea.id) }, t('rejudge')),
      h('button', { class: 'btn', title: t('announceHint'), onclick: () => announceDialog(idea) }, `📣 ${t('announce')}`),
      h('button', { class: 'btn', title: t('spinoffHint'), onclick: () => spinoff(idea) }, `⤴ ${t('spinoff')}`),
    ),
    S.board?.config.selfImprove ? buildBlock(idea) : h('div', { class: 'project' },
      idea.projectPath
        ? [
            h('div', { class: 'path', title: idea.projectPath }, `📁 ${idea.projectPath}`),
            h('div', { class: 'row' },
              h('button', { class: 'btn small', onclick: () => api('POST', `/api/ideas/${idea.id}/reveal`, {}).catch(fail) }, t('revealProject')),
              h('button', { class: 'btn small', onclick: () => navigator.clipboard.writeText(startCmd).then(() => toast(t('copied'))) }, t('copyStart')),
            ),
          ]
        : h('button', { class: 'btn cc', title: t('projectHint'), onclick: (ev) => makeProject(idea, ev.currentTarget) }, `→ ${t('project')}`),
    ),
    spun.length
      ? h('div', { class: 'spinoffs' }, h('span', { class: 'muted' }, t('spinoffs')),
          spun.map((s) => h('button', { class: 'linkish', onclick: () => openBoard(s.boardId) }, `⤴ ${s.title}`)))
      : null,
    h('button', {
      class: 'btn danger small',
      onclick: async () => {
        if (!confirm(t('confirmDelete', { t: idea.title }))) return;
        try { await api('DELETE', `/api/ideas/${idea.id}`); } catch (e) { fail(e); }
      },
    }, t('deleteIdea')),
  );
}

/** On a self-improvement board: the idea's build, or a button that hands it to Claude Code. */
function buildBlock(idea) {
  const b = buildFor(idea.id);
  const again = !b || ['failed', 'declined', 'interrupted', 'cancelled'].includes(b.status);
  // A jury gold on the edge waits for the blind second judge; if they disagree, a human decides.
  const gate = b ? null : goldGate(idea);
  return h('div', { class: 'project build-block' },
    gate === 'waiting' ? h('p', { class: 'gate waiting' }, `⏳ ${t('gateWaiting')}`) : null,
    gate === 'contested' ? h('p', { class: 'gate contested' }, `⚖ ${t('gateContested', { a: scoreSum(idea), b: retrialSum(idea) })}`) : null,
    b ? h('button', { class: 'linkish', onclick: openBuilds },
      `${buildIcon(b.status)} ${t('buildWord')} ${b.seq ? formatSeq(b.seq) : ''} · ${b.status === 'running' ? t(`phase_${b.phase ?? 'preparing'}`) : t(`bstatus_${b.status}`)}`) : null,
    b?.summary ? h('p', { class: 'small muted' }, b.summary) : null,
    again ? h('button', { class: 'btn cc', title: t('buildHint'), onclick: () => startBuild(idea.id) }, `🔨 ${b ? t('buildAgain') : t('buildIt')}`) : null,
  );
}

async function rejudge(id) {
  try {
    await api('POST', `/api/ideas/${id}/judge`, {});
  } catch (e) {
    fail(e);
  }
}

async function makeProject(idea, btn) {
  btn.disabled = true;
  btn.textContent = t('projectMaking');
  try {
    const r = await api('POST', `/api/ideas/${idea.id}/project`, {});
    S.ideas.set(r.idea.id, r.idea);
    graph.upsert(r.idea);
    toast(t('projectCreated', { p: r.path }), 'good', 9000);
    renderPanel();
  } catch (e) {
    fail(e);
    btn.disabled = false;
    btn.textContent = `→ ${t('project')}`;
  }
}

async function spinoff(idea) {
  try {
    const r = await api('POST', `/api/ideas/${idea.id}/spinoff`, {});
    await loadBoards();
    await openBoard(r.board.id);
  } catch (e) {
    fail(e);
  }
}

function renderOverview() {
  const panel = $('#panel');
  const b = S.board;
  if (!b) return clear(panel);
  const ideas = ideaList();
  const stats = evolutionStats(ideas);
  const ranked = ideas.filter((i) => fitness(i) != null).sort((x, y) => fitness(y) - fitness(x)).slice(0, 12);
  const fmt = (v) => (v == null ? '–' : v.toFixed(1));
  const s = b.summary;
  clear(panel,
    h('div', { class: 'panel-top' }, h('h3', {}, t('overview'))),
    !ideas.length ? h('p', { class: 'muted' }, t('noIdeasYet')) : null,
    stats.count
      ? h('div', { class: 'evo' }, h('span', { class: 'muted' }, t('evolution')),
          h('div', {}, stats.latest != null
            ? t('evoLine', { g: stats.generation, first: fmt(stats.first), latest: fmt(stats.latest), best: stats.best })
            : t('evoShort', { g: stats.generation, best: stats.best })))
      : null,
    diversityOverview(ideas),
    liftOverview(ideas),
    h('section', { class: 'summary' },
      h('div', { class: 'row space' }, h('h3', {}, t('summary')),
        ideas.length >= 2 ? h('button', { class: 'btn small', onclick: (ev) => summarize(ev.currentTarget) }, s ? t('resummarize') : t('summarize')) : null),
      s
        ? [
            s.ideaCount !== ideas.length ? h('p', { class: 'stale' }, t('summaryStale', { n: ideas.length - s.ideaCount })) : null,
            h('p', { class: 'headline' }, s.headline),
            s.themes.length ? h('h4', {}, t('themes')) : null,
            s.themes.map((th) => h('p', {}, h('strong', {}, `${th.name}. `), th.insight)),
            s.strongest.length ? h('h4', {}, t('strongest')) : null,
            h('ul', {}, s.strongest.map((x) => h('li', {}, h('strong', {}, x.title), ` – ${x.why}`))),
            s.gaps.length ? h('h4', {}, t('gaps')) : null,
            h('ul', {}, s.gaps.map((x) => h('li', {}, x))),
            s.nextSteps.length ? h('h4', {}, t('nextSteps')) : null,
            h('ul', {}, s.nextSteps.map((x) => h('li', {}, x))),
          ]
        : null,
    ),
    ranked.length ? h('h3', {}, t('topIdeas')) : null,
    h('ol', { class: 'ranking' },
      ranked.map((i) =>
        h('li', {},
          h('button', { class: 'rank-item', onclick: () => { graph.h.select(i.id); graph.focusOn(i.id, Math.max(graph.cam.k, 0.9)); } },
            h('span', { class: 'swatch', style: { background: KIND_COLORS[i.kind] } }),
            h('span', { class: 'grow' }, i.title),
            h('span', { class: 'rank-score' }, `${scoreSum(i) ?? ''} ${medal(i) ? MEDAL_ICON[medal(i)] : ''}`),
          ),
        ),
      ),
    ),
  );
}

async function summarize(btn) {
  btn.disabled = true;
  btn.textContent = t('thinking');
  try {
    const { board } = await api('POST', `/api/boards/${S.board.id}/summary`, {});
    S.board = board;
    renderPanel();
  } catch (e) {
    fail(e);
    btn.disabled = false;
  }
}

// ================================================================ leads panel

function renderLeads() {
  const root = $('#leads-panel');
  if (!S.board || root.hidden) return;
  const src = S.leadsTab;
  const cfg = S.board.config.researchers[src];
  const busy = S.refreshing[src];
  const list = S.leads.filter((l) => l.source === src);
  const tab = (id, label) => h('button', { class: `tab ${src === id ? 'on' : ''}`, role: 'tab', 'aria-selected': String(src === id), onclick: () => { S.leadsTab = id; renderLeads(); } }, label);
  clear(root,
    h('div', { class: 'tabs', role: 'tablist' }, tab('x', t('leadsX')), tab('research', t('leadsResearch'))),
    !cfg.enabled
      ? h('p', { class: 'muted' }, t('researcherOff'))
      : [
          h('div', { class: 'row space' },
            h('span', { class: 'muted small' }, S.board.goal ? `${t('goal')}: ${S.board.goal}${cfg.focus ? ` — ${cfg.focus}` : ''}` : t('noGoal')),
            h('button', { class: 'btn small', disabled: !!busy, onclick: () => refreshLeads(src) },
              busy ? `${t('refreshing')} ${Math.round((Date.now() - busy) / 1000)} s` : t('refresh')),
          ),
          !list.length ? h('p', { class: 'muted' }, t('leadsEmpty')) : h('p', { class: 'muted small' }, t('dragLead')),
          list.map((l) =>
            h('article', {
              class: `lead ${l.ideaId ? 'used' : ''}`, draggable: l.ideaId ? null : 'true',
              ondragstart: (e) => { e.dataTransfer.setData('text/x-lead', String(l.id)); e.dataTransfer.effectAllowed = 'copy'; },
            },
              h('h4', {}, l.title),
              l.summary ? h('p', {}, l.summary) : null,
              l.hook ? h('p', { class: 'hook' }, `→ ${l.hook}`) : null,
              h('div', { class: 'row space' },
                l.url ? h('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer', class: 'small' },
                  src === 'x' ? 'x.com ↗' : `${l.meta?.published ?? ''} ↗`) : h('span'),
                l.ideaId ? h('span', { class: 'muted small' }, `✓ ${t('onBoard')}`) : h('button', { class: 'btn small', onclick: () => seedLead(l.id) }, t('addAsSeed')),
              ),
            ),
          ),
        ],
  );
}

// ================================================================ dialogs

function dialog(id, title, body, buttons) {
  const dlg = $(`#${id}`);
  clear(dlg,
    h('form', { method: 'dialog', class: 'dlg' },
      h('header', {}, h('h2', {}, title), h('button', { class: 'icon-btn', value: 'cancel', 'aria-label': t('close') }, '✕')),
      h('div', { class: 'dlg-body' }, body),
      buttons ? h('footer', {}, buttons) : null,
    ),
  );
  dlg.showModal();
  return dlg;
}

function field(label, input, note) {
  return h('label', { class: 'field' }, h('span', {}, label), input, note ? h('small', { class: 'muted' }, note) : null);
}

async function newBoardDialog(first = false) {
  if (!S.templates.length) S.templates = (await api('GET', '/api/templates')).templates;
  const title = h('input', { required: true, placeholder: t('newBoard') });
  const goal = h('textarea', { rows: 3, placeholder: t('goalPlaceholder') });
  const tpl = h('select', {}, S.templates.map((x) => h('option', { value: x.id }, localName(x.name))));
  const dlg = dialog('dlg', t('newBoard'), [
    first ? h('p', {}, t('firstRun')) : null,
    field(t('title'), title), field(t('goal'), goal), field(t('template'), tpl),
  ], [
    h('button', { class: 'btn', value: 'cancel' }, t('cancel')),
    h('button', {
      class: 'btn primary',
      onclick: async (e) => {
        e.preventDefault();
        try {
          const { board } = await api('POST', '/api/boards', { title: title.value, goal: goal.value, templateId: Number(tpl.value), lang: getLang() });
          dlg.close();
          await loadBoards();
          await openBoard(board.id);
        } catch (err) { fail(err); }
      },
    }, t('create')),
  ]);
  title.focus();
}

async function boardSettingsDialog() {
  const b = S.board;
  if (!S.templates.length) S.templates = (await api('GET', '/api/templates')).templates;
  const c = structuredClone(b.config);
  const inp = (value, props = {}) => h('input', { value, ...props });
  const area = (value, rows = 3, props = {}) => h('textarea', { rows, ...props }, value);
  const title = inp(b.title), goal = area(b.goal, 2, { placeholder: t('goalPlaceholder') });
  const lang = h('select', {}, h('option', { value: 'sv', selected: c.lang === 'sv' }, 'Svenska'), h('option', { value: 'en', selected: c.lang === 'en' }, 'English'));
  const flowName = inp(c.flowName), sys = area(c.flow.system, 3), exp = area(c.flow.expand, 3), comb = area(c.flow.combine, 3);
  const tplSel = h('select', {}, S.templates.map((x) => h('option', { value: x.id }, localName(x.name))));
  const guidance = area(c.judgeGuidance, 2, { placeholder: t('judgeGuidancePh') });
  const autoProj = h('input', { type: 'checkbox', checked: c.autoProjectOnGold });
  const selfOn = h('input', { type: 'checkbox', checked: c.selfImprove });
  const buildsPerDay = inp(c.buildsPerDay, { type: 'number', min: 0, max: 50 });
  const buildModel = inp(c.buildModel, { placeholder: 'opus' });
  const xOn = h('input', { type: 'checkbox', checked: c.researchers.x.enabled }), xFocus = inp(c.researchers.x.focus, { placeholder: t('focusPh') });
  const rOn = h('input', { type: 'checkbox', checked: c.researchers.research.enabled }), rFocus = inp(c.researchers.research.focus, { placeholder: t('focusPh') });
  const mode = h('select', {}, h('option', { value: 'manual', selected: c.mode === 'manual' }, t('manual')), h('option', { value: 'auto', selected: c.mode === 'auto' }, t('auto')));
  const pace = inp(c.autopilotSeconds, { type: 'number', min: 3, max: 3600 });
  const sph = inp(c.rate.stepsPerHour, { type: 'number', min: 1, max: 3600 });
  const usd = inp(c.rate.usdPerDay, { type: 'number', min: 0, step: 0.1 });
  const models = Object.fromEntries(ROLES.map((r) => [r, inp(c.models?.[r] ?? '', { placeholder: S.settings.models[r], list: 'model-list' })]));

  const dlg = dialog('dlg', t('boardSettings'), [
    h('fieldset', {}, h('legend', {}, t('general')), field(t('title'), title), field(t('goal'), goal), field(t('language'), lang)),
    h('fieldset', {}, h('legend', {}, t('flow')),
      h('div', { class: 'row' }, tplSel, h('button', {
        class: 'btn small', type: 'button',
        onclick: () => {
          const x = S.templates.find((y) => y.id === Number(tplSel.value));
          if (!x) return;
          flowName.value = x.name; sys.value = x.system; exp.value = x.expand; comb.value = x.combine;
        },
      }, t('applyTemplate'))),
      field(t('flowName'), flowName), field(t('systemPrompt'), sys), field(t('expandPrompt'), exp), field(t('combinePrompt'), comb),
      h('button', {
        class: 'btn small', type: 'button',
        onclick: async () => {
          try {
            await api('POST', '/api/templates', { name: flowName.value, system: sys.value, expand: exp.value, combine: comb.value });
            S.templates = (await api('GET', '/api/templates')).templates;
            toast(t('templateSaved'));
          } catch (e) { fail(e); }
        },
      }, t('saveAsTemplate')),
    ),
    h('fieldset', {}, h('legend', {}, t('jury')), field(t('judgeGuidance'), guidance),
      h('label', { class: 'check' }, autoProj, t('autoProject'))),
    h('fieldset', {}, h('legend', {}, t('selfImprove')),
      h('label', { class: 'check' }, selfOn, t('selfImproveOn')),
      h('div', { class: 'grid2' }, field(t('buildsPerDay'), buildsPerDay), field(t('buildModel'), buildModel)),
      h('small', { class: 'muted' }, t('selfImproveNote'))),
    h('fieldset', {}, h('legend', {}, t('researchers')),
      h('label', { class: 'check' }, xOn, t('xScout')), field(t('focus'), xFocus),
      h('label', { class: 'check' }, rOn, t('researchScout')), field(t('focus'), rFocus)),
    h('fieldset', {}, h('legend', {}, t('autopilot')),
      field(t('mode'), mode), h('div', { class: 'grid3' }, field(t('pace'), pace), field(t('stepsPerHour'), sph), field(t('usdPerDay'), usd)),
      h('small', { class: 'muted' }, t('rateNote'))),
    h('fieldset', {}, h('legend', {}, t('models')), h('small', { class: 'muted' }, t('modelsBoardNote')),
      h('div', { class: 'grid2' }, ROLES.map((r) => field(t(`role_${r}`), models[r])))),
    h('button', {
      class: 'btn danger small', type: 'button',
      onclick: async () => {
        if (!confirm(t('confirmDeleteBoard', { t: b.title }))) return;
        try {
          await api('DELETE', `/api/boards/${b.id}`);
          dlg.close();
          await loadBoards();
          if (S.boards.length) await openBoard(S.boards[0].id);
          else { S.board = null; await newBoardDialog(true); }
        } catch (e) { fail(e); }
      },
    }, t('deleteBoard')),
  ], [
    h('button', { class: 'btn', value: 'cancel' }, t('cancel')),
    h('button', {
      class: 'btn primary',
      onclick: async (e) => {
        e.preventDefault();
        const board = await patchBoard({
          title: title.value, goal: goal.value,
          config: {
            lang: lang.value, flowName: flowName.value, flow: { system: sys.value, expand: exp.value, combine: comb.value },
            judgeGuidance: guidance.value, autoProjectOnGold: autoProj.checked,
            selfImprove: selfOn.checked, buildsPerDay: Number(buildsPerDay.value), buildModel: buildModel.value,
            researchers: { x: { enabled: xOn.checked, focus: xFocus.value }, research: { enabled: rOn.checked, focus: rFocus.value } },
            mode: mode.value, autopilotSeconds: Number(pace.value), rate: { stepsPerHour: Number(sph.value), usdPerDay: Number(usd.value) },
            models: Object.fromEntries(ROLES.map((r) => [r, models[r].value])),
          },
        });
        if (board) { dlg.close(); renderLeads(); renderPanel(); }
      },
    }, t('save')),
  ]);
}

const PROVIDER_LABELS = {
  claudecode: 'Claude Code (headless)', openrouter: 'OpenRouter', anthropic: 'Anthropic', openai: 'OpenAI',
  azure: 'Azure OpenAI / Microsoft Foundry (Copilot models)', ollama: 'Ollama', mlx: 'MLX (mlx_lm.server)', lmstudio: 'LM Studio', custom: 'OpenAI-compatible',
};
const HAS_URL = ['claudecode', 'ollama', 'mlx', 'lmstudio', 'azure', 'custom'];
const HAS_KEY = ['openrouter', 'anthropic', 'openai', 'azure', 'custom'];
const modelCatalog = new Map();

function refreshModelList() {
  const dl = $('#model-list');
  clear(dl, [...modelCatalog.entries()].flatMap(([p, ids]) => ids.slice(0, 400).map((id) => h('option', { value: `${p}:${id}` }))));
}

function appSettingsDialog() {
  const s = structuredClone(S.settings);
  const status = new Map((S.providers?.providers ?? []).map((p) => [p.id, p]));
  const keys = {}, urls = {};
  const rows = PROVIDER_IDS.map((p) => {
    const st = status.get(p);
    const result = h('span', { class: 'small muted' });
    keys[p] = HAS_KEY.includes(p) ? h('input', { type: 'password', value: s.keys[p] ?? '', placeholder: t('apiKey'), autocomplete: 'off' }) : null;
    urls[p] = HAS_URL.includes(p) ? h('input', { value: s.baseUrls[p] ?? '', placeholder: p === 'claudecode' ? t('ccCommand') : t('baseUrl') }) : null;
    return h('div', { class: 'provider' },
      h('div', { class: 'row space' },
        h('strong', {}, PROVIDER_LABELS[p]),
        h('span', { class: `badge ${st?.keySource ? 'ok' : st?.local ? '' : 'warn'}` },
          st?.local ? t('local') : st?.keySource ? t(`keyFrom_${st.keySource}`) : t('keyMissing')),
      ),
      st?.note ? h('small', { class: 'muted' }, st.note) : null,
      h('div', { class: 'row' }, keys[p], urls[p],
        h('button', {
          class: 'btn small', type: 'button',
          onclick: async () => {
            result.textContent = '…';
            try {
              await saveFromForm(false);
              const { models } = await api('POST', `/api/providers/${p}/models`, {});
              modelCatalog.set(p, models);
              refreshModelList();
              result.textContent = t('testOk', { n: models.length });
            } catch (e) { result.textContent = errorText(e); }
          },
        }, t('test')), result),
    );
  });
  const models = Object.fromEntries(ROLES.map((r) => [r, h('input', { value: s.models[r], list: 'model-list', placeholder: DEFAULTS.models[r] })]));
  const root = h('input', { value: s.projectsRoot });
  const budget = h('input', { type: 'number', min: 0, step: 0.5, value: s.maxUsdPerDay });
  const spend = S.providers ? t('spend', { today: S.providers.spentToday.toFixed(3), total: S.providers.spentTotal.usd.toFixed(3) }) : '';

  async function saveFromForm(close = true) {
    for (const p of PROVIDER_IDS) {
      if (keys[p]) { if (keys[p].value.trim()) s.keys[p] = keys[p].value.trim(); else delete s.keys[p]; }
      if (urls[p]) s.baseUrls[p] = urls[p].value.trim();
    }
    for (const r of ROLES) s.models[r] = models[r].value.trim() || DEFAULTS.models[r];
    s.projectsRoot = root.value.trim() || DEFAULTS.projectsRoot;
    s.maxUsdPerDay = Number(budget.value);
    S.settings = s;
    S.providers = await saveSettings(s);
    if (close) { dlg.close(); toast(t('settingsSaved')); warnMissingKeys(); }
  }

  const dlg = dialog('dlg', t('appSettings'), [
    h('p', { class: 'small muted' }, t('settingsNote')),
    h('fieldset', {}, h('legend', {}, t('providers')), rows),
    h('fieldset', {}, h('legend', {}, t('models')), h('div', { class: 'grid2' }, ROLES.map((r) => field(t(`role_${r}`), models[r]))),
      h('small', { class: 'muted' }, t('calibrateNote'))),
    h('fieldset', {}, h('legend', {}, 'Claude Code'), field(t('projectsRoot'), root)),
    h('fieldset', {}, h('legend', {}, t('autopilot')), field(t('globalBudget'), budget, spend)),
  ], [
    h('button', { class: 'btn', value: 'cancel' }, t('cancel')),
    h('button', { class: 'btn primary', onclick: (e) => { e.preventDefault(); saveFromForm().catch(fail); } }, t('save')),
  ]);
}

function announceDialog(idea) {
  const others = S.boards.filter((b) => b.id !== S.board.id);
  const boxes = others.map((b) => ({ b, box: h('input', { type: 'checkbox' }) }));
  const all = h('input', { type: 'checkbox', onchange: (e) => boxes.forEach((x) => (x.box.checked = e.target.checked)) });
  const dlg = dialog('dlg', t('announceTitle', { t: idea.title }), [
    h('p', { class: 'small muted' }, t('announceHint')),
    others.length
      ? [h('label', { class: 'check' }, all, h('strong', {}, t('allBoards'))), boxes.map(({ b, box }) => h('label', { class: 'check' }, box, b.title, h('span', { class: 'muted small' }, b.goal ? ` · ${b.goal}` : '')))]
      : h('p', {}, t('noOtherBoards')),
  ], [
    h('button', { class: 'btn', value: 'cancel' }, t('cancel')),
    others.length
      ? h('button', {
          class: 'btn primary',
          onclick: async (e) => {
            e.preventDefault();
            const ids = boxes.filter((x) => x.box.checked).map((x) => x.b.id);
            if (!ids.length) return;
            try {
              const r = await api('POST', `/api/ideas/${idea.id}/announce`, { boardIds: ids });
              dlg.close();
              toast(r.guests.length ? t('announced', { n: r.guests.length }) : t('announceNone'), r.guests.length ? 'good' : 'info');
            } catch (err) { fail(err); }
          },
        }, t('announce'))
      : null,
  ]);
}

// ================================================================ exhibition

function renderExhibit() {
  const top = ideaList().filter((i) => fitness(i) != null).sort((a, b) => fitness(b) - fitness(a)).slice(0, 3);
  clear($('#ex-top'), top.map((i) => h('li', {}, h('span', {}, `${medal(i) ? MEDAL_ICON[medal(i)] : ''} ${scoreSum(i) ?? ''}`), ' ', i.title)));
}

async function enterExhibit() {
  S.exhibit = true;
  document.body.classList.add('exhibit');
  graph.followNewest = true;
  graph.insets = { top: 250, right: 40, bottom: 130, left: 40 };
  graph.select(null);
  S.selected = null;
  renderHeader();
  renderExhibit();
  try { await document.documentElement.requestFullscreen?.(); } catch { /* fullscreen is optional */ }
  setTimeout(() => graph.fit(), 300);
  toast(t('exhibitExit'));
}

function leaveExhibit() {
  if (!S.exhibit) return;
  S.exhibit = false;
  document.body.classList.remove('exhibit');
  graph.followNewest = false;
  graph.insets = { top: 30, right: 30, bottom: 100, left: 30 };
  if (document.fullscreenElement) document.exitFullscreen?.();
  renderPanel();
}
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) leaveExhibit(); });

// ================================================================ misc

function onOpenIdea(boardId, ideaId) {
  const go = boardId === S.board?.id ? Promise.resolve() : openBoard(boardId);
  go.then(() => {
    S.selected = ideaId;
    graph.select(ideaId);
    graph.focusOn(ideaId, 1);
    renderPanel();
  });
}

async function exportBoard() {
  try {
    const md = await api('GET', `/api/boards/${S.board.id}/export.md?lang=${getLang()}`);
    const a = h('a', { href: URL.createObjectURL(new Blob([md], { type: 'text/markdown' })), download: `${S.board.title.replace(/[^\p{L}\p{N}]+/gu, '-').toLowerCase()}.md` });
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    fail(e);
  }
}

function warnMissingKeys() {
  const status = new Map((S.providers?.providers ?? []).map((p) => [p.id, p]));
  for (const p of providersInUse(S.settings)) {
    const st = status.get(p);
    if (st && !st.local && st.needsKey && !st.keySource) toast(t('needKey', { p: st.label }), 'error', 10000);
  }
}

function renderAll() {
  applyI18n();
  renderHeader();
  renderBoardMenu();
  renderPanel();
  renderLeads();
  $('#lang-btn').textContent = getLang() === 'sv' ? 'EN' : 'SV';
}

function wire() {
  $('#seedbar').addEventListener('submit', seedFromBar);
  $('#board-menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('#board-menu');
    const r = e.currentTarget.getBoundingClientRect();
    menu.style.left = `${Math.max(8, r.left)}px`;
    menu.style.top = `${r.bottom + 6}px`;
    menu.hidden = !menu.hidden;
  });
  document.addEventListener('click', (e) => { if (!$('#board-menu').contains(e.target)) $('#board-menu').hidden = true; });
  $('#board-title').addEventListener('change', (e) => e.target.value.trim() && patchBoard({ title: e.target.value }));
  $('#board-goal').addEventListener('change', (e) => patchBoard({ goal: e.target.value }));
  for (const id of ['#board-title', '#board-goal']) $(id).addEventListener('keydown', (e) => e.key === 'Enter' && e.target.blur());
  $('#mode-toggle').addEventListener('click', () => patchBoard({ config: { mode: S.board.config.mode === 'auto' ? 'manual' : 'auto' } }).then(renderAutopilot));
  $('#leads-btn').addEventListener('click', () => {
    const p = $('#leads-panel');
    p.hidden = !p.hidden;
    $('#leads-btn').setAttribute('aria-expanded', String(!p.hidden));
    renderLeads();
  });
  $('#dashboard-btn').addEventListener('click', () => openDashboard({ onOpenIdea }));
  $('#report-btn').addEventListener('click', () => openReport({ onOpenIdea, onOpenBoard: (id) => openBoard(id) }));
  $('#exhibit-btn').addEventListener('click', enterExhibit);
  $('#export-btn').addEventListener('click', exportBoard);
  $('#board-settings-btn').addEventListener('click', boardSettingsDialog);
  $('#app-settings-btn').addEventListener('click', appSettingsDialog);
  $('#lang-btn').addEventListener('click', () => { setLang(getLang() === 'sv' ? 'en' : 'sv'); renderAll(); });
  $('#zoom-in').addEventListener('click', () => graph.zoomBy(1.25));
  $('#zoom-out').addEventListener('click', () => graph.zoomBy(0.8));
  $('#fit-btn').addEventListener('click', () => graph.fit());
  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? '');
    if (e.key === 'Escape') {
      if (graph.pick) graph.setPick(null);
      else if (S.exhibit) leaveExhibit();
      else if (!document.querySelector('dialog[open]')) graph.h.select(null);
    }
    if (typing) return;
    if (e.key === '/') { e.preventDefault(); $('#seed-input').focus(); }
    if (e.key === 'f') graph.fit();
  });
}

async function main() {
  wire();
  applyI18n();
  try {
    S.providers = await push(S.settings);
    if (!CAMERA) warnMissingKeys();
  } catch (e) {
    fail(e);
  }
  await loadBoards();
  await initBuilds({ onChange: () => renderPanelSoon(), onOpenIdea });
  const last = Number(localStorage.getItem('ideagen.board'));
  const pick = S.boards.find((b) => b.id === last) ?? S.boards[0];
  if (pick) await openBoard(pick.id);
  else await newBoardDialog(true);
}

main().catch(fail);
