// The self-improvement builder, seen from the browser: a live ticker while
// Claude Code builds a gold idea into this app, and a view of every build with
// its journal, screenshots and log. When a build is merged the page reloads,
// so the new feature appears in front of you.

import { api } from './api.js';
import { $, h, clear, toast } from './dom.js';
import { t, errorText } from './i18n.js';

const S = { builds: [], contested: [], active: null, lines: [], enabled: false, onChange: null, onOpenIdea: null, tick: null, collapsed: false, reloadAt: 0 };
const ICON = { queued: '⏳', running: '🔨', merged: '✅', ready: '🟡', failed: '❌', declined: '🚫', interrupted: '⏸', cancelled: '⏹' };
const pad = (n) => String(n ?? '').padStart(4, '0');
const when = (s) => (s ? new Date(s.replace(' ', 'T') + 'Z') : null);
const fmtDur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export async function initBuilds({ onChange, onOpenIdea }) {
  S.onChange = onChange;
  S.onOpenIdea = onOpenIdea;
  $('#builds-btn').addEventListener('click', openBuilds);
  await refresh();
}

async function refresh() {
  try {
    const r = await api('GET', '/api/builds');
    S.enabled = r.enabled;
    S.builds = r.builds;
    S.contested = r.contested ?? [];
    S.active = r.active?.build ?? null;
    S.lines = r.active?.lines ?? [];
  } catch {
    /* an older server without builds: nothing to show */
  }
  renderButton();
  renderTicker();
}

export function buildFor(ideaId) {
  return S.builds.find((b) => b.ideaId === ideaId) ?? null;
}

export async function startBuild(ideaId) {
  try {
    const r = await api('POST', `/api/ideas/${ideaId}/build`, {});
    upsert(r.build);
    S.contested = S.contested.filter((c) => c.id !== ideaId);
    if (!$('#builds').hidden) renderView();
    toast(t('buildQueued', { t: r.build.title }), 'good');
  } catch (e) {
    toast(errorText(e), 'error', 8000);
  }
}

function upsert(b) {
  const i = S.builds.findIndex((x) => x.id === b.id);
  if (i >= 0) S.builds[i] = b;
  else S.builds.unshift(b);
}

/** Live events from the server (broadcast to every board). */
export function onBuildEvent(e) {
  if (e.type === 'build') {
    const before = S.builds.find((x) => x.id === e.build.id);
    upsert(e.build);
    if (e.build.status === 'running') {
      if (S.active?.id !== e.build.id) S.lines = [];
      S.active = e.build;
    } else if (S.active?.id === e.build.id) {
      S.active = null;
      finished(e.build);
    }
    if (before?.status !== e.build.status) S.onChange?.();
    renderButton();
    renderTicker();
    if (!$('#builds').hidden) renderView();
  } else if (e.type === 'contested') {
    // The second judge did not agree on gold: the idea waits here for a human.
    toast(t('contestedToast', { t: e.title, a: e.first, b: e.second }), 'info', 12000);
    refresh().then(() => { if (!$('#builds').hidden) renderView(); });
  } else if (e.type === 'buildLog') {
    if (S.active?.id !== e.id) return;
    S.lines.push(...e.lines);
    if (S.lines.length > 200) S.lines.splice(0, S.lines.length - 200);
    renderLog();
  }
}

function finished(b) {
  const kind = b.status === 'merged' ? 'good' : b.status === 'ready' ? 'info' : 'error';
  toast(t(`buildDone_${b.status}`, { n: pad(b.seq), t: b.title }) + (b.error && b.status !== 'merged' ? ` ${b.error}` : ''), kind, 12000);
  if (b.status === 'merged') {
    // The new code is in main: reload so it runs here (the server restarts by itself under npm run dev).
    S.reloadAt = Date.now() + 6000;
    showResult(b);
    setTimeout(() => location.reload(), 6000);
  } else {
    showResult(b);
  }
}

// ---------------------------------------------------------------- the top-bar button

function renderButton() {
  const btn = $('#builds-btn');
  const queued = S.builds.filter((b) => b.status === 'queued').length;
  const held = S.contested.length;
  btn.textContent = `${S.active ? '🔨 ' : ''}${t('builds')}${queued ? ` (${queued})` : ''}${held ? ` ⚖${held}` : ''}`;
  btn.classList.toggle('busy', !!S.active);
}

