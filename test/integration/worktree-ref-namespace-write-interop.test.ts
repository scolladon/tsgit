/**
 * Cross-tool interop — writes through the names that select another worktree's ref store.
 *
 * Each row builds two twin repositories of the same shape (a main worktree and one linked
 * worktree, identical object ids), writes the same name with real `git update-ref` in one
 * and tsgit's `updateRef` in the other, and compares what changed in the common dir: every
 * file outside the object store and the index files, log lines reduced to their ids and
 * message. A refusal rebuilds git's stderr line from tsgit's structured error and asserts
 * neither twin changed.
 *
 * @proves
 *   surface:        updateRef
 *   bucket:         cross-tool-interop
 *   unique:         tsgit writes main-worktree/ and worktrees/<id>/ names where git does, or refuses as git does
 *   interopSurface: update-ref
 */
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { __resetConfigCacheForTests } from '../../src/application/primitives/config-read.js';
import { refLocation } from '../../src/application/primitives/path-layout.js';
import { TsgitError } from '../../src/domain/index.js';
import type { ObjectId, RefName } from '../../src/domain/objects/index.js';
import type { Repository } from '../../src/repository.js';
import { GIT_AVAILABLE, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';
import { trackedRepositories } from './repository-lifecycle.js';

const SETUP_TIMEOUT = 60_000;
const FATAL_EXIT = 128;
const MESSAGE = 'probe';
const REPEATS = 3;
const LOCK_SUFFIX = '.lock';
const COMMITTER_EPOCH = 1_700_000_000;
const SKIPPED_ENTRY = /^(objects|index|worktrees\/[^/]+\/index)$/;
const LOG_FILE = /^(logs|worktrees\/[^/]+\/logs)\//;
const PINNED_ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'A',
  GIT_AUTHOR_EMAIL: 'a@x',
  GIT_AUTHOR_DATE: `${COMMITTER_EPOCH} +0000`,
  GIT_COMMITTER_NAME: 'A',
  GIT_COMMITTER_EMAIL: 'a@x',
  GIT_COMMITTER_DATE: `${COMMITTER_EPOCH} +0000`,
};

type Origin = 'main' | 'wt';
type Listing = Readonly<Record<string, string>>;
/** Changed keys of a listing, to their after-value; `null` marks a removed key. */
type Delta = Readonly<Record<string, string | null>>;

interface Shape {
  /** The state, spelled as a Given clause. */
  readonly given: string;
  readonly name: string;
  readonly from: Origin;
  /** The worktree whose HEAD is detached at A before the write. */
  readonly detached?: Origin;
  readonly noDeref?: true;
  /** Files by path relative to the common dir, written once seeded. */
  readonly extraFiles?: Readonly<Record<string, string>>;
  /** Fresh twin pairs the row runs on. */
  readonly runs?: number;
}

interface WriteRow extends Shape {
  /** The common-dir keys git's write changes, sorted. */
  readonly changes: ReadonlyArray<string>;
}

interface RefusalRow extends Shape {
  /** The name whose loose file git cannot lock. */
  readonly colliding: string;
}

interface Fixture {
  readonly root: string;
  readonly common: string;
  readonly cwd: string;
  readonly b: string;
}

const BRANCHES = 'both HEADs on branches';
const MAIN_DETACHED = 'the main HEAD detached and the linked HEAD on a branch';
const LINKED_DETACHED = 'the main HEAD on a branch and the linked HEAD detached';
const MAIN_HEAD_LINK = { 'refs/heads/x': 'ref: main-worktree/HEAD\n' } as const;
const SELF_LINK = { 'refs/bisect/c': 'ref: main-worktree/refs/bisect/c\n' } as const;

