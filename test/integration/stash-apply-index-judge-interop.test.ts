/**
 * Cross-tool interop — `stash apply --index` and `pop --index` judge the stashed index before
 * any write, as git's `apply --cached` does. Real git pushes and applies in a peer repository,
 * tsgit does the same in its twin; the refusal data, work tree, index, refs and state files are
 * compared.
 *
 * @proves
 *   surface:        stash
 *   bucket:         cross-tool-interop
 *   unique:         stash apply --index judges the stashed index before any write, as git's apply --cached does
 *   interopSurface: stash
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { stashApply, stashPop, stashPush } from '../../src/application/commands/stash.js';
import type { TsgitError } from '../../src/domain/error.js';
import {
  GIT_AVAILABLE,
  makePeerPair,
  type PeerPair,
  runGit,
  tryRunGitWithExit,
} from './interop-helpers.js';
import {
  COMMIT_ENV,
  flagListing,
  indexState,
  listing,
  type Occupant,
  settleIndex,
  staleEntries,
  touchedAt,
} from './occupant-displacement-fixtures.js';

const ROW_TIMEOUT_MS = 60_000;
const TEN_LINES = Array.from({ length: 10 }, (_, i) => `l${i + 1}\n`).join('');
const CONFLICTS_IN_INDEX = 'error: conflicts in index. Try without --index.';
const INDEX_ERROR_LINE =
  /^error: (?:(.+): (?:patch does not apply|already exists in index|does not exist in index)|unable to add cache entry for (.+)|the patch applies to '(.+)' \(\w+\), which does not match the current contents\.|invalid path '(.+)')$/;

const withLine = (n: number, text: string): string =>
  TEN_LINES.split('\n')
    .map((line, i) => (i === n - 1 ? text : line))
    .join('\n');

const gitIn = (dir: string, ...args: string[]): string =>
  runGit(['-C', dir, ...args], { env: COMMIT_ENV });

const put =
  (rel: string, content: string): Occupant =>
  (dir) =>
    writeFileSync(path.join(dir, rel), content);

const stageFile =
  (rel: string, content: string): Occupant =>
  (dir) => {
    put(rel, content)(dir);
    gitIn(dir, 'add', rel);
  };

const committed =
  (rel: string, content: string): Occupant =>
  (dir) => {
    stageFile(rel, content)(dir);
    gitIn(dir, 'commit', '-q', '-m', 'post');
  };

const stagedThenReverted =
  (rel: string, staged: string, worked: string): Occupant =>
  (dir) => {
    stageFile(rel, staged)(dir);
    put(rel, worked)(dir);
  };

const stageInDirectory =
  (rel: string, content: string): Occupant =>
  (dir) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    stageFile(rel, content)(dir);
  };

const removed: Occupant = (dir) => gitIn(dir, 'rm', '-q', 'f');

const inOrder =
  (...steps: Occupant[]): Occupant =>
  (dir) => {
    for (const step of steps) step(dir);
  };

const SHAPES = {
  H2: {
    stage: inOrder(stageFile('f', 'I\n'), put('f', 'W\n'), put('g', 'g1\n')),
    post: committed('f', 'W\n'),
  },
  delete: {
    stage: inOrder(removed, put('g', 'g1\n')),
    post: committed('f', withLine(9, 'L9\n')),
  },
  'add-add': {
    stage: inOrder(stageFile('n', 'N\n'), put('g', 'g1\n')),
    post: committed('n', 'M\n'),
  },
  'non-overlap': {
    stage: inOrder(stageFile('f', withLine(2, 'L2\n')), put('g', 'g1\n')),
    post: committed('f', withLine(9, 'L9\n')),
  },
  'offset-mid': {
    stage: inOrder(stageFile('f', withLine(6, 'L6\n')), put('g', 'g1\n')),
    post: committed('f', `x1\nx2\n${TEN_LINES}`),
  },
  'i-is-c': {
    stage: inOrder(stageFile('f', withLine(2, 'L2\n')), put('g', 'g1\n')),
    post: committed('f', withLine(2, 'L2\n')),
  },
  'i-is-b': {
    stage: inOrder(put('f', withLine(2, 'L2\n')), put('g', 'g1\n')),
    post: committed('h', 'h\n'),
  },
  'w-is-b': {
    stage: inOrder(stageFile('f', withLine(2, 'L2\n')), put('f', TEN_LINES)),
    post: committed('h', 'h\n'),
  },
  'staged-non-overlap': {
    stage: inOrder(stageFile('f', withLine(2, 'L2\n')), put('g', 'g1\n')),
    post: stageFile('f', withLine(9, 'L9\n')),
  },
  'staged-other': {
    stage: inOrder(stageFile('f', withLine(2, 'L2\n')), put('g', 'g1\n')),
    post: stageFile('h', 'h\n'),
  },
  'w-is-b-staged': {
    stage: inOrder(stageFile('f', withLine(2, 'L2\n')), put('f', TEN_LINES)),
    post: stageFile('h', 'h\n'),
  },
  'i-is-b-staged': {
    stage: inOrder(put('f', withLine(2, 'L2\n')), put('g', 'g1\n')),
    post: stageFile('h', 'h\n'),
  },
  'staged-revert': {
    stage: inOrder(stageFile('f', withLine(2, 'L2\n')), put('g', 'g1\n')),
    post: stagedThenReverted('g', 'g9\n', 'g0\n'),
  },
  adjacent: {
    stage: inOrder(stageFile('f', withLine(4, 'L4\n')), put('g', 'g1\n')),
    post: committed('f', withLine(6, 'L6\n')),
  },
  'same-change': {
    stage: inOrder(stageFile('f', withLine(2, 'L2\n')), put('g', 'g1\n')),
    post: inOrder(committed('f', withLine(2, 'L2\n')), committed('h', 'h\n')),
  },
  'non-overlap-kept': {
    stage: inOrder(stageFile('f', withLine(2, 'L2\n')), put('g', 'g1\n')),
    post: committed('f', withLine(9, 'L9\n').replace('l2\n', 'L2\n')),
  },
  'add-same': {
    stage: inOrder(stageFile('n', 'N\n'), put('g', 'g1\n')),
    post: inOrder(committed('n', 'N\n'), committed('h', 'h\n')),
  },
  'offset-top': {
    stage: inOrder(stageFile('f', withLine(2, 'L2\n')), put('g', 'g1\n')),
    post: committed('f', `x1\nx2\n${TEN_LINES}`),
  },
  'create-df': {
    stage: inOrder(stageInDirectory('n/x', 'X\n'), put('g', 'g1\n')),
    post: committed('n', 'N\n'),
  },
  'create-df-two': {
    stage: inOrder(
      stageInDirectory('m/y', 'Y\n'),
      stageInDirectory('n/x', 'X\n'),
      put('g', 'g1\n'),
    ),
    post: inOrder(committed('m', 'M\n'), committed('n', 'N\n')),
  },
  'attr-no-diff': {
    stage: inOrder(
      committed('.gitattributes', 'f -diff\n'),
      stageFile('f', withLine(2, 'L2\n')),
      put('g', 'g1\n'),
    ),
    post: committed('f', withLine(9, 'L9\n')),
  },
} satisfies Record<string, { stage: Occupant; post: Occupant }>;

type ShapeName = keyof typeof SHAPES;

const PUSHES = {
  plain: { git: [] as string[], opts: {} },
  '-u': { git: ['-u'], opts: { includeUntracked: true } },
  '--keep-index': { git: ['--keep-index'], opts: { keepIndex: true } },
};

const COMMANDS = {
  apply: { git: ['apply'], restoreIndex: false, pops: false },
  'apply --index': { git: ['apply', '--index'], restoreIndex: true, pops: false },
  'pop --index': { git: ['pop', '--index'], restoreIndex: true, pops: true },
} as const;

type PushName = keyof typeof PUSHES;
type CommandName = keyof typeof COMMANDS;

interface Row {
  readonly shape: ShapeName;
  readonly push: PushName;
  readonly command: CommandName;
  readonly git: 'refuses' | 'unclean' | 'applies';
}

const BOTH_COMMANDS: ReadonlyArray<CommandName> = ['apply --index', 'pop --index'];

const rowsOf = (
  shapes: ReadonlyArray<ShapeName>,
  pushes: ReadonlyArray<PushName>,
  commands: ReadonlyArray<CommandName>,
  git: Row['git'],
): Row[] =>
  shapes.flatMap((shape) =>
    pushes.flatMap((push) => commands.map((command) => ({ shape, push, command, git }))),
  );

const ROWS: ReadonlyArray<Row> = [
  ...rowsOf(['H2'], ['plain', '-u', '--keep-index'], BOTH_COMMANDS, 'refuses'),
  ...rowsOf(['delete'], ['plain'], BOTH_COMMANDS, 'refuses'),
  ...rowsOf(['delete'], ['-u'], ['apply --index'], 'refuses'),
  ...rowsOf(['add-add'], ['plain'], BOTH_COMMANDS, 'refuses'),
  ...rowsOf(['add-add'], ['-u', '--keep-index'], ['apply --index'], 'refuses'),
  ...rowsOf(['non-overlap'], ['plain', '-u'], BOTH_COMMANDS, 'applies'),
  ...rowsOf(['offset-mid'], ['plain'], BOTH_COMMANDS, 'applies'),
  ...rowsOf(['offset-mid'], ['-u'], ['apply --index'], 'applies'),
  ...rowsOf(['i-is-b', 'i-is-c'], ['plain'], BOTH_COMMANDS, 'applies'),
  ...rowsOf(['i-is-b', 'i-is-c'], ['-u', '--keep-index'], ['apply --index'], 'applies'),
  ...rowsOf(['w-is-b'], ['plain'], ['apply --index'], 'applies'),
  ...rowsOf(['adjacent'], ['plain', '-u'], BOTH_COMMANDS, 'refuses'),
  ...rowsOf(['same-change'], ['plain', '-u', '--keep-index'], BOTH_COMMANDS, 'refuses'),
  ...rowsOf(['non-overlap-kept'], ['--keep-index'], BOTH_COMMANDS, 'refuses'),
  ...rowsOf(['add-same'], ['plain'], BOTH_COMMANDS, 'refuses'),
  ...rowsOf(['offset-top'], ['plain', '-u', '--keep-index'], ['apply --index'], 'refuses'),
  ...rowsOf(['offset-top'], ['plain'], ['pop --index'], 'refuses'),
  ...rowsOf(['create-df'], ['plain'], BOTH_COMMANDS, 'refuses'),
  ...rowsOf(['create-df-two', 'attr-no-diff'], ['plain'], BOTH_COMMANDS, 'refuses'),
  ...rowsOf(['H2'], ['plain'], ['apply'], 'applies'),
  ...rowsOf(['staged-non-overlap'], ['plain', '-u'], BOTH_COMMANDS, 'unclean'),
  ...rowsOf(['staged-other'], ['plain', '-u'], BOTH_COMMANDS, 'unclean'),
  ...rowsOf(['w-is-b-staged'], ['plain', '-u'], BOTH_COMMANDS, 'unclean'),
  ...rowsOf(['staged-revert'], ['plain'], ['apply --index'], 'unclean'),
  ...rowsOf(['i-is-b-staged'], ['plain'], BOTH_COMMANDS, 'applies'),
];

const title = (row: Row): string => `${row.shape} pushed by ${row.push}`;

const seed = (dir: string): void => {
  runGit(['init', '-q', '-b', 'main', dir]);
  runGit(['-C', dir, 'config', 'user.name', 'Ada']);
  runGit(['-C', dir, 'config', 'user.email', 'ada@example.com']);
  writeFileSync(path.join(dir, 'keep'), 'k\n');
  writeFileSync(path.join(dir, 'f'), TEN_LINES);
  writeFileSync(path.join(dir, 'g'), 'g0\n');
  gitIn(dir, 'add', '.');
  gitIn(dir, 'commit', '-q', '-m', 'base');
  settleIndex(dir);
};

const gitStash = (dir: string, args: ReadonlyArray<string>) =>
  tryRunGitWithExit(['-C', dir, 'stash', ...args], { env: COMMIT_ENV });

const pushedTrees = (dir: string): string => {
  const ref = (rev: string): string =>
    tryRunGitWithExit(['-C', dir, 'rev-parse', '--quiet', '--verify', rev]).stdout.trim();
  const parents = tryRunGitWithExit(['-C', dir, 'rev-list', '--parents', '-n1', 'refs/stash']);
  return [
    ref('refs/stash^{tree}'),
    ref('refs/stash^2^{tree}'),
    ref('refs/stash^3^{tree}'),
    String(parents.stdout.trim().split(' ').length),
  ].join(' ');
};

const indexInode = (dir: string): number => statSync(path.join(dir, '.git', 'index')).ino;

const reflogLines = (dir: string): number => {
  const file = path.join(dir, '.git', 'logs', 'refs', 'stash');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0;
};

const observed = (dir: string, inodeBefore: number) => ({
  work: listing(dir),
  index: indexState(dir),
  flags: flagListing(dir),
  stale: staleEntries(dir),
  autoMerge: existsSync(path.join(dir, '.git', 'AUTO_MERGE')),
  reflog: reflogLines(dir),
  inodeChanged: indexInode(dir) !== inodeBefore,
});

type Outcome =
  | { readonly kind: 'applied' | 'conflict' }
  | { readonly kind: 'STASH_INDEX_CONFLICT'; readonly paths: ReadonlyArray<string> }
  | {
      readonly kind: 'STASH_APPLY_WOULD_OVERWRITE';
      readonly localChanges: ReadonlyArray<string>;
      readonly untracked: ReadonlyArray<string>;
    };

type UncleanOutcome = Extract<Outcome, { kind: 'STASH_APPLY_WOULD_OVERWRITE' }>;

const tsgitApply = async (dir: string, row: Pick<Row, 'command'>): Promise<Outcome> => {
  const command = COMMANDS[row.command];
  const sut = command.pops ? stashPop : stashApply;
  try {
    const result = await sut(createNodeContext({ workDir: dir }), {
      restoreIndex: command.restoreIndex,
    });
    return { kind: result.kind };
  } catch (error) {
    const { data } = error as TsgitError;
    if (data.code === 'STASH_APPLY_WOULD_OVERWRITE')
      return { kind: data.code, localChanges: data.localChanges, untracked: data.untracked };
    if (data.code !== 'STASH_INDEX_CONFLICT') throw error;
    return { kind: data.code, paths: data.paths };
  }
};

/** git names a path once per failure kind it reports: the content-mismatch form comes with a second line. */
const conflictedPathsOfGit = (stderr: string): string[] => [
  ...new Set(
    stderr
      .split('\n')
      .map((line) =>
        INDEX_ERROR_LINE.exec(line)
          ?.slice(1)
          .find((captured) => captured !== undefined),
      )
      .filter((p): p is string => p !== undefined),
  ),
];

