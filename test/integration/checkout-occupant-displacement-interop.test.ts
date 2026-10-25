/**
 * Cross-tool interop — what a checkout does with an untracked occupant standing
 * where the target tree adds an entry. The same history is built with git
 * plumbing in a canonical-git peer and in a tsgit repo, the occupant is planted
 * in both work trees, git runs the command in its peer and tsgit in the other,
 * and the work-tree listing, the index and the outcome are compared.
 *
 * @proves
 *   surface:        repo.checkout
 *   bucket:         cross-tool-interop
 *   unique:         checkout occupant classification runs against git
 *   interopSurface: checkout
 */
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TsgitError } from '../../src/domain/error.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  initBothRepos,
  makePeerPair,
  type PeerPair,
  runGit,
} from './interop-helpers.js';
import {
  buildHistory,
  copiedBehindLink,
  danglingLinkAt,
  directoryHolding,
  emptyDirectoryAt,
  fileAt,
  gitlink,
  ignoring,
  indexState,
  link1,
  linkToContent,
  linkToFile,
  listing,
  movedBehindLink,
  type Occupant,
  OK,
  type Outcome,
  outcomeOfGitStderr,
  refusedLocal,
  refusedUntracked,
  regular,
  replacing,
  symlink,
  type TreeEntry,
  v1,
} from './occupant-displacement-fixtures.js';

type Variant = 'pool' | 'one' | 'in-core';

const VARIANT_CONFIG: Readonly<Record<Variant, ReadonlyArray<readonly [string, string]>>> = {
  pool: [],
  one: [['filter.probe.process', 'true']],
  'in-core': [['core.autocrlf', 'true']],
};

const VARIANTS: ReadonlyArray<Variant> = ['pool', 'one', 'in-core'];

const runGitCheckout = (dir: string, args: ReadonlyArray<string>): Outcome => {
  try {
    runGit(['-C', dir, ...args]);
    return OK;
  } catch (err) {
    const { status, stderr } = err as { status: number | null; stderr: Buffer };
    if (status !== 1) throw err;
    return outcomeOfGitStderr(stderr.toString());
  }
};

const outcomeOfTsgitError = (err: unknown): Outcome => {
  if (!(err instanceof TsgitError)) throw err;
  const data = err.data;
  if (data.code !== 'CHECKOUT_OVERWRITE_DIRTY') {
    return { refused: true, crash: data.code, localChanges: [], untracked: [] };
  }
  return { refused: true, localChanges: data.localChanges, untracked: data.untracked };
};

const runTsgitCheckout = async (repo: Repository): Promise<Outcome> => {
  try {
    await repo.checkout({ rev: 't' });
    return OK;
  } catch (err) {
    return outcomeOfTsgitError(err);
  }
};

interface AddRow {
  readonly shape: string;
  readonly due: ReadonlyArray<TreeEntry>;
  readonly occupant: Occupant;
  readonly git: Outcome;
}