const writeRows: ReadonlyArray<WriteRow> = [
  {
    given: BRANCHES,
    name: 'main-worktree/HEAD',
    from: 'wt',
    runs: REPEATS,
    changes: ['logs/HEAD', 'logs/refs/heads/main', 'refs/heads/main'],
  },
  {
    given: MAIN_DETACHED,
    name: 'main-worktree/HEAD',
    from: 'main',
    detached: 'main',
    runs: REPEATS,
    changes: ['HEAD', 'logs/HEAD'],
  },
  {
    given: MAIN_DETACHED,
    name: 'main-worktree/HEAD',
    from: 'wt',
    detached: 'main',
    changes: ['HEAD', 'logs/HEAD'],
  },
  {
    given: BRANCHES,
    name: 'main-worktree/refs/bisect/x',
    from: 'main',
    changes: ['refs/bisect/x'],
  },
  { given: BRANCHES, name: 'main-worktree/refs/bisect/x', from: 'wt', changes: ['refs/bisect/x'] },
  {
    given: BRANCHES,
    name: 'worktrees/wt/refs/bisect/y',
    from: 'main',
    changes: ['worktrees/wt/refs/bisect/y'],
  },
  {
    given: BRANCHES,
    name: 'worktrees/wt/refs/bisect/y',
    from: 'wt',
    changes: ['worktrees/wt/refs/bisect/y'],
  },
  {
    given: BRANCHES,
    name: 'worktrees/wt/HEAD',
    from: 'main',
    runs: REPEATS,
    changes: ['logs/refs/heads/side', 'refs/heads/side', 'worktrees/wt/logs/HEAD'],
  },
  {
    given: LINKED_DETACHED,
    name: 'worktrees/wt/HEAD',
    from: 'wt',
    detached: 'wt',
    runs: REPEATS,
    changes: ['worktrees/wt/HEAD', 'worktrees/wt/logs/HEAD'],
  },
  {
    given: BRANCHES,
    name: 'main-worktree/HEAD',
    from: 'wt',
    noDeref: true,
    changes: ['HEAD', 'logs/HEAD'],
  },
  {
    given: BRANCHES,
    name: 'main-worktree/HEAD',
    from: 'main',
    noDeref: true,
    runs: REPEATS,
    changes: ['HEAD', 'logs/HEAD'],
  },
  {
    given: BRANCHES,
    name: 'worktrees/wt/HEAD',
    from: 'wt',
    noDeref: true,
    runs: REPEATS,
    changes: ['worktrees/wt/HEAD', 'worktrees/wt/logs/HEAD'],
  },
  {
    given: `${BRANCHES} and refs/heads/x naming main-worktree/HEAD`,
    name: 'refs/heads/x',
    from: 'wt',
    extraFiles: MAIN_HEAD_LINK,
    changes: ['logs/HEAD', 'logs/refs/heads/main', 'logs/refs/heads/x', 'refs/heads/main'],
  },
  {
    given: BRANCHES,
    name: 'main-worktree/refs/heads/main',
    from: 'wt',
    changes: ['main-worktree/refs/heads/main'],
  },
  {
    given: BRANCHES,
    name: 'worktrees/wt/refs/heads/side',
    from: 'main',
    changes: ['worktrees/wt/refs/heads/side'],
  },
  {
    given: `${BRANCHES} and no worktree named nope`,
    name: 'worktrees/nope/HEAD',
    from: 'main',
    changes: ['worktrees/nope/HEAD'],
  },
  {
    given: `${BRANCHES} and no worktree named nope`,
    name: 'worktrees/nope/refs/bisect/z',
    from: 'main',
    changes: ['worktrees/nope/refs/bisect/z'],
  },
];

const refusalRows: ReadonlyArray<RefusalRow> = [
  { given: BRANCHES, name: 'main-worktree/HEAD', from: 'main', runs: REPEATS, colliding: 'HEAD' },
  { given: BRANCHES, name: 'worktrees/wt/HEAD', from: 'wt', runs: REPEATS, colliding: 'HEAD' },
  {
    given: `${BRANCHES} and refs/heads/x naming main-worktree/HEAD`,
    name: 'refs/heads/x',
    from: 'main',
    extraFiles: MAIN_HEAD_LINK,
    colliding: 'HEAD',
  },
  {
    given: `${BRANCHES} and refs/bisect/c naming itself through main-worktree/`,
    name: 'refs/bisect/c',
    from: 'main',
    extraFiles: SELF_LINK,
    colliding: 'refs/bisect/c',
  },
];

