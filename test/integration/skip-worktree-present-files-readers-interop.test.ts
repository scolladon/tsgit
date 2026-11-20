/**
 * Cross-tool interop — the readers that decide on a skip-worktree entry (`add`, `checkout`,
 * `stash`, `reset`, `sparse-checkout reapply`) see a present out-of-pattern file as git does in
 * the natural state: default config, the bit on disk, the file present. Run under both
 * `core.ignorecase` values.
 *
 * @proves
 *   surface:        index-read
 *   bucket:         cross-tool-interop
 *   unique:         every reader treats a present skip-worktree file as git does, through the shared index read
 *   interopSurface: add, checkout, stash, reset, sparse-checkout
 */
import { readFile, rm as removeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { add } from '../../src/application/commands/add.js';
import { checkout } from '../../src/application/commands/checkout.js';
import { reset } from '../../src/application/commands/reset.js';
import { sparseCheckoutReapply } from '../../src/application/commands/sparse-checkout.js';
import { stashApply, stashPush } from '../../src/application/commands/stash.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, tryRunGitWithExit } from './interop-helpers.js';
import {
  createTwinFactory,
  diskOf,
  gitIn,
  gitSeed,
  settle,
  type TwinFactory,
  tagsOf,
  writeFiles,
} from './skip-worktree-present-files-fixtures.js';

const NOT_UP_TO_DATE =
  'The following paths are not up to date and were left despite sparse patterns:';

type Outcome = { readonly value: unknown } | { readonly code: string; readonly data: unknown };

const outcomeOf = async (run: () => Promise<unknown>): Promise<Outcome> => {
  try {
    return { value: await run() };
  } catch (error) {
    const data = (error as { data?: { code?: string } }).data;
    if (data?.code === undefined) throw error;
    return { code: data.code, data };
  }
};

/** a/f stashed with the cone re-applied: a/f absent and skip-worktree, the stash changing a/f. */
const stashChangingAF = async (repo: string): Promise<void> => {
  gitSeed(repo, ['update-index', '--no-skip-worktree', 'a/f']);
  await writeFiles(repo, { 'a/f': 'st\n' });
  gitSeed(repo, ['stash']);
  gitSeed(repo, ['sparse-checkout', 'reapply']);
  await removeFile(path.join(repo, 'a/f'), { force: true });
  gitSeed(repo, ['update-index', '--skip-worktree', 'a/f']);
};

/** A stash changing only b/f, taken with a/f out of the way. */
const stashChangingBF = async (repo: string): Promise<void> => {
  await writeFiles(repo, { 'b/f': 'b2\n' });
  gitSeed(repo, ['stash']);
};

interface Row {
  readonly label: string;
  readonly seed?: (repo: string) => Promise<void>;
  readonly files: Readonly<Record<string, string>> | undefined;
  readonly settled: boolean;
  readonly git: ReadonlyArray<string>;
  readonly gitExit: number;
  readonly tsgit: (ctx: Context) => Promise<unknown>;
  readonly outcome?: (outcome: Outcome) => void;
}

const HI = { 'a/f': 'hi\n' };
const BASE = { 'a/f': 'base\n' };
const stateOf = (outcome: Outcome): unknown => ('value' in outcome ? undefined : outcome.code);

const ROWS: ReadonlyArray<Row> = [
  {
    label: 'add of the file by name',
    files: HI,
    settled: true,
    git: ['add', 'a/f'],
    gitExit: 1,
    tsgit: (ctx) => add(ctx, ['a/f']),
    outcome: (o) => expect(o).toMatchObject({ value: { sparse: ['a/f'] } }),
  },
  {
    label: 'add -A',
    files: HI,
    settled: true,
    git: ['add', '-A'],
    gitExit: 0,
    tsgit: (ctx) => add(ctx, [], { all: true }),
  },
  {
    label: 'a switch that would overwrite the file',
    files: HI,
    settled: true,
    git: ['checkout', 't2'],
    gitExit: 1,
    tsgit: (ctx) => checkout(ctx, { rev: 't2' }),
    outcome: (o) =>
      expect(o).toMatchObject({
        code: 'CHECKOUT_OVERWRITE_DIRTY',
        data: { localChanges: ['a/f'] },
      }),
  },
  {
    label: 'a switch over a clean present file',
    files: BASE,
    settled: true,
    git: ['checkout', 't2'],
    gitExit: 0,
    tsgit: (ctx) => checkout(ctx, { rev: 't2' }),
  },
  {
    label: 'a switch with the file absent',
    files: undefined,
    settled: true,
    git: ['checkout', 't2'],
    gitExit: 0,
    tsgit: (ctx) => checkout(ctx, { rev: 't2' }),
  },
  {
    label: 'a forced switch',
    files: HI,
    settled: true,
    git: ['checkout', '-f', 't2'],
    gitExit: 0,
    tsgit: (ctx) => checkout(ctx, { rev: 't2', force: true }),
  },
  {
    label: 'a path checkout of the file',
    files: HI,
    settled: true,
    git: ['checkout', '--', 'a/f'],
    gitExit: 0,
    tsgit: (ctx) => checkout(ctx, { paths: ['a/f'] }),
  },
  {
    label: 'a branch creation on the same commit',
    files: HI,
    settled: true,
    git: ['checkout', '-b', 'other'],
    gitExit: 0,
    tsgit: (ctx) => checkout(ctx, { createBranch: { name: 'other' } }),
  },
  {
    label: 'a stash apply changing the file with the file edited',
    seed: stashChangingAF,
    files: { 'a/f': 'junk\n' },
    settled: false,
    git: ['stash', 'apply'],
    gitExit: 128,
    tsgit: (ctx) => stashApply(ctx, {}),
    outcome: (o) => expect(stateOf(o)).toBe('STASH_APPLY_WOULD_OVERWRITE'),
  },
  {
    label: 'a stash apply changing the file with the file at the base blob',
    seed: stashChangingAF,
    files: BASE,
    settled: false,
    git: ['stash', 'apply'],
    gitExit: 0,
    tsgit: (ctx) => stashApply(ctx, {}),
  },
  {
    label: 'a stash apply changing the file with the file absent',
    seed: stashChangingAF,
    files: undefined,
    settled: false,
    git: ['stash', 'apply'],
    gitExit: 0,
    tsgit: (ctx) => stashApply(ctx, {}),
  },
  {
    label: 'a stash apply changing another file',
    seed: stashChangingBF,
    files: HI,
    settled: false,
    git: ['stash', 'apply'],
    gitExit: 0,
    tsgit: (ctx) => stashApply(ctx, {}),
  },
  {
    label: 'a stash push with the file edited',
    files: HI,
    settled: false,
    git: ['stash', 'push'],
    gitExit: 0,
    tsgit: (ctx) => stashPush(ctx, {}),
  },
  {
    label: 'a stash push changing another file with the file clean',
    files: { ...BASE, 'b/f': 'b2\n' },
    settled: false,
    git: ['stash', 'push'],
    gitExit: 0,
    tsgit: (ctx) => stashPush(ctx, {}),
  },
  {
    label: 'a hard reset',
    files: HI,
    settled: false,
    git: ['reset', '-q', '--hard', 'HEAD'],
    gitExit: 0,
    tsgit: (ctx) => reset(ctx, { mode: 'hard', rev: 'HEAD' }),
  },
  {
    label: 'a mixed reset',
    files: HI,
    settled: false,
    git: ['reset', '-q', '--mixed', 'HEAD'],
    gitExit: 0,
    tsgit: (ctx) => reset(ctx, { mode: 'mixed', rev: 'HEAD' }),
  },
  {
    label: 'a sparse-checkout reapply',
    files: HI,
    settled: false,
    git: ['sparse-checkout', 'reapply'],
    gitExit: 0,
    tsgit: (ctx) => sparseCheckoutReapply(ctx),
    outcome: (o) => expect(o).toMatchObject({ value: { retained: ['a/f'] } }),
  },
];

const snapshotOf = async (repo: string) => ({ tags: tagsOf(repo), disk: await diskOf(repo) });

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'readers over present skip-worktree files in the natural state',
  () => {
    let factory: TwinFactory;
    beforeAll(async () => {
      factory = await createTwinFactory('tsgit-sw-readers-');
    });
    afterAll(async () => {
      await factory.dispose();
    });

    describe.each(['false', 'true'])('with core.ignorecase=%s in both twins', (ignorecase) => {
      describe.each(ROWS)(
        'Given $label',
        ({ seed, files, settled, git, gitExit, tsgit, outcome }) => {
          describe('When git and tsgit run it', () => {
            it('Then tsgit leaves the index and the work tree git leaves', async () => {
              // Arrange
              const { gitRepo, tsgitRepo } = await factory.make({ ignorecase }, seed);
              for (const repo of [gitRepo, tsgitRepo]) {
                if (files !== undefined) await writeFiles(repo, files);
              }
              if (settled) await Promise.all([settle(gitRepo), settle(tsgitRepo)]);

              // Act
              const gitRun = tryRunGitWithExit(['-C', gitRepo, ...git]);
              const result = await outcomeOf(() =>
                tsgit(createNodeContext({ workDir: tsgitRepo })),
              );

              // Assert
              expect(gitRun.exitCode).toBe(gitExit);
              outcome?.(result);
              expect(await snapshotOf(tsgitRepo)).toEqual(await snapshotOf(gitRepo));
            });
          });
        },
      );

      describe('Given a stash changing another file and a present skip-worktree file', () => {
        describe('When git and tsgit apply it', () => {
          it('Then both warn about the file left despite the sparse patterns', async () => {
            // Arrange
            const { gitRepo, tsgitRepo } = await factory.make({ ignorecase }, stashChangingBF);
            await writeFiles(gitRepo, HI);
            await writeFiles(tsgitRepo, HI);
            const warnings: string[] = [];
            const ctx: Context = {
              ...createNodeContext({ workDir: tsgitRepo }),
              logger: { warn: (message) => warnings.push(message) },
            };

            // Act
            const gitRun = tryRunGitWithExit(['-C', gitRepo, 'stash', 'apply']);
            await stashApply(ctx, {});

            // Assert
            expect(gitRun.stderr).toContain(NOT_UP_TO_DATE);
            expect(warnings.join('\n')).toContain(NOT_UP_TO_DATE);
            expect(await readFile(path.join(tsgitRepo, 'a/f'), 'utf8')).toBe('hi\n');
          });
        });
      });

      describe('Given a present skip-worktree file and a branch creation', () => {
        describe('When tsgit runs it from a settled index', () => {
          it('Then the index file is not rewritten', async () => {
            // Arrange
            const { tsgitRepo } = await factory.make({ ignorecase });
            await writeFiles(tsgitRepo, HI);
            await settle(tsgitRepo);
            const before = await readFile(path.join(tsgitRepo, '.git', 'index'));
            const ctx = createNodeContext({ workDir: tsgitRepo });

            // Act
            await checkout(ctx, { createBranch: { name: 'other' } });

            // Assert
            expect(await readFile(path.join(tsgitRepo, '.git', 'index'))).toEqual(before);
            expect(gitIn(tsgitRepo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('other');
          });
        });
      });
    });
  },
);