const ADD_ROWS: ReadonlyArray<AddRow> = [
  { shape: 'S1', due: [regular('d/x')], occupant: fileAt('d'), git: refusedUntracked('d') },
  {
    shape: 'S2',
    due: [regular('f')],
    occupant: directoryHolding('f', 'u'),
    git: refusedUntracked('f'),
  },
  {
    shape: 'S3a',
    due: [regular('d/x')],
    occupant: danglingLinkAt('d'),
    git: refusedUntracked('d'),
  },
  { shape: 'S3b', due: [regular('f')], occupant: danglingLinkAt('f'), git: refusedUntracked('f') },
  {
    shape: 'S3c',
    due: [symlink('l')],
    occupant: directoryHolding('l', 'u'),
    git: refusedUntracked('l'),
  },
  { shape: 'S3d', due: [symlink('d/l')], occupant: fileAt('d'), git: refusedUntracked('d') },
  {
    shape: 'S3e',
    due: [symlink('d/l')],
    occupant: danglingLinkAt('d'),
    git: refusedUntracked('d'),
  },
  { shape: 'S3f', due: [symlink('f')], occupant: fileAt('f'), git: refusedUntracked('f') },
  {
    shape: 'I2',
    due: [regular('f')],
    occupant: ignoring('f/u', directoryHolding('f', 'u')),
    git: OK,
  },
  { shape: 'I3', due: [regular('d/x')], occupant: ignoring('d', danglingLinkAt('d')), git: OK },
  {
    shape: 'I5',
    due: [symlink('l')],
    occupant: ignoring('l/u', directoryHolding('l', 'u')),
    git: OK,
  },
  { shape: 'I6', due: [regular('f')], occupant: ignoring('f', fileAt('f')), git: OK },
  { shape: 'I7', due: [regular('f')], occupant: ignoring('f', danglingLinkAt('f')), git: OK },
  { shape: 'I1', due: [regular('d/x')], occupant: ignoring('d', fileAt('d')), git: OK },
  { shape: 'I4', due: [symlink('d/l')], occupant: ignoring('d', fileAt('d')), git: OK },
  { shape: 'X4', due: [gitlink('d/s')], occupant: fileAt('d'), git: refusedUntracked('d') },
  {
    shape: 'Y1',
    due: [regular('d/x'), regular('d/y')],
    occupant: fileAt('d'),
    git: refusedUntracked('d', 'd'),
  },
];

interface ChangeRow {
  readonly shape: string;
  readonly tracked: ReadonlyArray<TreeEntry>;
  readonly due: ReadonlyArray<TreeEntry>;
  readonly occupant: Occupant;
  readonly git: Outcome;
}

const UPDATE_ROWS: ReadonlyArray<ChangeRow> = [
  {
    shape: 'S1',
    tracked: [v1('d/x')],
    due: [regular('d/x')],
    occupant: replacing('d/x', fileAt('d')),
    git: refusedLocal('d/x'),
  },
  {
    shape: 'S2',
    tracked: [v1('f')],
    due: [regular('f')],
    occupant: replacing('f', directoryHolding('f', 'u')),
    git: refusedLocal('f'),
  },
  {
    shape: 'S3a',
    tracked: [v1('d/x')],
    due: [regular('d/x')],
    occupant: replacing('d/x', danglingLinkAt('d')),
    git: OK,
  },
  {
    shape: 'S3g',
    tracked: [v1('d/x')],
    due: [regular('d/x')],
    occupant: replacing('d/x', linkToContent('d', 'held', 'x')),
    git: refusedLocal('d/x'),
  },
  {
    shape: 'S3h',
    tracked: [v1('d/x')],
    due: [regular('d/x')],
    occupant: linkToFile('d', 'held'),
    git: refusedLocal('d/x'),
  },
  {
    shape: 'S3i',
    tracked: [v1('d/x')],
    due: [regular('d/x')],
    occupant: movedBehindLink('d', 'held'),
    git: OK,
  },
  {
    shape: 'S3j',
    tracked: [v1('d/x')],
    due: [regular('d/x')],
    occupant: copiedBehindLink('d', 'held'),
    git: refusedLocal('d/x'),
  },
  {
    shape: 'S3b',
    tracked: [v1('f')],
    due: [regular('f')],
    occupant: replacing('f', danglingLinkAt('f')),
    git: refusedLocal('f'),
  },
  {
    shape: 'S3c',
    tracked: [link1('l')],
    due: [symlink('l')],
    occupant: replacing('l', directoryHolding('l', 'u')),
    git: refusedLocal('l'),
  },
  {
    shape: 'S3d',
    tracked: [link1('d/l')],
    due: [symlink('d/l')],
    occupant: replacing('d/l', fileAt('d')),
    git: refusedLocal('d/l'),
  },
  {
    shape: 'S3e',
    tracked: [link1('d/l')],
    due: [symlink('d/l')],
    occupant: replacing('d/l', danglingLinkAt('d')),
    git: OK,
  },
  {
    shape: 'S3f',
    tracked: [link1('f')],
    due: [symlink('f')],
    occupant: replacing('f', fileAt('f')),
    git: refusedLocal('f'),
  },
  {
    shape: 'I1',
    tracked: [v1('d/x')],
    due: [regular('d/x')],
    occupant: replacing('d/x', ignoring('d', fileAt('d'))),
    git: refusedLocal('d/x'),
  },
  {
    shape: 'I2',
    tracked: [v1('f')],
    due: [regular('f')],
    occupant: replacing('f', ignoring('f/u', directoryHolding('f', 'u'))),
    git: refusedLocal('f'),
  },
  {
    shape: 'I3',
    tracked: [v1('d/x')],
    due: [regular('d/x')],
    occupant: replacing('d/x', ignoring('d', danglingLinkAt('d'))),
    git: OK,
  },
  {
    shape: 'I4',
    tracked: [link1('d/l')],
    due: [symlink('d/l')],
    occupant: replacing('d/l', ignoring('d', fileAt('d'))),
    git: refusedLocal('d/l'),
  },
  {
    shape: 'I5',
    tracked: [link1('l')],
    due: [symlink('l')],
    occupant: replacing('l', ignoring('l/u', directoryHolding('l', 'u'))),
    git: refusedLocal('l'),
  },
  {
    shape: 'X3',
    tracked: [v1('f')],
    due: [regular('f')],
    occupant: replacing('f', emptyDirectoryAt('f')),
    git: refusedLocal('f'),
  },
];