const uncleanBlock = (localChanges: ReadonlyArray<string>): string =>
  [
    'error: Your local changes to the following files would be overwritten by merge:',
    `  ${localChanges.join(' ')}`,
    'Index was not unstashed.',
  ].join('\n');

const lastLine = (stderr: string): string => stderr.trimEnd().split('\n').at(-1) ?? '';

const statusOf = (dir: string): string => runGit(['-C', dir, 'status', '--porcelain', '-uall']);

const plumb = (dir: string, args: ReadonlyArray<string>, input?: string): string =>
  runGit(['-C', dir, ...args], {
    env: COMMIT_ENV,
    ...(input === undefined ? {} : { input }),
  }).trim();

type HostileShape = 'invalid-name' | 'base-only';

/** A stash whose stashed index (or base) holds a `.git/x` entry, built with plumbing as a hostile peer could. */
const storeHostileStash = (dir: string, shape: HostileShape): void => {
  const blob = plumb(dir, ['hash-object', '-w', '--stdin'], 'x\n');
  const inner = plumb(dir, ['mktree'], `100644 blob ${blob}\tx\n`);
  const head = plumb(dir, ['rev-parse', 'HEAD']);
  const headTree = plumb(dir, ['rev-parse', 'HEAD^{tree}']);
  const listed = plumb(dir, ['ls-tree', 'HEAD']);
  const treeWith = (entry: string): string => plumb(dir, ['mktree'], `${listed}\n${entry}\n`);
  const commitTree = (tree: string, ...parents: string[]): string =>
    plumb(dir, ['commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent]), '-m', 'x']);
  const hostile = treeWith(`040000 tree ${inner}\t.git`);
  const stashed =
    shape === 'invalid-name'
      ? [head, commitTree(hostile, head)]
      : [commitTree(hostile), commitTree(treeWith(`100644 blob ${blob}\tz`), commitTree(hostile))];
  const [base, index] = stashed as [string, string];
  plumb(dir, ['stash', 'store', '-m', 'wip', commitTree(headTree, base, index)]);
};

describe.skipIf(!GIT_AVAILABLE)('stash apply --index judge interop', () => {
  let pair: PeerPair;

  beforeEach(async () => {
    pair = await makePeerPair('stash-apply-index-judge');
  });

  afterEach(async () => {
    await pair.dispose();
  });

  describe.each(ROWS.map((row) => [title(row), row] as const))('Given %s', (_name, row) => {
    describe(`When ${row.command} runs in git and in tsgit on a twin`, () => {
      it(
        'Then the outcome, work tree, index, refs and state files agree with git',
        async () => {
          // Arrange
          for (const dir of [pair.peer, pair.ours]) {
            seed(dir);
            if (row.push === '-u') put('u', 'u\n')(dir);
            SHAPES[row.shape].stage(dir);
          }
          gitStash(pair.peer, ['push', '-q', ...PUSHES[row.push].git]);
          const sutPush = stashPush;
          await sutPush(createNodeContext({ workDir: pair.ours }), PUSHES[row.push].opts);
          for (const dir of [pair.peer, pair.ours]) {
            settleIndex(dir);
            SHAPES[row.shape].post(dir);
            touchedAt('keep')(dir);
          }
          const pushed = [pushedTrees(pair.peer), pushedTrees(pair.ours)] as const;
          const inodes = [indexInode(pair.peer), indexInode(pair.ours)] as const;

          // Act
          const gitRun = gitStash(pair.peer, COMMANDS[row.command].git);
          const outcome = await tsgitApply(pair.ours, row);

          // Assert
          expect(pushed[1]).toBe(pushed[0]);
          if (row.git === 'refuses') {
            expect(gitRun.exitCode).toBe(1);
            expect(lastLine(gitRun.stderr)).toBe(CONFLICTS_IN_INDEX);
            expect(outcome).toStrictEqual({
              kind: 'STASH_INDEX_CONFLICT',
              paths: conflictedPathsOfGit(gitRun.stderr),
            });
            expect(observed(pair.ours, inodes[1]).reflog).toBe(1);
            expect(observed(pair.ours, inodes[1]).autoMerge).toBe(false);
            expect(existsSync(path.join(pair.ours, 'u'))).toBe(false);
          } else if (row.git === 'unclean') {
            expect(gitRun.exitCode).toBe(1);
            expect(outcome.kind).toBe('STASH_APPLY_WOULD_OVERWRITE');
            const { localChanges, untracked } = outcome as UncleanOutcome;
            expect(untracked).toStrictEqual([]);
            expect(gitRun.stderr).toContain(uncleanBlock(localChanges));
            expect(observed(pair.ours, inodes[1]).reflog).toBe(1);
            expect(observed(pair.ours, inodes[1]).autoMerge).toBe(false);
            expect(existsSync(path.join(pair.ours, 'u'))).toBe(row.push === '-u');
          } else {
            expect(gitRun.exitCode).toBe(0);
            expect(outcome).toStrictEqual({ kind: 'applied' });
            expect(statusOf(pair.ours)).toBe(statusOf(pair.peer));
          }
          expect(observed(pair.ours, inodes[1])).toStrictEqual(observed(pair.peer, inodes[0]));
        },
        ROW_TIMEOUT_MS,
      );
    });
  });
  describe.each(['invalid-name', 'base-only'] as const)(
    'Given a stash holding .git/x as %s',
    (shape) => {
      describe.each(BOTH_COMMANDS)('When %s runs in git and in tsgit on a twin', (command) => {
        it(
          'Then both refuse with the same paths and write nothing',
          async () => {
            // Arrange
            for (const dir of [pair.peer, pair.ours]) {
              seed(dir);
              storeHostileStash(dir, shape);
              touchedAt('keep')(dir);
            }
            const inodes = [indexInode(pair.peer), indexInode(pair.ours)] as const;

            // Act
            const gitRun = gitStash(pair.peer, COMMANDS[command].git);
            const outcome = await tsgitApply(pair.ours, { command });

            // Assert
            expect(gitRun.exitCode).toBe(1);
            expect(lastLine(gitRun.stderr)).toBe(CONFLICTS_IN_INDEX);
            expect(outcome).toStrictEqual({
              kind: 'STASH_INDEX_CONFLICT',
              paths: conflictedPathsOfGit(gitRun.stderr),
            });
            expect(observed(pair.ours, inodes[1])).toStrictEqual(observed(pair.peer, inodes[0]));
          },
          ROW_TIMEOUT_MS,
        );
      });
    },
  );

  describe.each(BOTH_COMMANDS)('Given a staged stash and an unborn HEAD', (command) => {
    describe(`When ${command} runs in git and in tsgit on a twin`, () => {
      it(
        'Then both empty the index, refuse as unclean and keep the stash',
        async () => {
          // Arrange
          for (const dir of [pair.peer, pair.ours]) {
            seed(dir);
            stageFile('f', 'F\n')(dir);
          }
          gitStash(pair.peer, ['push', '-q']);
          await stashPush(createNodeContext({ workDir: pair.ours }), {});
          for (const dir of [pair.peer, pair.ours]) {
            gitIn(dir, 'symbolic-ref', 'HEAD', 'refs/heads/orphan');
            settleIndex(dir);
            touchedAt('keep')(dir);
          }
          const inodes = [indexInode(pair.peer), indexInode(pair.ours)] as const;

          // Act
          const gitRun = gitStash(pair.peer, COMMANDS[command].git);
          const outcome = await tsgitApply(pair.ours, { command });

          // Assert
          expect(gitRun.exitCode).toBe(1);
          expect(outcome.kind).toBe('STASH_APPLY_WOULD_OVERWRITE');
          const { localChanges, untracked } = outcome as UncleanOutcome;
          expect(untracked).toStrictEqual([]);
          expect(gitRun.stderr).toContain(uncleanBlock(localChanges));
          expect(runGit(['-C', pair.ours, 'ls-files'])).toBe('');
          expect(statusOf(pair.ours)).toBe(statusOf(pair.peer));
          expect(observed(pair.ours, inodes[1])).toStrictEqual(observed(pair.peer, inodes[0]));
        },
        ROW_TIMEOUT_MS,
      );
    });
  });
});
