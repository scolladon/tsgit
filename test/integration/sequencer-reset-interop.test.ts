/**
 * Cross-tool interop — the `--abort` / `--skip` reset of a stopped `cherry-pick` /
 * `revert`. git ends the stop with `reset --merge`: a local change or untracked
 * occupant in the way refuses it (first path only), and a refusal moves neither HEAD,
 * `ORIG_HEAD`, `sequencer/` nor the pick head. Pins both tools against real `git`.
 *
 * @proves
 *   surface:        repo.cherryPick.abort, repo.cherryPick.skip, repo.revert.abort, repo.revert.skip
 *   bucket:         cross-tool-interop
 *   unique:         sequencer abort/skip reset refusals and ORIG_HEAD timing match canonical git
 *   interopSurface: working-tree
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  gitOutcomeOfExit,
  indexState,
  KEEP,
  listing,
  NESTED_CONFLICT,
  NESTED_OCCUPANTS,
  type Outcome,
  regular,
  replacing,
  type TreeEntry,
  tsgitOutcomeOf,
  v1,
} from './occupant-displacement-fixtures.js';
import {
  ABORT_ROWS,
  buildStoppedMerge,
  entriesOf,
  firstClassified,
} from './stopped-state-fixtures.js';
import { RESET_MERGE_PINS } from './stopped-state-pins.js';

type Tool = 'cherry-pick' | 'revert';
type Action = 'abort' | 'skip';

const TOOLS: ReadonlyArray<Tool> = ['cherry-pick', 'revert'];
const ACTIONS: ReadonlyArray<Action> = ['abort', 'skip'];
const PICK_HEADS: Readonly<Record<Tool, string>> = {
  'cherry-pick': 'CHERRY_PICK_HEAD',
  revert: 'REVERT_HEAD',
};

/** `x` undoes `entries.theirs -> entries.base` on top of `main`, and both rewrite `keep`, so `revert x` stops. */
const buildStoppedRevert = (dir: string, entries: ReturnType<typeof entriesOf>): void => {
  const parent = commitOn(dir, [regular('keep', 't\n'), ...entries.theirs]);
  const reverted = commitOn(dir, [regular('keep', 'x\n'), ...entries.base], parent);
  const main = commitOn(dir, [regular('keep', 'm\n'), ...entries.main], reverted);
  runGit(['-C', dir, 'update-ref', 'refs/heads/main', main]);
  runGit(['-C', dir, 'update-ref', 'refs/heads/x', reverted]);
  runGit(['-C', dir, 'reset', '-q', '--hard', 'main']);
};

/** `a` changes `f`; `c` rewrites `keep`, so `cherry-pick a c` applies `a` and stops on `c`. */
const buildStoppedRange = (dir: string): void => {
  const base = commitOn(dir, [KEEP, v1('f')]);
  const main = commitOn(dir, [regular('keep', 'm\n'), v1('f')], base);
  const applied = commitOn(dir, [KEEP, regular('f')], base);
  const stopped = commitOn(dir, [regular('keep', 't\n'), regular('f')], applied);
  runGit(['-C', dir, 'update-ref', 'refs/heads/main', main]);
  runGit(['-C', dir, 'update-ref', 'refs/heads/a', applied]);
  runGit(['-C', dir, 'update-ref', 'refs/heads/c', stopped]);
  runGit(['-C', dir, 'reset', '-q', '--hard', 'main']);
};

const buildStopped = (tool: Tool, dir: string, entries: ReturnType<typeof entriesOf>): void => {
  if (tool === 'revert') buildStoppedRevert(dir, entries);
  else buildStoppedMerge(dir, entries);
};

const REVISION: Readonly<Record<Tool, string>> = { 'cherry-pick': 't', revert: 'x' };

const gitStop = (tool: Tool, dir: string, ...revs: ReadonlyArray<string>): void => {
  const result = tryRunGit(['-C', dir, tool, ...revs], { env: COMMIT_ENV });
  expect(result.ok).toBe(false);
};

const tsgitStop = async (tool: Tool, repo: Repository, revs: ReadonlyArray<string>) => {
  const result =
    tool === 'revert'
      ? await repo.revert.run({ commits: [...revs] })
      : await repo.cherryPick.run({ commits: [...revs] });
  expect(result.kind).toBe('conflict');
};