const DELETE_ROWS: ReadonlyArray<ChangeRow> = [
  {
    shape: 'D1',
    tracked: [v1('d/x')],
    due: [],
    occupant: replacing('d/x', fileAt('d')),
    git: refusedLocal('d/x'),
  },
  {
    shape: 'D5',
    tracked: [v1('d/x')],
    due: [],
    occupant: replacing('d/x', linkToContent('d', 'held', 'x')),
    git: refusedLocal('d/x'),
  },
  {
    shape: 'D6',
    tracked: [v1('d/x')],
    due: [],
    occupant: linkToFile('d', 'held'),
    git: refusedLocal('d/x'),
  },
  {
    shape: 'D7',
    tracked: [v1('d/x')],
    due: [],
    occupant: movedBehindLink('d', 'held'),
    git: OK,
  },
  {
    shape: 'D8',
    tracked: [v1('d/x')],
    due: [],
    occupant: copiedBehindLink('d', 'held'),
    git: refusedLocal('d/x'),
  },
  {
    shape: 'D2',
    tracked: [v1('f')],
    due: [],
    occupant: replacing('f', directoryHolding('f', 'u')),
    git: refusedUntracked('f'),
  },
  {
    shape: 'D3',
    tracked: [link1('l')],
    due: [],
    occupant: replacing('l', directoryHolding('l', 'u')),
    git: refusedUntracked('l'),
  },
  {
    shape: 'D4',
    tracked: [link1('d/l')],
    due: [],
    occupant: replacing('d/l', fileAt('d')),
    git: refusedLocal('d/l'),
  },
  {
    shape: 'X1',
    tracked: [v1('f')],
    due: [],
    occupant: replacing('f', emptyDirectoryAt('f')),
    git: refusedLocal('f'),
  },
  {
    shape: 'X2',
    tracked: [v1('f')],
    due: [],
    occupant: replacing('f', ignoring('f/u', directoryHolding('f', 'u'))),
    git: refusedLocal('f'),
  },
];

interface ForcedWriteRow {
  readonly id: string;
  readonly tracked: ReadonlyArray<TreeEntry>;
  readonly due: ReadonlyArray<TreeEntry>;
  readonly occupant: Occupant;
  readonly path: string;
  readonly rewrites: 'target' | 'head';
}

