/**
 * Cross-tool interop — the hard reset behind `rebase --abort` and `rebase --skip`. git never
 * overwrites an untracked occupant there (every offending path is listed, ignored files are
 * overwritten) and a refusal keeps HEAD, the todo and `rebase-merge/` put. Pins both tools
 * against real `git`.
 *
 * @proves
 *   surface:        repo.rebase.abort, repo.rebase.skip
 *   bucket:         cross-tool-interop
 *   unique:         rebase abort/skip refuse untracked occupants and keep the stop state as canonical git
 *   interopSurface: working-tree
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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
  tryRunGit,
  tryRunGitWithExit,
} from './interop-helpers.js';
import {
  COMMIT_ENV,
  commitOn,
  directoryHolding,
  fileAt,
  indexState,
  KEEP,
  listing,
  type Occupant,
  OK,
  type Outcome,
  outcomeOfGitStderr,
  regular,
  replacing,
  v1,
} from './occupant-displacement-fixtures.js';
import {
  ABORT_ROWS,
  type AbortRow,
  buildStoppedMerge,
  entriesOf,
  type Variant,
} from './stopped-state-fixtures.js';

type Action = 'abort' | 'skip';

const REFUSAL_STATUS = 128;

const readIfPresent = (file: string): string | undefined =>
  existsSync(file) ? readFileSync(file, 'utf8') : undefined;

const rebaseMerge = (dir: string, name?: string): string =>
  path.join(dir, '.git', 'rebase-merge', ...(name === undefined ? [] : [name]));

const rebaseState = (dir: string): ReadonlyArray<unknown> => [
  listing(dir),
  indexState(dir),
  tryRunGit(['-C', dir, 'rev-parse', 'HEAD']).stdout,
  tryRunGit(['-C', dir, 'symbolic-ref', '-q', 'HEAD']).stdout,
  existsSync(rebaseMerge(dir)) ? readdirSync(rebaseMerge(dir)).sort() : undefined,
  readIfPresent(rebaseMerge(dir, 'git-rebase-todo')),
  readIfPresent(rebaseMerge(dir, 'done')),
];

const gitOutcome = (action: Action, dir: string): Outcome => {
  const result = tryRunGitWithExit(['-C', dir, 'rebase', `--${action}`], { env: COMMIT_ENV });
  if (result.exitCode === 0) return OK;
  if (result.exitCode !== REFUSAL_STATUS) {
    throw new Error(`unexpected exit ${result.exitCode}: ${result.stderr}`);
  }
  return outcomeOfGitStderr(result.stderr);
};

const tsgitOutcome = async (action: Action, repo: Repository): Promise<Outcome> => {
  try {
    await repo.rebase[action]();
    return OK;
  } catch (err) {
    if (!(err instanceof TsgitError)) throw err;
    const data = err.data;
    if (data.code !== 'WORKING_TREE_DIRTY') {
      return { refused: true, crash: data.code, localChanges: [], untracked: [] };
    }
    return { refused: true, localChanges: data.localChanges, untracked: data.untracked };
  }
};

/** The picked commit rewrites what `onto` holds, so `skip` resets the index to `onto` and `abort` to the pick. */
const pickChangesEntry = (variant: Variant, row: AbortRow): ReturnType<typeof entriesOf> => {
  const { tracked, due } = row;
  const byVariant: Record<Variant, ReturnType<typeof entriesOf>> = {
    same: entriesOf('same', row),
    'reset-updates': { base: tracked, main: due, theirs: tracked },
    'reset-adds': { base: tracked, main: [], theirs: tracked },
    'reset-deletes': { base: [], main: due, theirs: [] },
  };
  return byVariant[variant];
};

interface Scenario {
  readonly name: string;
  readonly entries: (variant: Variant, row: AbortRow) => ReturnType<typeof entriesOf>;
  readonly actions: ReadonlyArray<Action>;
}

const SCENARIOS: ReadonlyArray<Scenario> = [
  { name: 'merge', entries: entriesOf, actions: ['abort', 'skip'] },
  { name: 'pick changes entry', entries: pickChangesEntry, actions: ['skip'] },
];