const REFUSED_EXIT = 128;

const gitOutcome = (tool: Tool, action: Action, dir: string): Outcome =>
  gitOutcomeOfExit(
    tryRunGitWithExit(['-C', dir, tool, `--${action}`], { env: COMMIT_ENV }),
    REFUSED_EXIT,
    firstClassified,
  );

const tsgitOutcome = (tool: Tool, action: Action, repo: Repository): Promise<Outcome> =>
  tsgitOutcomeOf(
    () => (tool === 'revert' ? repo.revert[action]() : repo.cherryPick[action]()),
    'WORKING_TREE_DIRTY',
  );

const readIfPresent = (file: string): string | undefined =>
  existsSync(file) ? readFileSync(file, 'utf8') : undefined;

const sequencerFiles = (dir: string): ReadonlyArray<string> | undefined => {
  const sequencer = path.join(dir, '.git', 'sequencer');
  return existsSync(sequencer) ? readdirSync(sequencer).sort() : undefined;
};

/** The picked commits carry a wall-clock date on each tool, so a moved HEAD is named by its position, not its oid. */
const labelled = (dir: string, oid: string | undefined): string | undefined => {
  if (oid === undefined) return undefined;
  const head = runGit(['-C', dir, 'rev-parse', 'HEAD']).trim();
  const parent = tryRunGit(['-C', dir, 'rev-parse', 'HEAD^']).stdout.trim();
  const trimmed = oid.trim();
  if (trimmed === head) return 'HEAD';
  return trimmed === parent ? 'HEAD^' : trimmed;
};

const gitState = (tool: Tool, dir: string): ReadonlyArray<unknown> => [
  listing(dir),
  indexState(dir),
  labelled(dir, runGit(['-C', dir, 'rev-parse', 'HEAD'])),
  labelled(dir, readIfPresent(path.join(dir, '.git', 'ORIG_HEAD'))),
  readIfPresent(path.join(dir, '.git', PICK_HEADS[tool])),
  sequencerFiles(dir),
  tryRunGit(['-C', dir, 'stash', 'list']).stdout,
];

interface Case {
  readonly id: string;
  readonly row: (typeof ABORT_ROWS)[number];
  readonly variant: Parameters<typeof entriesOf>[0];
  readonly pinned: Outcome | undefined;
}

const CASES: ReadonlyArray<Case> = ABORT_ROWS.flatMap((row) =>
  row.variants.map((variant) => ({
    id: `${row.shape}/${variant}`,
    row,
    variant,
    pinned: RESET_MERGE_PINS[`${row.shape}/${variant}`],
  })),
);

