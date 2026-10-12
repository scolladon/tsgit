/**
 * Cross-tool interop — where the operation markers live in a reftable
 * repository. git keeps `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `ORIG_HEAD` and
 * `REBASE_HEAD` in the ref backend (the reftable stack) and only `MERGE_HEAD`
 * and `FETCH_HEAD` as files in the git dir. Every row replays the same
 * history in two reftable repositories, stops one tool on a conflict in each,
 * and compares what each marker resolves to and whether a loose file exists.
 *
 * @proves
 *   surface:        cherryPick, revert, merge, rebase, revParse
 *   bucket:         cross-tool-interop
 *   unique:         the operation markers of a reftable repository live in the stack, MERGE_HEAD in a file, as git keeps them
 *   interopSurface: merge
 */

import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { openRepository, type Repository } from '../../src/index.node.js';
import { GIT_AVAILABLE, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const ROW_TIMEOUT = 60_000;
const EPOCH = 1_700_000_000;
const DATED_ENV = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'A',
  GIT_AUTHOR_EMAIL: 'a@x',
  GIT_COMMITTER_NAME: 'A',
  GIT_COMMITTER_EMAIL: 'a@x',
  GIT_AUTHOR_DATE: `${EPOCH} +0000`,
  GIT_COMMITTER_DATE: `${EPOCH} +0000`,
  GIT_EDITOR: 'true',
};
const MARKERS = ['CHERRY_PICK_HEAD', 'REVERT_HEAD', 'ORIG_HEAD', 'REBASE_HEAD', 'MERGE_HEAD'];

let root: string;

const dated = (dir: string, ...args: ReadonlyArray<string>): string =>
  runGit(['-C', dir, ...args], { env: DATED_ENV });

const commitFile = (dir: string, file: string, content: string, message: string): void => {
  writeFileSync(path.join(dir, file), `${content}\n`);
  dated(dir, 'add', file);
  dated(dir, 'commit', '-q', '-m', message);
};

/** base → side changes f; clean adds n; main changes f. `side` conflicts with main on f. */
const setUp = (dir: string): void => {
  runGit(['init', '-q', '-b', 'main', '--ref-format=reftable', dir], { env: DATED_ENV });
  dated(dir, 'config', 'user.name', 'A');
  dated(dir, 'config', 'user.email', 'a@x');
  commitFile(dir, 'f', 'base', 'base');
  dated(dir, 'checkout', '-q', '-b', 'side');
  commitFile(dir, 'f', 'side', 'side');
  dated(dir, 'checkout', '-q', '-b', 'clean', 'main');
  commitFile(dir, 'n', 'n', 'n');
  dated(dir, 'checkout', '-q', 'main');
  commitFile(dir, 'f', 'main', 'main');
};

const twin = (label: string) => {
  const slug = label.replaceAll(/\W+/g, '-');
  const theirs = path.join(root, `${slug}-git`);
  const ours = path.join(root, `${slug}-ts`);
  for (const dir of [theirs, ours]) setUp(dir);
  return { theirs, ours };
};

const openFrozen = async (dir: string): Promise<Repository> => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(EPOCH * 1000);
  return openRepository({ cwd: dir });
};

/** What each marker resolves to through git, and whether a loose file holds it. */
const markers = (dir: string): ReadonlyArray<string> =>
  MARKERS.map((name) => {
    const result = tryRunGitWithExit(['-C', dir, 'rev-parse', '-q', '--verify', name], {
      env: DATED_ENV,
    });
    const value = result.exitCode === 0 ? result.stdout.trim() : 'absent';
    return `${name}=${value} loose=${existsSync(path.join(dir, '.git', name))}`;
  });

/** A linked worktree path whose admin id is `wt` in either repository. */
const linked = (dir: string): string => path.join(`${dir}-linked`, 'wt');

/** The linked worktree's ORIG_HEAD read from the main repository, and whether a loose file holds it. */
const worktreeOrigHead = (dir: string): ReadonlyArray<string | boolean> => [
  dated(dir, 'rev-parse', 'worktrees/wt/ORIG_HEAD').trim(),
  existsSync(path.join(dir, '.git', 'worktrees', 'wt', 'ORIG_HEAD')),
];

