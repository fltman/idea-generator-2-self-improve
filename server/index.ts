import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.ts';
import { DEFAULT_APP_SETTINGS, makeChat, type AppSettings } from './providers.ts';
import { createEngine } from './engine.ts';
import { createAutopilot } from './autopilot.ts';
import { createBuilder, selfContext, type Builder } from './builder.ts';
import { createCamera, type Camera } from './camera.ts';
import { createHandler, type Runtime } from './app.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// 8301, not the original app's 8300: both can run, and each has its own browser settings.
const PORT = Number(process.env.PORT ?? 8301);
// Local first: loopback only. There is no login, and API keys pass through here.
const HOST = process.env.HOST ?? '127.0.0.1';

mkdirSync(join(root, 'data'), { recursive: true });
const repo = openDb(process.env.DB_FILE ?? join(root, 'data', 'ideas.db'));

// App settings belong to the browser (localStorage). It pushes them here on
// load and on every change; they are kept in memory only, never on disk.
let settings: AppSettings = structuredClone(DEFAULT_APP_SETTINGS);
let received = false;
const runtime: Runtime = {
  get: () => settings,
  set: (s) => {
    settings = s;
    received = true;
  },
  received: () => received,
};

// Screenshots and boot checks start this server inside a build's worktree: no autopilot, no builder there.
const off = (name: string) => process.env[name] === '1';
let version = '';
try {
  version = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
} catch {
  /* not a git checkout */
}

let builder: Builder | null = null;
let camera: Camera | null = null;
const pictured = new Set<number>();
const engine = createEngine({
  repo, chat: makeChat(runtime.get), settings: runtime.get,
  onGold: (idea, by) => {
    camera?.snap(`gold ${idea.id} ${idea.title}`);
    builder?.enqueue(idea.id, by);
  },
  selfContext: () => selfContext(root),
});
if (!off('IDEAGEN_NO_BUILDER')) {
  builder = createBuilder({
    repo, root,
    emit: (e) => {
      engine.bus.emitAll(e);
      const b = e.type === 'build' ? e.build : null;
      if (b && b.status === 'running' && b.phase === 'building' && !pictured.has(b.id)) {
        pictured.add(b.id); // once per build, not at every update while it builds
        camera?.snap(`build ${b.seq} started ${b.title}`);
      }
      if (b && ['failed', 'declined', 'ready', 'cancelled'].includes(b.status)) camera?.snap(`build ${b.seq} ${b.status} ${b.title}`);
    },
    push: process.env.BUILD_PUSH === '1',
    maxUsdPerBuild: Number(process.env.BUILD_MAX_USD) || undefined,
  }).start();
}
const autopilot = createAutopilot({ repo, engine, settings: runtime.get });
if (!off('IDEAGEN_NO_AUTOPILOT')) autopilot.start();

createServer(createHandler({ repo, engine, autopilot, runtime, publicDir: join(root, 'public'), builder, journalRoot: root, version })).listen(PORT, HOST, () => {
  console.log(`Idégeneratorn: http://localhost:${PORT}${version ? ` (${version})` : ''}`);
  // The progress camera: only on the real server (not in a build's worktree). CAMERA_MINUTES=0 keeps only event pictures.
  if (builder && process.env.CAMERA !== '0') {
    camera = createCamera({
      root, port: PORT, minutes: Number(process.env.CAMERA_MINUTES ?? 10),
      boardId: () => repo.listBoards().find((b) => b.config.selfImprove)?.id ?? null, log: console.log,
    }).start();
  }
  const auto = repo.listBoards().filter((b) => b.config.mode === 'auto');
  if (auto.length) console.log(`Autopilot on for ${auto.length} board(s); they need keys from the browser or the environment.`);
});