describe.skipIf(!GIT_AVAILABLE)(
  'sequencer --abort / --skip reset interop',
  { timeout: 60_000 },
  () => {
    let pair: PeerPair;
    let repo: Repository | undefined;

    beforeEach(async () => {
      pair = await makePeerPair('sequencer-reset');
      initBothRepos(pair.peer, pair.ours);
      repo = undefined;
    });
    afterEach(async () => {
      await repo?.dispose();
      await pair.dispose();
    });

    const stopBoth = async (
      tool: Tool,
      build: (dir: string) => void,
      revs: ReadonlyArray<string>,
    ): Promise<void> => {
      for (const dir of [pair.peer, pair.ours]) build(dir);
      gitStop(tool, pair.peer, ...revs);
      repo = await openRepository({ cwd: pair.ours });
      await tsgitStop(tool, repo, revs);
      await repo.dispose();
    };

    const finishOnBoth = async (
      tool: Tool,
      action: Action,
    ): Promise<{ expected: Outcome; result: Outcome }> => {
      const opened = await openRepository({ cwd: pair.ours });
      repo = opened;
      const expected = gitOutcome(tool, action, pair.peer);
      const result = await tsgitOutcome(tool, action, opened);
      return { expected, result };
    };

    describe.each(TOOLS.flatMap((tool) => ACTIONS.map((action) => ({ tool, action }))))(
      '$tool --$action',
      ({ tool, action }) => {
        describe.each(CASES)('Given the stopped pick $id', ({ row, variant, pinned }) => {
          describe('When both tools finish it', () => {
            it('Then the outcome, work tree, index and pick state match git', async () => {
              // Arrange
              const occupant =
                variant === 'reset-adds' ? (row.addOccupant ?? row.occupant) : row.occupant;
              const entries = entriesOf(variant, row);
              await stopBoth(tool, (dir) => buildStopped(tool, dir, entries), [REVISION[tool]]);
              occupant(pair.peer);
              occupant(pair.ours);

              // Act
              const { expected, result } = await finishOnBoth(tool, action);

              // Assert
              expect(expected).toEqual(pinned ?? expected);
              expect(result).toEqual(expected);
              expect(listing(pair.ours)).toEqual(listing(pair.peer));
              expect(gitState(tool, pair.ours)).toEqual(gitState(tool, pair.peer));
            });
          });
        });

        describe('Given a stop where a directory replaces the updated f', () => {
          describe('When both tools finish it', () => {
            it('Then a refusal leaves HEAD, ORIG_HEAD, sequencer and the pick head put', async () => {
              // Arrange
              const entries = { base: [v1('f')], main: [v1('f')], theirs: [regular('f')] };
              await stopBoth(tool, (dir) => buildStopped(tool, dir, entries), [REVISION[tool]]);
              for (const dir of [pair.peer, pair.ours]) {
                replacing('f', directoryHolding('f', 'u'))(dir);
              }
              const origHeadBefore = readIfPresent(path.join(pair.ours, '.git', 'ORIG_HEAD'));

              // Act
              const { expected, result } = await finishOnBoth(tool, action);

              // Assert
              expect(expected).toEqual({ refused: true, localChanges: ['f'], untracked: [] });
              expect(result).toEqual(expected);
              expect(readIfPresent(path.join(pair.ours, '.git', 'ORIG_HEAD'))).toBe(origHeadBefore);
              expect(gitState(tool, pair.ours)).toEqual(gitState(tool, pair.peer));
            });
          });
        });

        describe('Given the unmerged keep replaced by a directory holding an untracked file', () => {
          describe('When both tools finish it', () => {
            it('Then the refusal names keep and the pick state is kept', async () => {
              // Arrange
              const entries = { base: [], main: [], theirs: [] };
              await stopBoth(tool, (dir) => buildStopped(tool, dir, entries), [REVISION[tool]]);
              for (const dir of [pair.peer, pair.ours]) {
                replacing('keep', directoryHolding('keep', 'u'))(dir);
              }

              // Act
              const { expected, result } = await finishOnBoth(tool, action);

              // Assert
              expect(expected).toEqual({ refused: true, localChanges: [], untracked: ['keep'] });
              expect(result).toEqual(expected);
              expect(gitState(tool, pair.ours)).toEqual(gitState(tool, pair.peer));
            });
          });
        });

        describe.each(NESTED_OCCUPANTS)('Given the unmerged d/x beneath %s', (_label, occupant) => {
          describe('When both tools finish it', () => {
            it('Then d/x is restored as in git and the pick state matches', async () => {
              // Arrange
              await stopBoth(tool, (dir) => buildStopped(tool, dir, NESTED_CONFLICT), [
                REVISION[tool],
              ]);
              occupant(pair.peer);
              occupant(pair.ours);

              // Act
              const { expected, result } = await finishOnBoth(tool, action);

              // Assert
              expect(result).toEqual(expected);
              expect(listing(pair.ours)).toEqual(listing(pair.peer));
              expect(gitState(tool, pair.ours)).toEqual(gitState(tool, pair.peer));
            });
          });
        });
      },
    );

    describe.each(ACTIONS)(
      'Given a cherry-pick a c stopped on c, then a directory replacing f, --%s',
      (action) => {
        describe('When both tools finish it', () => {
          it('Then the outcome, work tree, index, ORIG_HEAD and sequencer match git', async () => {
            // Arrange
            await stopBoth('cherry-pick', buildStoppedRange, ['a', 'c']);
            for (const dir of [pair.peer, pair.ours]) {
              replacing('f', directoryHolding('f', 'u'))(dir);
            }

            // Act
            const { expected, result } = await finishOnBoth('cherry-pick', action);

            // Assert
            expect(result).toEqual(expected);
            expect(listing(pair.ours)).toEqual(listing(pair.peer));
            expect(gitState('cherry-pick', pair.ours)).toEqual(gitState('cherry-pick', pair.peer));
          });
        });
      },
    );
  },
);

export type { TreeEntry };
