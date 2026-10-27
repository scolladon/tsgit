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
  danglingLinkAt,
  emptyDirectoryAt,
  fileAt,
  fileWith,
  flagListing,
  ignoring,
  indexState,
  linkAt,
  listing,
  type Occupant,
  outcomeOfGitStderr,
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

const PLANTS = {
  DF: replacing('d/x', fileAt('d')),
  DFn: replacing('n/s/y', fileAt('n')),
  FD: replacing('f', fileAt('f/y')),
  DL: replacing('d/x', linkAt('d', 'keep')),
  LD: replacing('l', fileAt('l/y')),
  LF: replacing('l', fileAt('l')),
  FL: replacing('f', linkAt('f', 'keep')),
} satisfies Record<string, Occupant>;

const EDITED_F: Occupant = fileWith('f', 'f2\n');

const UNTRACKED_PLANTS = {
  FU: (dir) => {
    EDITED_F(dir);
    fileWith('u', 'u\n')(dir);
  },
  UP: (dir) => {
    EDITED_F(dir);
    for (const rel of ['a', 'm/z', 'u', 'z']) fileWith(rel, `${rel}\n`)(dir);
  },
} satisfies Record<string, Occupant>;

type PlantName = keyof typeof PLANTS;
type ShapeName = PlantName | keyof typeof UNTRACKED_PLANTS | `${PlantName}a`;

