/**
 * Cross-tool interop — stash apply and pop over directory, file and symlink swaps. Real git pushes
 * and applies in a peer repository, tsgit does the same in its twin, and the work tree, index,
 * refs and state files are compared; git's exit and `AUTO_MERGE` are pinned per row.
 *
 * @proves
 *   surface:        repo.stash.apply
 *   bucket:         cross-tool-interop
 *   unique:         stash apply and pop leave the work tree, index, refs and state files git leaves across type swaps
 *   interopSurface: stash
 */
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
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
  buildHistory,
  COMMIT_ENV,
  emptyDirectoryAt,
  fileAt,
  fileWith,
  flagListing,
  ignoring,
  indexState,
  linkAt,
  listing,
  type Occupant,
  regular,
  replacing,
  settleIndex,
  staleEntries,
  symlink,
  touchedAt,
} from './occupant-displacement-fixtures.js';

const ROW_TIMEOUT_MS = 60_000;
const BASE = [
  regular('d/x', 'x\n'),
  regular('n/s/y', 'y\n'),
  regular('f', 'f\n'),
  symlink('l', 'keep'),
];

const staged =
  (plant: Occupant): Occupant =>
  (dir) => {
    plant(dir);
    runGit(['-C', dir, 'add', '-A']);
  };

const PLANTS: Readonly<Record<string, Occupant>> = {
  DF: replacing('d/x', fileAt('d')),
  DFn: replacing('n/s/y', fileAt('n')),
  FD: replacing('f', fileAt('f/y')),
  DL: replacing('d/x', linkAt('d', 'keep')),
  LD: replacing('l', fileAt('l/y')),
  LF: replacing('l', fileAt('l')),
  FL: replacing('f', linkAt('f', 'keep')),
};

const SHAPES: Readonly<Record<string, Occupant>> = {
  ...PLANTS,
  ...Object.fromEntries(Object.entries(PLANTS).map(([name, plant]) => [`${name}a`, staged(plant)])),
};

const PUSHES = {
  plain: { git: [] as string[], opts: {} },
  '-u': { git: ['-u'], opts: { includeUntracked: true } },
  '--keep-index': { git: ['--keep-index'], opts: { keepIndex: true } },
};

const COMMANDS = {
  apply: { git: ['apply'], restoreIndex: false, pops: false },
  'apply --index': { git: ['apply', '--index'], restoreIndex: true, pops: false },
  pop: { git: ['pop'], restoreIndex: false, pops: true },
  'pop --index': { git: ['pop', '--index'], restoreIndex: true, pops: true },
} as const;

type ShapeName = keyof typeof SHAPES;
type PushName = keyof typeof PUSHES;
type CommandName = keyof typeof COMMANDS;

interface Row {
  readonly shape: ShapeName;
  readonly push: PushName;
  readonly after: string;
  readonly post: Occupant;
  readonly command: CommandName;
  readonly pushedBy: 'each' | 'git';
  readonly git: { readonly exit: number; readonly autoMerge: boolean };
  readonly refusal?: string;
  readonly pushRefusal?: string;
}

const NO_POST: Occupant = () => undefined;
const EVERY_COMMAND = Object.keys(COMMANDS) as CommandName[];
const ALL_PUSHES = Object.keys(PUSHES) as PushName[];
const WITHOUT_UNTRACKED: ReadonlyArray<PushName> = ['plain', '--keep-index'];

type Pin = Pick<Row, 'git'> &
  Partial<Omit<Row, 'shape' | 'push' | 'command'>> & {
    readonly commands?: ReadonlyArray<CommandName>;
  };

const expand = (
  shapes: ReadonlyArray<ShapeName>,
  pushes: ReadonlyArray<PushName>,
  { commands = EVERY_COMMAND, ...pin }: Pin,
): Row[] =>
  shapes.flatMap((shape) =>
    pushes.flatMap((push) =>
      commands.map((command) => ({
        after: 'a clean tree',
        post: NO_POST,
        pushedBy: 'each' as const,
        ...pin,
        shape,
        push,
        command,
      })),
    ),
  );

const STAGED_SHAPES: ReadonlyArray<ShapeName> = ['DFa', 'DFna', 'FDa', 'LDa', 'LFa', 'FLa'];
const MERGED = { git: { exit: 0, autoMerge: true } };
const UNCHANGED = { git: { exit: 0, autoMerge: false } };
const NO_STASH = {
  git: { exit: 1, autoMerge: false },
  refusal: 'STASH_NOT_FOUND',
  pushRefusal: 'PATHSPEC_BEYOND_SYMLINK',
};
const REMOVED_DIRECTORY_ENTRY: Occupant = (dir) => rmSync(path.join(dir, 'd', 'x'));
const POSTS: Readonly<Record<string, Occupant>> = {
  'an empty directory in the way': emptyDirectoryAt('d/e'),
  'an ignored file in the way': ignoring('d/u', fileWith('d/u', 'untracked\n')),
  'the tracked entry removed': REMOVED_DIRECTORY_ENTRY,
};