const STOPS = [
  {
    label: 'a conflicted cherry-pick',
    git: ['cherry-pick', 'side'],
    ts: (repo: Repository) => repo.cherryPick.run({ commits: ['side'] }),
  },
  {
    label: 'a conflicted revert',
    git: ['revert', '--no-edit', 'side'],
    ts: (repo: Repository) => repo.revert.run({ commits: ['side'] }),
  },
  {
    label: 'a conflicted merge',
    git: ['merge', 'side'],
    ts: (repo: Repository) => repo.merge.run({ rev: 'side' }),
  },
  {
    label: 'a conflicted rebase',
    git: ['rebase', 'side'],
    ts: (repo: Repository) => repo.rebase.run({ upstream: 'side' }),
  },
];

beforeAll(() => {
  if (!GIT_AVAILABLE) return;
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tsgit-interop-reftable-pseudo-')));
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe.skipIf(!GIT_AVAILABLE)('reftable pseudo-ref interop', () => {
  describe.each(STOPS)('Given a reftable repository and $label', ({ label, git, ts }) => {
    describe('When both tools stop on the conflict', () => {
      it(
        'Then every marker resolves the same and only MERGE_HEAD is a loose file',
        async () => {
          // Arrange
          const { theirs, ours } = twin(label);
          const repo = await openFrozen(ours);

          // Act
          tryRunGitWithExit(['-C', theirs, ...git], { env: DATED_ENV });
          await ts(repo).catch(() => undefined);

          // Assert
          expect(markers(ours)).toEqual(markers(theirs));
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a reftable repository where git stopped a cherry-pick and the conflict is staged', () => {
    describe('When tsgit is asked to merge', () => {
      it(
        'Then it refuses because the cherry-pick is still in progress, as git does',
        async () => {
          // Arrange
          const { theirs, ours } = twin('git stopped pick');
          for (const dir of [theirs, ours]) {
            tryRunGitWithExit(['-C', dir, 'cherry-pick', 'side'], { env: DATED_ENV });
            writeFileSync(path.join(dir, 'f'), 'resolved\n');
            dated(dir, 'add', 'f');
          }
          const repo = await openFrozen(ours);

          // Act
          const gitResult = tryRunGitWithExit(['-C', theirs, 'merge', 'clean'], {
            env: DATED_ENV,
          });
          const result = await repo.merge.run({ rev: 'clean' }).then(
            () => undefined,
            (error: unknown) => error,
          );

          // Assert
          expect(gitResult.stderr).toContain('You have not concluded your cherry-pick');
          expect((result as { data?: unknown }).data).toEqual({
            code: 'OPERATION_IN_PROGRESS',
            operation: 'cherry-pick',
          });
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a reftable repository where git stopped a merge on a conflict', () => {
    describe('When tsgit resolves MERGE_HEAD', () => {
      it(
        'Then it reads the loose MERGE_HEAD file git wrote',
        async () => {
          // Arrange
          const { ours } = twin('git stopped merge');
          tryRunGitWithExit(['-C', ours, 'merge', 'side'], { env: DATED_ENV });
          const repo = await openFrozen(ours);

          // Act
          const result = await repo.revParse('MERGE_HEAD');

          // Assert
          expect(result).toEqual([
            { kind: 'object', id: dated(ours, 'rev-parse', 'MERGE_HEAD').trim(), negated: false },
          ]);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a reftable repository', () => {
    describe('When both tools add a linked worktree', () => {
      it(
        "Then the worktree's ORIG_HEAD lives in its own stack, naming the same commit",
        async () => {
          // Arrange
          const { theirs, ours } = twin('worktree add');
          const repo = await openFrozen(ours);

          // Act
          tryRunGitWithExit(['-C', theirs, 'worktree', 'add', '-q', linked(theirs), 'clean'], {
            env: DATED_ENV,
          });
          await repo.worktree.add({ path: linked(ours), commitish: 'clean' });

          // Assert
          expect(worktreeOrigHead(ours)).toEqual(worktreeOrigHead(theirs));
        },
        ROW_TIMEOUT,
      );
    });
  });
});