const FORCED_WRITE_ROWS: ReadonlyArray<ForcedWriteRow> = [
  {
    id: 'S1/add',
    tracked: [],
    due: [regular('d/x')],
    occupant: fileAt('d'),
    path: 'd/x',
    rewrites: 'target',
  },
  {
    id: 'S1/update',
    tracked: [v1('d/x')],
    due: [regular('d/x')],
    occupant: replacing('d/x', fileAt('d')),
    path: 'd/x',
    rewrites: 'target',
  },
  {
    id: 'S1/same',
    tracked: [v1('d/x')],
    due: [v1('d/x')],
    occupant: replacing('d/x', fileAt('d')),
    path: 'd/x',
    rewrites: 'head',
  },
  {
    id: 'S3d/add',
    tracked: [],
    due: [symlink('d/l')],
    occupant: fileAt('d'),
    path: 'd/l',
    rewrites: 'target',
  },
  {
    id: 'S3d/update',
    tracked: [link1('d/l')],
    due: [symlink('d/l')],
    occupant: replacing('d/l', fileAt('d')),
    path: 'd/l',
    rewrites: 'target',
  },
  {
    id: 'S3d/same',
    tracked: [link1('d/l')],
    due: [link1('d/l')],
    occupant: replacing('d/l', fileAt('d')),
    path: 'd/l',
    rewrites: 'head',
  },
  {
    id: 'X4/add',
    tracked: [],
    due: [gitlink('d/s')],
    occupant: fileAt('d'),
    path: 'd/s',
    rewrites: 'target',
  },
  {
    id: 'S2/add',
    tracked: [],
    due: [regular('f')],
    occupant: directoryHolding('f', 'u'),
    path: 'f',
    rewrites: 'target',
  },
  {
    id: 'S2/update',
    tracked: [v1('f')],
    due: [regular('f')],
    occupant: replacing('f', directoryHolding('f', 'u')),
    path: 'f',
    rewrites: 'target',
  },
  {
    id: 'S2/same',
    tracked: [v1('f')],
    due: [v1('f')],
    occupant: replacing('f', directoryHolding('f', 'u')),
    path: 'f',
    rewrites: 'head',
  },
  {
    id: 'S3a/add',
    tracked: [],
    due: [regular('d/x')],
    occupant: danglingLinkAt('d'),
    path: 'd/x',
    rewrites: 'target',
  },
  {
    id: 'S3a/update',
    tracked: [v1('d/x')],
    due: [regular('d/x')],
    occupant: replacing('d/x', danglingLinkAt('d')),
    path: 'd/x',
    rewrites: 'target',
  },
  {
    id: 'S3a/same',
    tracked: [v1('d/x')],
    due: [v1('d/x')],
    occupant: replacing('d/x', danglingLinkAt('d')),
    path: 'd/x',
    rewrites: 'head',
  },
  {
    id: 'S3b/add',
    tracked: [],
    due: [regular('f')],
    occupant: danglingLinkAt('f'),
    path: 'f',
    rewrites: 'target',
  },
  {
    id: 'S3b/update',
    tracked: [v1('f')],
    due: [regular('f')],
    occupant: replacing('f', danglingLinkAt('f')),
    path: 'f',
    rewrites: 'target',
  },
  {
    id: 'S3b/same',
    tracked: [v1('f')],
    due: [v1('f')],
    occupant: replacing('f', danglingLinkAt('f')),
    path: 'f',
    rewrites: 'head',
  },
  {
    id: 'S3c/add',
    tracked: [],
    due: [symlink('l')],
    occupant: directoryHolding('l', 'u'),
    path: 'l',
    rewrites: 'target',
  },
  {
    id: 'S3c/update',
    tracked: [link1('l')],
    due: [symlink('l')],
    occupant: replacing('l', directoryHolding('l', 'u')),
    path: 'l',
    rewrites: 'target',
  },
  {
    id: 'S3c/same',
    tracked: [link1('l')],
    due: [link1('l')],
    occupant: replacing('l', directoryHolding('l', 'u')),
    path: 'l',
    rewrites: 'head',
  },
  {
    id: 'S3e/add',
    tracked: [],
    due: [symlink('d/l')],
    occupant: danglingLinkAt('d'),
    path: 'd/l',
    rewrites: 'target',
  },
  {
    id: 'S3e/update',
    tracked: [link1('d/l')],
    due: [symlink('d/l')],
    occupant: replacing('d/l', danglingLinkAt('d')),
    path: 'd/l',
    rewrites: 'target',
  },
  {
    id: 'S3e/same',
    tracked: [link1('d/l')],
    due: [link1('d/l')],
    occupant: replacing('d/l', danglingLinkAt('d')),
    path: 'd/l',
    rewrites: 'head',
  },
  {
    id: 'S3f/add',
    tracked: [],
    due: [symlink('f')],
    occupant: fileAt('f'),
    path: 'f',
    rewrites: 'target',
  },
  {
    id: 'S3f/update',
    tracked: [link1('f')],
    due: [symlink('f')],
    occupant: replacing('f', fileAt('f')),
    path: 'f',
    rewrites: 'target',
  },
  {
    id: 'S3f/same',
    tracked: [link1('f')],
    due: [link1('f')],
    occupant: replacing('f', fileAt('f')),
    path: 'f',
    rewrites: 'head',
  },
  {
    id: 'X3/update',
    tracked: [v1('f')],
    due: [regular('f')],
    occupant: replacing('f', emptyDirectoryAt('f')),
    path: 'f',
    rewrites: 'target',
  },
];

