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
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
const INDEX_ERROR_LINE = /^error: (.+): (?:patch does not apply|already exists in index)$/;

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
  readonly git: 'refuses' | 'applies';
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
  ...rowsOf(['H2'], ['plain'], ['apply'], 'applies'),
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
  | { readonly kind: 'STASH_INDEX_CONFLICT'; readonly paths: ReadonlyArray<string> };

const tsgitApply = async (dir: string, row: Row): Promise<Outcome> => {
  const command = COMMANDS[row.command];
  const sut = command.pops ? stashPop : stashApply;
  try {
    const result = await sut(createNodeContext({ workDir: dir }), {
      restoreIndex: command.restoreIndex,
    });
    return { kind: result.kind };
  } catch (error) {
    const { data } = error as TsgitError;
    if (data.code !== 'STASH_INDEX_CONFLICT') throw error;
    return { kind: data.code, paths: data.paths };
  }
};

const conflictedPathsOfGit = (stderr: string): string[] =>
  stderr
    .split('\n')
    .map((line) => INDEX_ERROR_LINE.exec(line)?.[1])
    .filter((p): p is string => p !== undefined);

const lastLine = (stderr: string): string => stderr.trimEnd().split('\n').at(-1) ?? '';

const statusOf = (dir: string): string => runGit(['-C', dir, 'status', '--porcelain', '-uall']);

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
});