describe.skipIf(!GIT_AVAILABLE)(
  'rebase --abort / --skip reset interop',
  { timeout: 60_000 },
  () => {
    let pair: PeerPair;
    let repo: Repository | undefined;

    beforeEach(async () => {
      pair = await makePeerPair('rebase-reset');
      initBothRepos(pair.peer, pair.ours);
      repo = undefined;
    });
    afterEach(async () => {
      await repo?.dispose();
      await pair.dispose();
    });

    const stopBoth = async (build: (dir: string) => void): Promise<void> => {
      for (const dir of [pair.peer, pair.ours]) build(dir);
      expect(tryRunGit(['-C', pair.peer, 'rebase', 't'], { env: COMMIT_ENV }).ok).toBe(false);
      const opened = await openRepository({ cwd: pair.ours });
      expect((await opened.rebase.run({ upstream: 't' })).kind).toBe('conflict');
      await opened.dispose();
    };

    const finishOnBoth = async (action: Action) => {
      const opened = await openRepository({ cwd: pair.ours });
      repo = opened;
      const expected = gitOutcome(action, pair.peer);
      const result = await tsgitOutcome(action, opened);
      return { expected, result };
    };

    describe.each(SCENARIOS)('Given a stopped rebase, $name', ({ entries, actions }) => {
      describe.each(actions)('When --%s runs over an occupant', (action) => {
        describe.each(
          ABORT_ROWS.flatMap((row) => row.variants.map((variant) => ({ row, variant }))),
        )('over $row.shape/$variant', ({ row, variant }) => {
          it('Then the outcome, work tree, index and stop state match git', async () => {
            // Arrange
            const occupant =
              variant === 'reset-adds' ? (row.addOccupant ?? row.occupant) : row.occupant;
            const stopEntries = entries(variant, row);
            await stopBoth((dir) => buildStoppedMerge(dir, stopEntries));
            occupant(pair.peer);
            occupant(pair.ours);

            // Act
            const { expected, result } = await finishOnBoth(action);

            // Assert
            expect(result).toEqual(expected);
            expect(rebaseState(pair.ours)).toEqual(rebaseState(pair.peer));
          });
        });
      });
    });

    describe.each(['abort', 'skip'] as const)(
      'Given a stop on a conflicted keep replaced by a directory holding an untracked file, When --%s runs',
      (action) => {
        it('Then both tools refuse naming keep and keep the stop state', async () => {
          // Arrange
          await stopBoth((dir) => buildStoppedMerge(dir, { base: [], main: [], theirs: [] }));
          for (const dir of [pair.peer, pair.ours]) {
            replacing('keep', directoryHolding('keep', 'u'))(dir);
          }

          // Act
          const { expected, result } = await finishOnBoth(action);

          // Assert
          expect(expected).toEqual({ refused: true, localChanges: [], untracked: ['keep'] });
          expect(result).toEqual(expected);
          expect(rebaseState(pair.ours)).toEqual(rebaseState(pair.peer));
        });
      },
    );

    describe('Given a stop on a conflicted keep replaced by an untracked file, When --abort runs', () => {
      it('Then both tools abort and keep the picked side', async () => {
        // Arrange
        await stopBoth((dir) => buildStoppedMerge(dir, { base: [], main: [], theirs: [] }));
        for (const dir of [pair.peer, pair.ours]) replacing('keep', fileAt('keep'))(dir);

        // Act
        const { expected, result } = await finishOnBoth('abort');

        // Assert
        expect(expected).toEqual(OK);
        expect(result).toEqual(expected);
        expect(rebaseState(pair.ours)).toEqual(rebaseState(pair.peer));
      });
    });

    describe('Given an edit stop on X, then an occupant over f', () => {
      const buildEditHistory = (dir: string): void => {
        const base = commitOn(dir, [KEEP, v1('f')]);
        const edited = commitOn(dir, [KEEP, v1('f'), regular('x')], base);
        const tip = commitOn(dir, [KEEP, v1('f'), regular('x'), regular('y')], edited);
        runGit(['-C', dir, 'update-ref', 'refs/heads/main', tip]);
        runGit(['-C', dir, 'reset', '-q', '--hard', 'main']);
        runGit(['-C', dir, 'update-ref', 'refs/tags/base', base]);
      };

      const stopOnEdit = async (): Promise<void> => {
        for (const dir of [pair.peer, pair.ours]) buildEditHistory(dir);
        runGit(['-C', pair.peer, 'rebase', '-i', 'base'], {
          env: {
            ...COMMIT_ENV,
            GIT_SEQUENCE_EDITOR: "perl -i -pe 's/^pick/edit/ if $. == 1'",
            GIT_EDITOR: 'true',
          },
        });
        const opened = await openRepository({ cwd: pair.ours });
        const oid = (rev: string) => runGit(['-C', pair.ours, 'rev-parse', rev]).trim();
        const stop = await opened.rebase.run({
          upstream: 'base',
          interactive: [
            { action: 'edit', oid: oid('HEAD~1') },
            { action: 'pick', oid: oid('HEAD') },
          ],
        });
        expect(stop.kind).toBe('stopped');
        await opened.dispose();
      };

      const gitOnBoth = (...args: ReadonlyArray<string>): void => {
        for (const dir of [pair.peer, pair.ours]) runGit(['-C', dir, ...args]);
      };

      const ROWS: ReadonlyArray<{
        readonly title: string;
        readonly prepare: () => void;
        readonly occupant: Occupant;
        readonly refusal: Outcome | undefined;
      }> = [
        {
          title: 'git rm f then a directory f/u',
          prepare: () => gitOnBoth('rm', '-q', 'f'),
          occupant: directoryHolding('f', 'u'),
          refusal: { refused: true, localChanges: [], untracked: ['f'] },
        },
        {
          title: 'git rm --cached f then an untracked file f',
          prepare: () => gitOnBoth('rm', '-q', '--cached', 'f'),
          occupant: fileAt('f'),
          refusal: { refused: true, localChanges: [], untracked: ['f'] },
        },
        {
          title: 'a directory f/u over the still tracked f',
          prepare: () => {
            for (const dir of [pair.peer, pair.ours]) rmSync(path.join(dir, 'f'));
          },
          occupant: directoryHolding('f', 'u'),
          refusal: undefined,
        },
      ];

      describe.each(ROWS)('When --skip runs after $title', ({ prepare, occupant, refusal }) => {
        it('Then the outcome, work tree, index and stop state match git', async () => {
          // Arrange
          await stopOnEdit();
          prepare();
          occupant(pair.peer);
          occupant(pair.ours);

          // Act
          const { expected, result } = await finishOnBoth('skip');

          // Assert
          expect(expected.refused).toBe(refusal !== undefined);
          expect(result).toEqual(expected);
          expect(listing(pair.ours)).toEqual(listing(pair.peer));
          expect(indexState(pair.ours)).toEqual(indexState(pair.peer));
          expect(existsSync(rebaseMerge(pair.ours))).toBe(existsSync(rebaseMerge(pair.peer)));
        });
      });
    });
  },
);