interface ForcedWriteCommand {
  readonly label: string;
  readonly rewrites: ForcedWriteRow['rewrites'];
  readonly git: (rowPath: string) => ReadonlyArray<string>;
  readonly tsgit: (repo: Repository, rowPath: string) => Promise<unknown>;
}

const FORCED_WRITE_COMMANDS: ReadonlyArray<ForcedWriteCommand> = [
  {
    label: 'checkout -f t',
    rewrites: 'target',
    git: () => ['checkout', '-q', '-f', 't'],
    tsgit: (r) => r.checkout({ rev: 't', force: true }),
  },
  {
    label: 'reset --hard t',
    rewrites: 'target',
    git: () => ['reset', '-q', '--hard', 't'],
    tsgit: (r) => r.reset({ mode: 'hard', rev: 't' }),
  },
  {
    label: 'checkout t -- path',
    rewrites: 'target',
    git: (p) => ['checkout', '-q', 't', '--', p],
    tsgit: (r, p) => r.checkout({ source: 't', paths: [p] }),
  },
  {
    label: 'reset --hard HEAD',
    rewrites: 'head',
    git: () => ['reset', '-q', '--hard', 'HEAD'],
    tsgit: (r) => r.reset({ mode: 'hard', rev: 'HEAD' }),
  },
  {
    label: 'checkout -- path',
    rewrites: 'head',
    git: (p) => ['checkout', '-q', '--', p],
    tsgit: (r, p) => r.checkout({ paths: [p] }),
  },
  {
    label: 'checkout HEAD -- path',
    rewrites: 'head',
    git: (p) => ['checkout', '-q', 'HEAD', '--', p],
    tsgit: (r, p) => r.checkout({ source: 'HEAD', paths: [p] }),
  },
];