const roots: string[] = [];
const open = trackedRepositories();

afterEach(async () => {
  __resetConfigCacheForTests();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const git = (dir: string, ...args: ReadonlyArray<string>): string =>
  runGit(['-c', 'commit.gpgsign=false', '-c', 'gc.auto=0', '-C', dir, ...args]);

const commitTree = (dir: string, tree: string, message: string, parents: string[]): string =>
  runGit(['-C', dir, 'commit-tree', tree, ...parents, '-m', message], { env: PINNED_ENV }).trim();

const writeExtraFiles = async (common: string, files: Shape['extraFiles']): Promise<void> => {
  for (const [relative, body] of Object.entries(files ?? {})) {
    await mkdir(path.dirname(path.join(common, relative)), { recursive: true });
    await writeFile(path.join(common, relative), body);
  }
};

const seedCommits = (main: string): { readonly a: string; readonly b: string } => {
  git(main, 'config', 'user.name', 'T');
  git(main, 'config', 'user.email', 't@e');
  const tree = runGit(['-C', main, 'mktree'], { input: '' }).trim();
  const a = commitTree(main, tree, 'A', []);
  return { a, b: commitTree(main, tree, 'B', ['-p', a]) };
};

const buildFixture = async (shape: Shape): Promise<Fixture> => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-wt-ns-write-')));
  roots.push(root);
  const main = path.join(root, 'repo');
  git(root, 'init', '-q', '-b', 'main', main);
  const { a, b } = seedCommits(main);
  git(main, 'update-ref', 'refs/heads/main', a);
  git(main, 'worktree', 'add', '-q', 'wt', '-b', 'side');
  const dirs: Readonly<Record<Origin, string>> = { main, wt: path.join(main, 'wt') };
  git(dirs.main, 'update-ref', 'refs/bisect/s', a);
  git(dirs.wt, 'update-ref', 'refs/bisect/t', a);
  if (shape.detached !== undefined)
    git(dirs[shape.detached], 'update-ref', '--no-deref', 'HEAD', a);
  const common = path.join(main, '.git');
  await writeExtraFiles(common, shape.extraFiles);
  return { root, common, cwd: dirs[shape.from], b };
};

const normalisedLog = (body: string): string =>
  body
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [head = '', message = ''] = line.split('\t');
      const [oldId, newId] = head.split(' ');
      return `${oldId} ${newId}\t${message}`;
    })
    .join('\n');

const listCommon = async (common: string, relative = ''): Promise<Listing> => {
  const listing: Record<string, string> = {};
  for (const entry of await readdir(path.join(common, relative), { withFileTypes: true })) {
    const key = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (SKIPPED_ENTRY.test(key)) continue;
    if (entry.isDirectory()) Object.assign(listing, await listCommon(common, key));
    else {
      const body = await readFile(path.join(common, key), 'utf8');
      listing[key] = LOG_FILE.test(key) ? normalisedLog(body) : body;
    }
  }
  return listing;
};

const deltaOf = (before: Listing, after: Listing): Delta => {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return Object.fromEntries(
    keys
      .filter((key) => before[key] !== after[key])
      .map((key) => [key, after[key] ?? null] as const),
  );
};

const gitWrite = (fixture: Fixture, shape: Shape): ReturnType<typeof tryRunGitWithExit> =>
  tryRunGitWithExit([
    '-C',
    fixture.cwd,
    ...['-c', 'commit.gpgsign=false', '-c', 'gc.auto=0'],
    ...['update-ref', '-m', MESSAGE],
    ...(shape.noDeref ? ['--no-deref'] : []),
    shape.name,
    fixture.b,
  ]);