// ---------------------------------------------------------------- the ticker

let resultTimer = null;
function showResult(b) {
  const el = $('#build-ticker');
  clearInterval(S.tick);
  S.tick = null;
  clear(el,
    h('div', { class: 'bt-head' },
      h('span', { class: 'bt-title' }, `${ICON[b.status] ?? ''} ${t('buildWord')} ${pad(b.seq)} · ${b.title}`),
      h('span', { class: `bt-phase s-${b.status}` }, t(`bstatus_${b.status}`)),
      h('button', { class: 'icon-btn small', 'aria-label': t('close'), onclick: () => (el.hidden = true) }, '✕'),
    ),
    h('p', { class: 'bt-summary' }, b.summary || b.error || ''),
    b.status === 'merged' ? h('p', { class: 'bt-reload' }, t('buildReloading')) : null,
    h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: openBuilds }, t('buildsAll'))),
  );
  el.hidden = false;
  el.classList.remove('collapsed');
  clearTimeout(resultTimer);
  if (b.status !== 'merged') resultTimer = setTimeout(() => { if (!S.active) el.hidden = true; }, 30_000);
}

function renderTicker() {
  const el = $('#build-ticker');
  const b = S.active;
  if (!b) {
    if (!el.querySelector('.bt-summary')) el.hidden = true;
    clearInterval(S.tick);
    S.tick = null;
    return;
  }
  clearTimeout(resultTimer);
  clear(el,
    h('div', { class: 'bt-head' },
      h('span', { class: 'bt-spinner', 'aria-hidden': 'true' }),
      h('span', { class: 'bt-title' }, `${t('buildingNow')} · ${pad(b.seq)} · ${b.title}`),
      h('span', { class: 'bt-phase' }, t(`phase_${b.phase ?? 'preparing'}`)),
      h('span', { class: 'bt-time muted' }),
      h('button', { class: 'icon-btn small', title: t('buildsAll'), 'aria-label': t('buildsAll'), onclick: openBuilds }, '☰'),
      h('button', {
        class: 'icon-btn small', 'aria-label': t('collapse'),
        onclick: () => { S.collapsed = !S.collapsed; el.classList.toggle('collapsed', S.collapsed); },
      }, '▾'),
    ),
    h('ol', { class: 'bt-log' }),
  );
  el.classList.toggle('collapsed', S.collapsed);
  el.hidden = false;
  renderLog();
  const started = when(b.startedAt) ?? new Date();
  const time = () => { const x = el.querySelector('.bt-time'); if (x) x.textContent = fmtDur(Date.now() - started.getTime()); };
  time();
  clearInterval(S.tick);
  S.tick = setInterval(time, 1000);
}

function renderLog() {
  const ol = $('#build-ticker .bt-log');
  if (!ol) return;
  clear(ol, S.lines.slice(-9).map((l) => h('li', { class: l.startsWith('$') ? 'cmd-line' : l.startsWith('💬') ? 'say-line' : '' }, l)));
}

// ---------------------------------------------------------------- the view of all builds

export async function openBuilds() {
  const root = $('#builds');
  root.hidden = false;
  root.focus();
  await refresh();
  renderView();
}

function close() {
  $('#builds').hidden = true;
}

function renderView() {
  const root = $('#builds');
  const done = S.builds.filter((b) => b.status === 'merged');
  const cost = S.builds.reduce((s, b) => s + (b.costUsd || 0), 0);
  clear(root,
    h('header', { class: 'dash-head' },
      h('h2', {}, t('builds')),
      h('span', { class: 'muted small grow' }, t('buildsIntro')),
      h('button', { class: 'icon-btn', 'aria-label': t('close'), title: t('close'), onclick: close }, '✕'),
    ),
    !S.enabled ? h('p', { class: 'muted' }, t('builderOff')) : null,
    h('div', { class: 'tiles' },
      tile(t('builds'), `${S.builds.length}`),
      tile(t('bstatus_merged'), `${done.length}`),
      tile(t('buildCost'), `$${cost.toFixed(2)}`),
    ),
    S.contested.length
      ? h('section', { class: 'contested-list' },
          h('h3', {}, `⚖ ${t('contestedTitle')}`),
          h('p', { class: 'muted small' }, t('contestedIntro')),
          h('div', { class: 'build-list' }, S.contested.map(contestedCard)))
      : null,
    S.builds.length ? h('div', { class: 'build-list' }, S.builds.map(card)) : h('p', { class: 'muted' }, t('buildsNone')),
  );
}

