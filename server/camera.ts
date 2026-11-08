// The progress camera: screenshots of the live app, for following the loop
// and for the film. progress/ (gitignored) gets
//   YYYY-MM-DD/HHMMSS-<event>.png   a timelapse every few minutes, plus one at every event
//   latest.png                      always the newest
//   README.md                       a running log with every picture inline (open it in any Markdown viewer)
// Events: startup (also right after a merged build restarts the server), gold,
// a build starting, a build ending. It runs tools/shoot.ts against this server
// with ?camera, so the headless browser never pushes its settings over yours.

import { appendFileSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { localDay } from './db.ts';
import { slugify } from './project.ts';
import { run } from './providers.ts';

export function createCamera(deps: { root: string; port: number; boardId: () => number | null; minutes: number; log?: (m: string) => void }) {
  const dir = join(deps.root, 'progress');
  let busy = false;
  const queue: string[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;

  async function shoot(label: string) {
    const now = new Date();
    const day = localDay(now);
    const time = now.toLocaleTimeString('sv-SE').replace(/:/g, '');
    const rel = `${day}/${time}-${slugify(label).slice(0, 60)}.png`;
    mkdirSync(join(dir, day), { recursive: true });
    if (!existsSync(join(dir, 'README.md'))) {
      writeFileSync(join(dir, 'README.md'), '# Progress\n\nScreenshots of the live app, newest last: a timelapse plus one at every gold idea, build and restart. `latest.png` is always the newest.\n');
    }
    const board = deps.boardId();
    const out = await run(process.execPath, [
      'tools/shoot.ts', '--url', `http://127.0.0.1:${deps.port}/?camera=1`, '--out', join(dir, rel), '--wait', '2500',
      '--eval', 'window.ideagen?.graph.fit()', // the whole board in view
      ...(board ? ['--board', String(board)] : []),
    ], { cwd: deps.root, timeoutMs: 90_000 });
    if (out.code !== 0) return deps.log?.(`[camera] ${label}: ${(out.stderr || out.stdout).trim().slice(0, 200)}`);
    copyFileSync(join(dir, rel), join(dir, 'latest.png'));
    appendFileSync(join(dir, 'README.md'), `\n## ${day} ${now.toLocaleTimeString('sv-SE')} · ${label}\n\n![${label}](${rel})\n`);
  }

  async function pump() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) await shoot(queue.shift()!).catch((e) => deps.log?.(`[camera] ${e?.message ?? e}`));
    } finally {
      busy = false;
    }
  }

  return {
    /** Take a picture soon (pictures are taken one at a time, in order). */
    snap(label: string) {
      if (!queue.includes(label)) queue.push(label);
      pump();
    },
    start() {
      setTimeout(() => this.snap('startup'), 6000);
      if (deps.minutes > 0) timer ??= setInterval(() => this.snap('timelapse'), deps.minutes * 60_000);
      return this;
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

export type Camera = ReturnType<typeof createCamera>;
