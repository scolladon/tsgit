/**
 * The matrix fixture of the skip-worktree present-files twins: a real git repo and a
 * tsgit-opened copy, cone checkout of `b/`, default config (no `expectFilesOutsideOfPatterns`),
 * `a/*` absent from disk with the skip-worktree bit on disk.
 */
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm as removeTree,
  utimes,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { type ChangeKind, status } from '../../src/application/commands/status.js';
import { runGit, runGitEnv } from './interop-helpers.js';

const PINNED_DATE = '@1700000000 +0000';
const SETTLE_WAIT_MS = 1200;
const EXPECT_FILES_ON = ['-c', 'sparse.expectFilesOutsideOfPatterns=true'] as const;

export type Files = Readonly<Record<string, string>>;

export const COMMITTED: Files = {
  'a/f': 'base\n',
  'a/g': 'g\n',
  'a/d/x': 'x\n',
  'b/f': 'b\n',
};

export const writeFiles = async (repo: string, files: Files): Promise<void> => {
  for (const [name, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repo, name)), { recursive: true });
    await writeFile(path.join(repo, name), body);
  }
};

const gitEnv = (): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  GIT_AUTHOR_DATE: PINNED_DATE,
  GIT_COMMITTER_DATE: PINNED_DATE,
});

export const gitIn = (repo: string, args: ReadonlyArray<string>): string =>
  runGit(['-C', repo, ...args], { env: gitEnv() });

/** Setup commands run with the clear off, so a seeding step never rewrites the bits it builds. */
export const gitSeed = (repo: string, args: ReadonlyArray<string>): string =>
  gitIn(repo, [...EXPECT_FILES_ON, ...args]);

export type Patterns = 'cone' | 'non-cone';

export interface SeedOptions {
  readonly ignorecase: string;
  readonly patterns?: Patterns | undefined;
}

const applyPatterns = (repo: string, patterns: Patterns): void => {
  if (patterns === 'cone') gitSeed(repo, ['sparse-checkout', 'set', '--cone', 'b']);
  else gitSeed(repo, ['sparse-checkout', 'set', '--no-cone', '/*', '!/a/']);
};

/** main = a/f, a/g, a/d/x, b/f; t2 = main with a/f = v2; sparse checkout on, a/ absent, bits on disk. */
export const seedBase = async (repo: string, opts: SeedOptions): Promise<void> => {
  runGit(['init', '-q', '-b', 'main', repo]);
  gitIn(repo, ['config', 'core.ignorecase', opts.ignorecase]);
  gitIn(repo, ['config', 'user.name', 'A']);
  gitIn(repo, ['config', 'user.email', 'a@a']);
  await writeFiles(repo, COMMITTED);
  gitIn(repo, ['add', '-A']);
  gitIn(repo, ['commit', '-qm', 'c']);
  gitIn(repo, ['checkout', '-q', '-b', 't2']);
  await writeFiles(repo, { 'a/f': 'v2\n' });
  gitIn(repo, ['commit', '-qam', 't2']);
  gitIn(repo, ['checkout', '-q', 'main']);
  applyPatterns(repo, opts.patterns ?? 'cone');
};

/** git's `ls-files -t -s` over the raw bits: what is on disk, with the clear turned off. */
export const tagsOf = (repo: string): string => gitSeed(repo, ['ls-files', '-t', '-s']);

export const diskOf = async (repo: string): Promise<Record<string, string>> => {
  const entries = await readdir(repo, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(repo, path.join(entry.parentPath, entry.name)))
    .filter((name) => !name.startsWith('.git'))
    .sort();
  const bodies = await Promise.all(files.map((name) => readFile(path.join(repo, name), 'utf8')));
  return Object.fromEntries(files.map((name, i) => [name, bodies[i] ?? '']));
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const presentSkipWorktreePaths = (repo: string): string[] =>
  tagsOf(repo)
    .split('\n')
    .filter((line) => line.startsWith('S '))
    .map((line) => line.slice(line.indexOf('\t') + 1))
    .filter((name) => existsSync(path.join(repo, name)));

/**
 * Make the index non-racy with the files as they stand, so an opportunistic writer finds nothing
 * to write. A present skip-worktree entry is never refreshed, so its bit is dropped for the
 * refresh and put back: wait out the timestamp granularity, refresh, touch, wait again.
 */
export const settle = async (repo: string): Promise<void> => {
  const held = presentSkipWorktreePaths(repo);
  await sleep(SETTLE_WAIT_MS);
  if (held.length > 0) gitSeed(repo, ['update-index', '--no-skip-worktree', ...held]);
  gitSeed(repo, ['update-index', '-q', '--really-refresh']);
  if (held.length > 0) gitSeed(repo, ['update-index', '--skip-worktree', ...held]);
  const now = new Date();
  await utimes(path.join(repo, '.git', 'index'), now, now);
  await sleep(SETTLE_WAIT_MS);
};

/** `status --porcelain` as each tool reports it, for a side-by-side comparison. */
const LETTER: Readonly<Record<ChangeKind, string>> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  'type-changed': 'T',
  'mode-changed': 'M',
};

const letterOf = (kind: ChangeKind | undefined): string =>
  kind === undefined ? ' ' : LETTER[kind];

/** git's `status --porcelain` rebuilt from tsgit's structured result. */
export const porcelainOf = async (repo: string): Promise<string> => {
  const result = await status(createNodeContext({ workDir: repo }));
  const changes = result.changes
    .map((change) => `${letterOf(change.staged)}${letterOf(change.unstaged)} ${change.path}`)
    .sort();
  const untracked = result.untracked.map((name) => `?? ${name}`).sort();
  return [...changes, ...untracked].join('\n');
};

export const gitPorcelain = (repo: string): string => {
  const lines = gitIn(repo, ['status', '--porcelain', '-uall']).split('\n').filter(Boolean);
  return [
    ...lines.filter((l) => !l.startsWith('??')).sort(),
    ...lines.filter((l) => l.startsWith('??')).sort(),
  ].join('\n');
};

export interface Twins {
  readonly gitRepo: string;
  readonly tsgitRepo: string;
}

export interface TwinFactory {
  readonly make: (
    opts: SeedOptions,
    tune?: (repo: string) => Promise<void> | void,
  ) => Promise<Twins>;
  readonly dispose: () => Promise<void>;
}

/** One scratch root per suite; every `make` seeds the same repo twice. */
export const createTwinFactory = async (prefix: string): Promise<TwinFactory> => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  let counter = 0;
  return {
    make: async (opts, tune) => {
      counter += 1;
      const gitRepo = path.join(root, `git-${counter}`);
      const tsgitRepo = path.join(root, `tsgit-${counter}`);
      for (const repo of [gitRepo, tsgitRepo]) {
        await seedBase(repo, opts);
        await tune?.(repo);
      }
      return { gitRepo, tsgitRepo };
    },
    dispose: () => removeTree(root, { recursive: true, force: true }),
  };
};
