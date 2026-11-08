// Codebase boards: read a local folder so a board can generate ideas for it.
// Read-only: it lists files and reads a few known text files (README, package
// manifests, CLAUDE.md). It never runs the project's code, installs anything
// or follows symlinks out of the folder. The result is a compact text that
// goes into every prompt on the board, so it is capped in size.

import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { expandHome } from './project.ts';

export type RepoScan = {
  path: string;
  name: string;
  /** Files counted per extension (top ones), e.g. { '.ts': 40, '.css': 3 }. */
  languages: Record<string, number>;
  files: number;
  /** Indented file tree, depth- and size-capped. */
  tree: string;
  /** Known text files, each cut to a few thousand characters. */
  docs: { file: string; text: string }[];
  /** The test command guessed from the manifest, if any (shown, never run here). */
  testCommand: string | null;
};

/** Folders that say nothing about the code and can be huge. */
export const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.cache', '.turbo', '.venv', 'venv', 'env',
  '__pycache__', '.pytest_cache', '.mypy_cache', 'target', 'vendor', '.idea', '.vscode', 'data', 'tmp', '.DS_Store',
]);
/** Read in this order; the first matches fill the budget. */
const DOC_FILES = ['README.md', 'README', 'readme.md', 'CLAUDE.md', 'AGENTS.md', 'package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'composer.json', 'Gemfile'];
const DOC_MAX = 3500;
/** Code samples when the docs say little: at most this many files, this many characters each. */
const SAMPLE_FILES = 3;
const SAMPLE_MAX = 3000;
const CODE_EXT = new Set(['.html', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.rb', '.php', '.java', '.kt', '.swift', '.cs', '.vue', '.svelte']);
const ENTRY_NAMES = ['index', 'main', 'app', 'server', 'game', 'cli'];
const TREE_MAX_ENTRIES = 250;
const TREE_MAX_DEPTH = 4;

export class RepoError extends Error {
  code: 'bad_path' | 'not_found' | 'not_dir';
  constructor(code: RepoError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

/** Resolve and check a user-given folder: absolute (or ~/…), existing, a directory. */
export function repoPath(raw: unknown): string {
  const p = typeof raw === 'string' ? expandHome(raw) : '';
  if (!p || !isAbsolute(p)) throw new RepoError('bad_path', 'Give the full path to a folder, like /Users/me/code/app or ~/code/app');
  const abs = resolve(p);
  if (!existsSync(abs)) throw new RepoError('not_found', `No such folder: ${abs}`);
  if (!statSync(abs).isDirectory()) throw new RepoError('not_dir', `Not a folder: ${abs}`);
  return abs;
}

export function scanRepo(raw: unknown): RepoScan {
  const root = repoPath(raw);
  const languages: Record<string, number> = {};
  const lines: string[] = [];
  let files = 0;
  let listed = 0;
  const shallow: string[] = []; // source files at the top two levels, candidates for a code sample

  const walk = (dir: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name) || (name.startsWith('.') && name !== '.github')) continue;
      const full = join(dir, name);
      let st;
      try {
        st = lstatSync(full); // never follow a symlink out of the folder
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      const indent = '  '.repeat(depth);
      if (st.isDirectory()) {
        if (depth < TREE_MAX_DEPTH) {
          if (listed++ < TREE_MAX_ENTRIES) lines.push(`${indent}${name}/`);
          walk(full, depth + 1);
        }
      } else if (st.isFile()) {
        files++;
        if (depth <= 1 && CODE_EXT.has(extname(name).toLowerCase())) shallow.push(full);
        const ext = extname(name).toLowerCase() || name;
        languages[ext] = (languages[ext] ?? 0) + 1;
        if (listed++ < TREE_MAX_ENTRIES) lines.push(`${indent}${name}`);
      }
    }
  };
  walk(root, 0);
  if (listed > TREE_MAX_ENTRIES) lines.push(`… and ${listed - TREE_MAX_ENTRIES} more`);

  const docs: RepoScan['docs'] = [];
  for (const f of DOC_FILES) {
    const full = join(root, f);
    if (docs.some((d) => d.file.toLowerCase() === f.toLowerCase())) continue;
    try {
      if (!lstatSync(full).isFile()) continue;
      const text = readFileSync(full, 'utf8');
      docs.push({ file: f, text: text.length > DOC_MAX ? `${text.slice(0, DOC_MAX)}\n…` : text });
    } catch {
      /* missing or unreadable */
    }
  }

  // Little documentation (a one-file game, a script folder): read the start of the likeliest entry points too.
  const docChars = docs.reduce((n, d) => n + d.text.length, 0);
  if (docChars < 2000) {
    const rank = (f: string) => {
      const n = basename(f).toLowerCase().replace(/\.[^.]+$/, '');
      return (ENTRY_NAMES.indexOf(n) + 1 || 99) + (relative(root, f).includes('/') ? 10 : 0);
    };
    for (const f of shallow.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, SAMPLE_FILES)) {
      try {
        const text = readFileSync(f, 'utf8');
        docs.push({ file: relative(root, f), text: text.length > SAMPLE_MAX ? `${text.slice(0, SAMPLE_MAX)}\n…` : text });
      } catch {
        /* unreadable */
      }
    }
  }

  const top = Object.fromEntries(Object.entries(languages).sort((a, b) => b[1] - a[1]).slice(0, 12));
  return { path: root, name: basename(root), languages: top, files, tree: lines.join('\n'), docs, testCommand: guessTestCommand(docs) };
}

function guessTestCommand(docs: RepoScan['docs']): string | null {
  const pkg = docs.find((d) => d.file === 'package.json');
  if (pkg) {
    try {
      const test = JSON.parse(pkg.text)?.scripts?.test;
      if (typeof test === 'string' && !/no test specified/.test(test)) return 'npm test';
    } catch {
      /* cut off or invalid: fall through */
    }
  }
  if (docs.some((d) => d.file === 'pyproject.toml' || d.file === 'requirements.txt')) return 'python -m pytest';
  if (docs.some((d) => d.file === 'Cargo.toml')) return 'cargo test';
  if (docs.some((d) => d.file === 'go.mod')) return 'go test ./...';
  return null;
}

/** The scan as one prompt-sized text (about 12k characters at most). */
export function scanText(s: RepoScan, max = 12_000): string {
  const langs = Object.entries(s.languages).map(([k, n]) => `${k} ${n}`).join(', ');
  const parts = [
    `Codebase: ${s.name} (${s.files} files; ${langs})`,
    `File tree:\n${s.tree}`,
    ...s.docs.map((d) => `--- ${d.file} ---\n${d.text}`),
  ];
  const text = parts.join('\n\n');
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

/** Relative path for display, if inside the home folder. */
export function shortPath(p: string, home = process.env.HOME ?? ''): string {
  return home && p.startsWith(home + '/') ? `~/${relative(home, p)}` : p;
}