const ROWS: ReadonlyArray<Row> = [
  ...expand(['FD', 'LD'], WITHOUT_UNTRACKED, UNCHANGED),
  ...expand(['DF', 'DFn'], WITHOUT_UNTRACKED, MERGED),
  ...expand(['LF', 'FL'], ALL_PUSHES, MERGED),
  ...expand(STAGED_SHAPES, ALL_PUSHES, MERGED),
  ...expand(['DL', 'DLa'], ALL_PUSHES, NO_STASH),
  ...Object.entries(POSTS).flatMap(([after, post]) =>
    expand(['DFa'], ['plain'], {
      ...MERGED,
      after,
      post,
      pushedBy: 'git',
    }),
  ),
];

const title = (row: Row): string => `${row.shape} pushed by ${row.push} onto ${row.after}`;

const seed = (dir: string): void => {
  runGit(['init', '-q', '-b', 'main', dir]);
  runGit(['-C', dir, 'config', 'user.name', 'Ada']);
  runGit(['-C', dir, 'config', 'user.email', 'ada@example.com']);
  buildHistory(dir, BASE, BASE);
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

const tsgitPush = async (dir: string, row: Row): Promise<string | undefined> => {
  const sut = stashPush;
  try {
    await sut(createNodeContext({ workDir: dir }), PUSHES[row.push].opts);
    return undefined;
  } catch (error) {
    return (error as TsgitError).data.code;
  }
};

const pushBoth = async (pair: PeerPair, row: Row): Promise<string | undefined> => {
  const gitArgs = ['push', '-q', ...PUSHES[row.push].git];
  gitStash(pair.peer, gitArgs);
  if (row.pushedBy === 'git') {
    gitStash(pair.ours, gitArgs);
    return undefined;
  }
  return tsgitPush(pair.ours, row);
};

const settle = (dir: string, row: Row): void => {
  settleIndex(dir);
  row.post(dir);
  touchedAt('keep')(dir);
};

const indexInode = (dir: string): number => statSync(path.join(dir, '.git', 'index')).ino;

const tsgitApply = async (dir: string, row: Row): Promise<string> => {
  const command = COMMANDS[row.command];
  const sut = command.pops ? stashPop : stashApply;
  try {
    const result = await sut(createNodeContext({ workDir: dir }), {
      restoreIndex: command.restoreIndex,
    });
    return result.kind;
  } catch (error) {
    return (error as TsgitError).data.code;
  }
};

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

describe.skipIf(!GIT_AVAILABLE)('stash apply over type swaps interop', () => {
  let pair: PeerPair;

  beforeEach(async () => {
    pair = await makePeerPair('stash-apply-type-change');
  });

  afterEach(async () => {
    await pair.dispose();
  });

  describe.each(ROWS.map((row) => [title(row), row] as const))('Given %s', (_name, row) => {
    describe(`When ${row.command} runs in git and in tsgit on a twin`, () => {
      it(
        'Then the work tree, index, refs and state files agree with git',
        async () => {
          // Arrange
          for (const dir of [pair.peer, pair.ours]) {
            seed(dir);
            SHAPES[row.shape]?.(dir);
          }
          const pushRefusal = await pushBoth(pair, row);
          for (const dir of [pair.peer, pair.ours]) settle(dir, row);
          const pushed = [pushedTrees(pair.peer), pushedTrees(pair.ours)] as const;
          const inodes = [indexInode(pair.peer), indexInode(pair.ours)] as const;

          // Act
          const gitRun = gitStash(pair.peer, COMMANDS[row.command].git);
          const outcome = await tsgitApply(pair.ours, row);

          // Assert
          expect(gitRun.exitCode).toBe(row.git.exit);
          expect(outcome).toBe(row.git.exit === 0 ? 'applied' : row.refusal);
          expect(pushRefusal).toBe(row.pushRefusal);
          expect(pushed[1]).toBe(pushed[0]);
          expect(observed(pair.ours, inodes[1])).toEqual(observed(pair.peer, inodes[0]));
          expect(existsSync(path.join(pair.ours, '.git', 'AUTO_MERGE'))).toBe(row.git.autoMerge);
        },
        ROW_TIMEOUT_MS,
      );
    });
  });
});