const tsgitWrite = (repo: Repository, fixture: Fixture, shape: Shape): Promise<void> =>
  repo.primitives.updateRef(shape.name as RefName, fixture.b as ObjectId, {
    reflogMessage: MESSAGE,
    ...(shape.noDeref ? { noDeref: true } : {}),
  });

const rejectionOf = async (write: Promise<void>): Promise<unknown> => {
  try {
    await write;
  } catch (error) {
    return error;
  }
  return undefined;
};

const lockedLine = (error: unknown, lock: string): string => {
  if (!(error instanceof TsgitError) || error.data.code !== 'REF_LOCKED') return String(error);
  const { name } = error.data;
  return `fatal: update_ref failed for ref '${name}': cannot lock ref '${name}': Unable to create '${lock}': File exists.`;
};

const ROOT_SPELLING = '<RB>';

/** A line with its throwaway's root spelled `<RB>`, so the two twins' paths compare. */
const rooted = (line: string, fixture: Fixture): string =>
  line.replaceAll(fixture.root, ROOT_SPELLING);

const firstLine = (stderr: string): string => stderr.split('\n')[0] ?? '';

const whenOf = (shape: Shape): string =>
  `When ${shape.name} is written${shape.noDeref ? ' without dereferencing' : ''} from the ${shape.from} worktree`;

const runsOf = (shape: Shape): ReadonlyArray<number> =>
  Array.from({ length: shape.runs ?? 1 }, (_, index) => index + 1);

describe('worktree ref namespace write interop', () => {
  describe.skipIf(!GIT_AVAILABLE)('against git', () => {
    describe.each(writeRows)('Given $given', (row) => {
      describe(whenOf(row), () => {
        it.each(runsOf(row))(
          'Then tsgit changes the common dir as git does (throwaway %i)',
          async () => {
            // Arrange
            const theirs = await buildFixture(row);
            const ours = await buildFixture(row);
            const [theirsBefore, oursBefore] = [
              await listCommon(theirs.common),
              await listCommon(ours.common),
            ];
            const expected = gitWrite(theirs, row);
            const sut = await open({ cwd: ours.cwd });
            await sut.primitives.resolveRef('HEAD');

            // Act
            await tsgitWrite(sut, ours, row);

            // Assert
            const gitDelta = deltaOf(theirsBefore, await listCommon(theirs.common));
            expect(expected.exitCode).toBe(0);
            expect(Object.keys(gitDelta)).toEqual(row.changes);
            expect(deltaOf(oursBefore, await listCommon(ours.common))).toEqual(gitDelta);
            expect(await sut.primitives.resolveRef('HEAD')).toBe(
              git(theirs.cwd, 'rev-parse', 'HEAD').trim(),
            );
          },
          SETUP_TIMEOUT,
        );
      });
    });

    describe.each(refusalRows)('Given $given', (row) => {
      describe(whenOf(row), () => {
        it.each(runsOf(row))(
          'Then tsgit refuses with git’s lock line and neither twin changes (throwaway %i)',
          async () => {
            // Arrange
            const theirs = await buildFixture(row);
            const ours = await buildFixture(row);
            const [theirsBefore, oursBefore] = [
              await listCommon(theirs.common),
              await listCommon(ours.common),
            ];
            const expected = gitWrite(theirs, row);
            const sut = await open({ cwd: ours.cwd });

            // Act
            const error = await rejectionOf(tsgitWrite(sut, ours, row));

            // Assert
            const lock = `${refLocation(sut.ctx, row.colliding as RefName).loose}${LOCK_SUFFIX}`;
            expect(expected.exitCode).toBe(FATAL_EXIT);
            expect(rooted(lockedLine(error, lock), ours)).toBe(
              rooted(firstLine(expected.stderr), theirs),
            );
            expect(deltaOf(theirsBefore, await listCommon(theirs.common))).toEqual({});
            expect(deltaOf(oursBefore, await listCommon(ours.common))).toEqual({});
          },
          SETUP_TIMEOUT,
        );
      });
    });
  });
});