describe.skipIf(!GIT_AVAILABLE)(
  'checkout interop — occupant where the target adds an entry',
  { timeout: 60_000 },
  () => {
    let pair: PeerPair;
    let repo: Repository | undefined;

    beforeEach(async () => {
      pair = await makePeerPair('checkout-occupant-displacement');
      initBothRepos(pair.peer, pair.ours);
      repo = undefined;
    });

    afterEach(async () => {
      await repo?.dispose();
      await pair.dispose();
    });

    const VARIANT_ROWS = [
      ['add', ADD_ROWS.map((row) => ({ ...row, tracked: [] as ReadonlyArray<TreeEntry> }))],
      ['update', UPDATE_ROWS],
      ['delete', DELETE_ROWS],
    ] as const;

    interface ForcedCommand {
      readonly label: string;
      readonly git: ReadonlyArray<string>;
      readonly tsgit: (repo: Repository) => Promise<unknown>;
    }

    const FORCED_COMMANDS: ReadonlyArray<ForcedCommand> = [
      {
        label: 'checkout -f t',
        git: ['checkout', '-q', '-f', 't'],
        tsgit: (r) => r.checkout({ rev: 't', force: true }),
      },
      {
        label: 'reset --hard t',
        git: ['reset', '-q', '--hard', 't'],
        tsgit: (r) => r.reset({ mode: 'hard', rev: 't' }),
      },
      {
        label: 'checkout t -- keep',
        git: ['checkout', '-q', 't', '--', 'keep'],
        tsgit: (r) => r.checkout({ source: 't', paths: ['keep'] }),
      },
    ];

    describe.each(FORCED_COMMANDS)('Given the forced command $label', (command) => {
      describe.each(DELETE_ROWS)('and the $shape delete occupant', (row) => {
        describe('When both tools run it', () => {
          it('Then the outcome, work tree and index match git', async () => {
            // Arrange
            for (const dir of [pair.peer, pair.ours]) {
              buildHistory(dir, row.due, row.tracked);
              row.occupant(dir);
              writeFileSync(path.join(dir, 'other'), 'o\n');
            }
            repo = await openRepository({ cwd: pair.ours });

            // Act
            const expected = runGitCheckout(pair.peer, command.git);
            await command.tsgit(repo);

            // Assert
            expect(expected).toEqual(OK);
            expect(listing(pair.ours)).toEqual(listing(pair.peer));
            expect(indexState(pair.ours)).toEqual(indexState(pair.peer));
          });
        });
      });
    });

    describe.each(FORCED_WRITE_ROWS)('Given the forced write row $id', (row) => {
      describe.each(FORCED_WRITE_COMMANDS.filter((c) => c.rewrites === row.rewrites))(
        'and the command $label',
        (command) => {
          describe('When both tools run it', () => {
            it('Then the work tree and index match git', async () => {
              // Arrange
              for (const dir of [pair.peer, pair.ours]) {
                buildHistory(dir, row.due, row.tracked);
                row.occupant(dir);
              }
              repo = await openRepository({ cwd: pair.ours });

              // Act
              const expected = runGitCheckout(pair.peer, command.git(row.path));
              await command.tsgit(repo, row.path);

              // Assert
              expect(expected).toEqual(OK);
              expect(listing(pair.ours)).toEqual(listing(pair.peer));
              expect(indexState(pair.ours)).toEqual(indexState(pair.peer));
            });
          });
        },
      );
    });

    describe.each(VARIANTS)('Given the %s write path', (variant) => {
      describe.each(VARIANT_ROWS)('and the %s variant', (_label, rows) => {
        describe.each(rows)('and the $shape occupant', (row) => {
          describe('When both tools run checkout t', () => {
            it('Then the outcome, work tree and index match git', async () => {
              // Arrange
              for (const dir of [pair.peer, pair.ours]) {
                for (const [key, value] of VARIANT_CONFIG[variant]) {
                  runGit(['-C', dir, 'config', key, value]);
                }
                buildHistory(dir, row.due, row.tracked);
                row.occupant(dir);
              }
              repo = await openRepository({ cwd: pair.ours });

              // Act
              const expected = runGitCheckout(pair.peer, ['checkout', '-q', 't']);
              const result = await runTsgitCheckout(repo);

              // Assert
              expect(expected).toEqual(row.git);
              expect(result).toEqual(expected);
              expect(listing(pair.ours)).toEqual(listing(pair.peer));
              expect(indexState(pair.ours)).toEqual(indexState(pair.peer));
            });
          });
        });
      });
    });
  },
);