/** A jury gold the second judge disagreed with: no build yet, a human decides. */
function contestedCard(c) {
  return h('article', { class: 'build-card s-contested' },
    h('div', { class: 'row space' },
      h('h3', {}, `⚖ ${c.title}`),
      h('span', { class: 'bt-phase s-contested' }, t('contested')),
    ),
    c.pitch ? h('p', { class: 'muted small' }, c.pitch) : null,
    h('p', { class: 'small' }, t('contestedScores', { a: c.first, b: c.second, m: c.model ?? '?' })),
    h('div', { class: 'row' },
      h('button', { class: 'btn small cc', title: t('buildHint'), onclick: () => startBuild(c.id) }, `🔨 ${t('contestedBuild')}`),
      h('button', { class: 'btn small', onclick: () => { close(); S.onOpenIdea?.(c.boardId, c.id); } }, t('openIdea')),
    ),
  );
}

function tile(label, value) {
  return h('div', { class: 'tile' }, h('div', { class: 'tile-label' }, label), h('div', { class: 'tile-value' }, value));
}

function card(b) {
  const start = when(b.startedAt), end = when(b.finishedAt);
  const dur = start ? fmtDur((end ?? new Date()).getTime() - start.getTime()) : '';
  const logBox = h('ol', { class: 'build-log', hidden: true });
  const shots = b.shots ?? [];
  return h('article', { class: `build-card s-${b.status}` },
    h('div', { class: 'row space' },
      h('h3', {}, `${ICON[b.status] ?? ''} ${b.seq ? pad(b.seq) + ' · ' : ''}${b.title}`),
      h('span', { class: `bt-phase s-${b.status}` }, b.status === 'running' ? t(`phase_${b.phase ?? 'preparing'}`) : t(`bstatus_${b.status}`)),
    ),
    b.pitch ? h('p', { class: 'muted small' }, b.pitch) : null,
    h('p', { class: 'small muted' },
      [t(b.trigger === 'hand' ? 'byHand' : 'byJury'), dur, b.costUsd ? `$${b.costUsd.toFixed(2)}` : '', b.commit ? b.commit.slice(0, 7) : '', b.branch ?? '']
        .filter(Boolean).join(' · ')),
    b.summary ? h('p', {}, b.summary) : null,
    b.error && b.status !== 'merged' ? h('p', { class: 'error small' }, b.error) : null,
    shots.length
      ? h('div', { class: 'shots' }, shots.map((f) => h('a', { href: `/${b.journalDir}/${f}`, target: '_blank', rel: 'noopener' },
          h('img', { src: `/${b.journalDir}/${f}`, alt: f, loading: 'lazy' }))))
      : null,
    h('div', { class: 'row' },
      b.journalDir && b.finishedAt ? h('a', { class: 'btn small', href: `/${b.journalDir}/README.md`, target: '_blank', rel: 'noopener' }, t('journal')) : null,
      h('button', {
        class: 'btn small',
        onclick: async () => {
          if (!logBox.hidden) { logBox.hidden = true; return; }
          try {
            const r = await api('GET', `/api/builds/${b.id}`);
            clear(logBox, (r.log.length ? r.log : [t('noLog')]).map((l) => h('li', {}, l)));
            logBox.hidden = false;
          } catch (e) { toast(errorText(e), 'error'); }
        },
      }, t('buildLog')),
      b.ideaId && b.boardId ? h('button', { class: 'btn small', onclick: () => { close(); S.onOpenIdea?.(b.boardId, b.ideaId); } }, t('openIdea')) : null,
      ['queued', 'running'].includes(b.status)
        ? h('button', { class: 'btn small danger', onclick: () => api('POST', `/api/builds/${b.id}/cancel`, {}).catch((e) => toast(errorText(e), 'error')) }, t('cancelBuild'))
        : null,
    ),
    logBox,
  );
}

export const buildIcon = (status) => ICON[status] ?? '';
export const buildsEnabled = () => S.enabled;
export const formatSeq = pad;
