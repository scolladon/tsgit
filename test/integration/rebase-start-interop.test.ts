/**
 * Cross-tool interop — the checkout `rebase` runs before it moves HEAD. git does an unforced
 * two-way checkout there: a tracked change refuses at the unstaged-changes precondition, an
 * untracked occupant where `onto` writes refuses with `could not detach HEAD`, and either way
 * HEAD does not move and no rebase state is left. Pins both tools against real `git`.
 *
 * @proves
 *   surface:        repo.rebase.run
 *   bucket:         cross-tool-interop
 *   unique:         rebase start and fast-forward check out onto unforced and leave no state on refusal as canonical git
 *   interopSurface: working-tree
 */
import { existsSync } from 'node:fs';
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
  indexState,
  KEEP,
  listing,
  OK,
  type Outcome,
  outcomeOfGitStderr,
  regular,
  type TreeEntry,
} from './occupant-displacement-fixtures.js';
import { type AbortRow, REBASE_START_ROWS, type Variant } from './stopped-state-fixtures.js';
import { REBASE_START_PINS, type StartVerdict } from './stopped-state-pins.js';

type Form = 'start' | 'interactive' | 'fast-forward';

const REFUSAL_STATUSES: ReadonlySet<number> = new Set([1, 128]);
const SIDE = regular('s', 's\n');
const FORMS: ReadonlyArray<Form> = ['start', 'interactive', 'fast-forward'];

interface Sides {
  readonly head: ReadonlyArray<TreeEntry>;
  readonly target: ReadonlyArray<TreeEntry>;
}

/** HEAD holds `head`, `onto` holds `target`; `reset-adds` has `onto` write the path HEAD lacks. */
const sidesOf = (variant: Variant, row: AbortRow): Sides => {
  const byVariant: Record<Variant, Sides> = {
    same: { head: row.tracked, target: row.tracked },
    'reset-updates': { head: row.tracked, target: row.due },
    'reset-adds': { head: [], target: row.tracked },
    'reset-deletes': { head: row.tracked, target: [] },
  };
  return byVariant[variant];
};

/** `fast-forward` keeps HEAD an ancestor of `onto`; the other forms fork both off a shared base. */
const buildHistory = (dir: string, form: Form, { head, target }: Sides): void => {
  const base = commitOn(dir, [KEEP, ...head]);
  const main = form === 'fast-forward' ? base : commitOn(dir, [KEEP, ...head, SIDE], base);
  const onto = commitOn(dir, [KEEP, ...target], base);
  runGit(['-C', dir, 'update-ref', 'refs/heads/main', main]);
  runGit(['-C', dir, 'update-ref', 'refs/heads/t', onto]);
  runGit(['-C', dir, 'reset', '-q', '--hard', 'main']);
};

const gitRebase = (dir: string, form: Form): StartVerdict => {
  const interactive = form === 'interactive' ? ['-i'] : [];
  const result = tryRunGitWithExit(['-C', dir, 'rebase', ...interactive, 't'], {
    env: { ...COMMIT_ENV, GIT_SEQUENCE_EDITOR: 'true', GIT_EDITOR: 'true' },
  });
  if (result.exitCode === 0) return 'ok';
  if (!REFUSAL_STATUSES.has(result.exitCode)) {
    throw new Error(`unexpected exit ${result.exitCode}: ${result.stderr}`);
  }
  if (/unstaged changes/.test(result.stderr)) return 'precondition';
  return { untracked: outcomeOfGitStderr(result.stderr).untracked };
};

const verdictOf = (outcome: Outcome): StartVerdict => {
  if (!outcome.refused) return 'ok';
  if (outcome.localChanges.length > 0 && outcome.untracked.length === 0) return 'precondition';
  return { untracked: outcome.untracked };
};

const tsgitRebase = async (dir: string, repo: Repository, form: Form): Promise<StartVerdict> => {
  const oid = runGit(['-C', dir, 'rev-parse', 'HEAD']).trim();
  const interactive = form === 'interactive' ? [{ action: 'pick' as const, oid }] : undefined;
  try {
    await repo.rebase.run({ upstream: 't', ...(interactive !== undefined && { interactive }) });
    return verdictOf(OK);
  } catch (err) {
    if (!(err instanceof TsgitError)) throw err;
    const data = err.data;
    if (data.code !== 'WORKING_TREE_DIRTY') throw err;
    return verdictOf({
      refused: true,
      localChanges: data.localChanges,
      untracked: data.untracked,
    });
  }
};

const startState = (dir: string): ReadonlyArray<unknown> => [
  listing(dir),
  indexState(dir),
  tryRunGit(['-C', dir, 'rev-parse', 'HEAD^{tree}']).stdout,
  tryRunGit(['-C', dir, 'symbolic-ref', '-q', 'HEAD']).stdout,
  existsSync(path.join(dir, '.git', 'rebase-merge')),
];

const ROWS = REBASE_START_ROWS.flatMap((row) => row.variants.map((variant) => ({ row, variant })));

describe.skipIf(!GIT_AVAILABLE)('rebase start checkout interop', { timeout: 60_000 }, () => {
  let pair: PeerPair;
  let repo: Repository | undefined;

  beforeEach(async () => {
    pair = await makePeerPair('rebase-start');
    initBothRepos(pair.peer, pair.ours);
    repo = undefined;
  });
  afterEach(async () => {
    await repo?.dispose();
    await pair.dispose();
  });

  describe.each(FORMS)('Given a %s rebase onto t', (form) => {
    describe.each(ROWS)(
      'When $row.shape/$variant has an occupant in the work tree',
      ({ row, variant }) => {
        it('Then the outcome, work tree, index, HEAD and rebase state match git', async () => {
          // Arrange
          const occupant =
            variant === 'reset-adds' ? (row.addOccupant ?? row.occupant) : row.occupant;
          for (const dir of [pair.peer, pair.ours]) {
            buildHistory(dir, form, sidesOf(variant, row));
            occupant(dir);
          }
          repo = await openRepository({ cwd: pair.ours });

          // Act
          const expected = gitRebase(pair.peer, form);
          const result = await tsgitRebase(pair.ours, repo, form);

          // Assert
          expect(expected).toEqual(REBASE_START_PINS[`${row.shape}/${variant}`] ?? expected);
          expect(result).toEqual(expected);
          expect(startState(pair.ours)).toEqual(startState(pair.peer));
        });
      },
    );
  });
});