const SHAPES: Readonly<Record<ShapeName, Occupant>> = {
  ...PLANTS,
  ...UNTRACKED_PLANTS,
  ...(Object.fromEntries(
    Object.entries(PLANTS).map(([name, plant]) => [`${name}a`, staged(plant)]),
  ) as Record<`${PlantName}a`, Occupant>),
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

type PushName = keyof typeof PUSHES;
type CommandName = keyof typeof COMMANDS;

interface RestoreReport {
  readonly existing: ReadonlyArray<string>;
  readonly blockedAt?: string;
}

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
  readonly restore?: RestoreReport;
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
const RECREATED_U: Occupant = fileWith('u', 'other\n');
const bothPlanted: Occupant = (dir) => {
  fileAt('m')(dir);
  RECREATED_U(dir);
};
const REMOVED_DIRECTORY_ENTRY: Occupant = (dir) => rmSync(path.join(dir, 'd', 'x'));
const UNTRACKED_DU: Occupant = fileWith('d/u', 'untracked\n');
const REMOVED_ENTRY_POST: Readonly<Record<string, Occupant>> = {
  'the tracked entry removed': REMOVED_DIRECTORY_ENTRY,
};
const SHARED_POSTS: Readonly<Record<string, Occupant>> = {
  'an empty directory in the way': emptyDirectoryAt('d/e'),
  'an ignored file in the way': ignoring('d/u', UNTRACKED_DU),
};
const UNTRACKED_POSTS: Readonly<Record<string, Occupant>> = {
  'an untracked file in the way': UNTRACKED_DU,
  ...SHARED_POSTS,
};

const UNTRACKED_NOT_RESTORED = 'STASH_UNTRACKED_NOT_RESTORED';
const RESTORE_STOPPED = { git: { exit: 1, autoMerge: true }, refusal: UNTRACKED_NOT_RESTORED };
const blockedAt = (component: string) => ({
  ...RESTORE_STOPPED,
  restore: { existing: [], blockedAt: component },
});
const existing = (...paths: string[]) => ({ ...RESTORE_STOPPED, restore: { existing: paths } });

const RECREATED_U_POST: Readonly<Record<string, Occupant>> = { 'a recreated u': RECREATED_U };

const U_POSTS: Readonly<Record<string, Occupant>> = {
  ...RECREATED_U_POST,
  'an empty directory at u': emptyDirectoryAt('u'),
};

const M_POSTS: Readonly<Record<string, Occupant>> = {
  'a file at m': fileAt('m'),
  'a link at m to a file': linkAt('m', 'keep'),
  'a link at m to a directory': linkAt('m', 'd'),
  'a dangling link at m': danglingLinkAt('m'),
};

const WOULD_OVERWRITE = 'STASH_APPLY_WOULD_OVERWRITE';
const REFUSED = { git: { exit: 1, autoMerge: false }, refusal: WOULD_OVERWRITE };
const CONFLICTED = { git: { exit: 1, autoMerge: true }, refusal: 'conflict' };
const refusedWith = (...paths: string[]) => ({ ...REFUSED, restore: { existing: paths } });
const conflictedWith = (...paths: string[]) => ({ ...CONFLICTED, restore: { existing: paths } });

const committed =
  (plant: Occupant): Occupant =>
  (dir) => {
    plant(dir);
    runGit(['-C', dir, 'commit', '-q', '-a', '-m', 'c'], { env: COMMIT_ENV });
  };

const EDITED_AGAIN: Occupant = fileWith('f', 'f3\n');
const COMMITTED_DIFFERENTLY: Occupant = committed(fileWith('f', 'c\n'));
const both =
  (first: Occupant, second: Occupant): Occupant =>
  (dir) => {
    first(dir);
    second(dir);
  };
const DIRTY_DX: Occupant = fileWith('d/x', 'edited\n');

const afterPosts = (
  shape: ShapeName,
  push: PushName,
  posts: Readonly<Record<string, Occupant>>,
  pin: Pin,
): Row[] =>
  Object.entries(posts).flatMap(([after, post]) =>
    expand([shape], [push], { ...pin, after, post, pushedBy: 'git' }),
  );

const POSTS: Readonly<Record<string, Occupant>> = { ...SHARED_POSTS, ...REMOVED_ENTRY_POST };

const ROWS: ReadonlyArray<Row> = [
  ...expand(['FD', 'LD'], WITHOUT_UNTRACKED, UNCHANGED),
  ...expand(['DF', 'DFn'], WITHOUT_UNTRACKED, MERGED),
  ...expand(['LF', 'FL'], ALL_PUSHES, MERGED),
  ...expand(STAGED_SHAPES, ALL_PUSHES, MERGED),
  ...expand(['DL', 'DLa'], ALL_PUSHES, { ...NO_STASH, commands: ['apply'] }),
  ...afterPosts('DFa', 'plain', POSTS, MERGED),
  ...afterPosts('UP', '-u', M_POSTS, blockedAt('m')),
  ...afterPosts('UP', '-u', { 'a file at m and a recreated u': bothPlanted }, blockedAt('m')),
  ...expand(['FD'], ['-u'], {
    git: { exit: 1, autoMerge: false },
    refusal: UNTRACKED_NOT_RESTORED,
    restore: { existing: [], blockedAt: 'f' },
  }),
  ...expand(['LD'], ['-u'], {
    git: { exit: 1, autoMerge: false },
    refusal: UNTRACKED_NOT_RESTORED,
    restore: { existing: [], blockedAt: 'l' },
  }),
  ...expand(['DF', 'DFn'], ['-u'], MERGED),
  ...afterPosts('DF', '-u', REMOVED_ENTRY_POST, MERGED),
  ...afterPosts('FU', '-u', RECREATED_U_POST, existing('u')),
  ...afterPosts('UP', '-u', U_POSTS, existing('u')),
  ...afterPosts('DF', '-u', UNTRACKED_POSTS, existing('d')),
  ...afterPosts('DFa', 'plain', { 'a dirty d/x': DIRTY_DX }, REFUSED),
  ...afterPosts('DFa', 'plain', { 'an untracked d/u': UNTRACKED_DU }, REFUSED),
  ...afterPosts('FU', '-u', { 'an edited f': EDITED_AGAIN }, REFUSED),
  ...afterPosts('FU', '-u', { 'f committed differently': COMMITTED_DIFFERENTLY }, CONFLICTED),
  ...afterPosts(
    'FU',
    '-u',
    { 'an edited f and a recreated u': both(EDITED_AGAIN, RECREATED_U) },
    refusedWith('u'),
  ),
  ...afterPosts(
    'FU',
    '-u',
    { 'f committed differently and a recreated u': both(COMMITTED_DIFFERENTLY, RECREATED_U) },
    conflictedWith('u'),
  ),
  ...afterPosts('DF', '-u', { 'a dirty d/x': DIRTY_DX }, refusedWith('d')),
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

interface Outcome {
  readonly kind: string;
  readonly report?: RestoreReport;
  readonly classes?: Pick<ReturnType<typeof outcomeOfGitStderr>, 'localChanges' | 'untracked'>;
}

const restoreReportOf = (data: TsgitError['data']): RestoreReport | undefined => {
  if (data.code === UNTRACKED_NOT_RESTORED) {
    const { existing: paths, blockedAt: component } = data;
    return { existing: paths, ...(component === undefined ? {} : { blockedAt: component }) };
  }
  return data.code === WOULD_OVERWRITE ? data.untrackedNotRestored : undefined;
};

const refusalOutcome = (data: TsgitError['data']): Outcome => {
  const report = restoreReportOf(data);
  return {
    kind: data.code,
    ...(report === undefined ? {} : { report }),
    ...(data.code === WOULD_OVERWRITE
      ? { classes: { localChanges: data.localChanges, untracked: data.untracked } }
      : {}),
  };
};

const tsgitApply = async (dir: string, row: Row): Promise<Outcome> => {
  const command = COMMANDS[row.command];
  const sut = command.pops ? stashPop : stashApply;
  try {
    const result = await sut(createNodeContext({ workDir: dir }), {
      restoreIndex: command.restoreIndex,
    });
    if (result.kind === 'applied') return { kind: result.kind };
    return {
      kind: result.kind,
      ...(result.untrackedNotRestored === undefined ? {} : { report: result.untrackedNotRestored }),
    };
  } catch (error) {
    return refusalOutcome((error as TsgitError).data);
  }
};

/** git's stderr for a restore that stopped, rebuilt from the data tsgit returns. */
const restoreStderr = ({ existing: paths, blockedAt: component }: RestoreReport): string =>
  [
    ...paths.map((rel) => `${rel} already exists, no checkout`),
    ...(component === undefined
      ? []
      : [`fatal: cannot create directory at '${component}': File exists`]),
    'error: could not restore untracked files from stash',
  ]
    .map((line) => `${line}\n`)
    .join('');

const ALREADY_EXISTS = / already exists, no checkout$/;
const CANNOT_CREATE_DIRECTORY = 'fatal: cannot create directory';

/** Everything git printed from its first restore line on, so an extra or longer line fails. */
const restoreBlockOf = (gitStderr: string): string => {
  const lines = gitStderr.split('\n');
  const start = lines.findIndex(
    (line) => ALREADY_EXISTS.test(line) || line.startsWith(CANNOT_CREATE_DIRECTORY),
  );
  return start < 0 ? '' : lines.slice(start).join('\n');
};

const expectRestoreReport = (row: Row, gitStderr: string): void => {
  if (row.restore === undefined) return;
  expect(restoreBlockOf(gitStderr)).toBe(restoreStderr(row.restore));
};

const expectRefusalClasses = (row: Row, gitStderr: string, outcome: Outcome): void => {
  if (row.refusal !== WOULD_OVERWRITE) return;
  const { localChanges, untracked } = outcomeOfGitStderr(gitStderr);
  expect(outcome.classes).toEqual({ localChanges, untracked });
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
            SHAPES[row.shape](dir);
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
          expect(outcome.kind).toBe(row.git.exit === 0 ? 'applied' : row.refusal);
          expectRestoreReport(row, gitRun.stderr);
          expectRefusalClasses(row, gitRun.stderr, outcome);
          expect(outcome.report).toEqual(row.restore);
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
