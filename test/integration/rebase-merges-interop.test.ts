/**
 * Cross-tool `rebase --rebase-merges` interop: both tools rebase byte-identical
 * fixtures under a pinned clock, so the recreated commits, the merge, the refs,
 * the reflogs and the `.git/rebase-merge/` stop state compare byte for byte.
 *
 * @writes
 *   surface: rebase
 *   kind:    byte-identical
 *   format:  rebase-merge-state
 *
 * @proves
 *   surface:        rebase
 *   bucket:         cross-tool-interop
 *   unique:         a --rebase-merges rebase recreates merges, labels and resets exactly as git does, through a conflicted merge and its continue, skip or abort
 *   interopSurface: rebaseMerge, reflog
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import {
  type RebaseRunInput,
  rebaseAbort,
  rebaseContinue,
  rebaseRun,
  rebaseSkip,
} from '../../src/application/commands/rebase.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';
import { indexState, listing } from './occupant-displacement-fixtures.js';
import {
  ABORT_ROWS,
  type AbortRow,
  buildStoppedMerge,
  entriesOf,
} from './stopped-state-fixtures.js';

const EPOCH = 1_700_000_000;
const DATED_ENV = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_AUTHOR_DATE: `${EPOCH} +0000`,
  GIT_COMMITTER_DATE: `${EPOCH} +0000`,
  GIT_EDITOR: 'true',
};
const STOP_FILES = [
  'done',
  'git-rebase-todo',
  'git-rebase-todo.backup',
  'message',
  'author-script',
  'stopped-sha',
  'refs-to-delete',
  'msgnum',
  'end',
  'rewritten-list',
  'patch',
  'onto',
  'orig-head',
  'head-name',
];

let root: string;

const dated = (dir: string, ...args: ReadonlyArray<string>): string =>
  runGit(['-C', dir, ...args], { env: DATED_ENV });

const commitFile = (dir: string, file: string, body = `${file}\n`): void => {
  writeFileSync(path.join(dir, file), body);
  dated(dir, 'add', file);
  dated(dir, 'commit', '-q', '-m', file);
};

beforeAll(() => {
  if (!GIT_AVAILABLE) return;
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tsgit-interop-rebase-merges-')));
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
});

type Shape = (dir: string) => void;

/** topic: c1, side s1 off c1, c2, merge of side, c3; main advances with u1 unless told not to. */
const forked =
  (opts: { conflict?: boolean; advanceMain?: boolean; upstreamFile?: string } = {}): Shape =>
  (dir) => {
    commitFile(dir, 'base');
    dated(dir, 'checkout', '-q', '-b', 'topic');
    commitFile(dir, 'c1');
    dated(dir, 'checkout', '-q', '-b', 'side');
    commitFile(dir, 'y', 's\n');
    dated(dir, 'checkout', '-q', 'topic');
    commitFile(dir, opts.conflict === true ? 'y' : 'c2', 't\n');
    tryRunGitWithExit(
      ['-C', dir, 'merge', '-q', '--no-ff', 'side', '-m', "Merge branch 'side' into topic"],
      {
        env: DATED_ENV,
      },
    );
    if (opts.conflict === true) {
      writeFileSync(path.join(dir, 'y'), 'st\n');
      dated(dir, 'add', 'y');
      dated(dir, 'commit', '-q', '--no-edit');
    }
    commitFile(dir, 'c3');
    if (opts.advanceMain === false) return;
    dated(dir, 'checkout', '-q', 'main');
    commitFile(dir, opts.upstreamFile ?? 'u1', 's\n');
    dated(dir, 'checkout', '-q', 'topic');
  };

/** main: base, m1, u1; side s1 off m1; topic c1 off base merges side — s1's block is a cousin. */
const cousin: Shape = (dir) => {
  commitFile(dir, 'base');
  dated(dir, 'checkout', '-q', '-b', 'topic');
  commitFile(dir, 'c1');
  dated(dir, 'checkout', '-q', 'main');
  commitFile(dir, 'm1');
  dated(dir, 'checkout', '-q', '-b', 'side');
  commitFile(dir, 's1');
  dated(dir, 'checkout', '-q', 'topic');
  dated(dir, 'merge', '-q', '--no-ff', 'side', '-m', "Merge branch 'side' into topic");
  dated(dir, 'branch', '-q', '-D', 'side');
  dated(dir, 'checkout', '-q', 'main');
  commitFile(dir, 'u1');
  dated(dir, 'checkout', '-q', 'topic');
};

/** topic: t1, a commit that starts empty, t3; main advances with u1. */
const withEmptyCommit: Shape = (dir) => {
  commitFile(dir, 'base');
  dated(dir, 'checkout', '-q', '-b', 'topic');
  commitFile(dir, 't1');
  dated(dir, 'commit', '-q', '--allow-empty', '-m', 'empty');
  commitFile(dir, 't3');
  dated(dir, 'checkout', '-q', 'main');
  commitFile(dir, 'u1');
  dated(dir, 'checkout', '-q', 'topic');
};

const setUp = (label: string, shape: Shape) => {
  const dirs = {
    ours: path.join(root, `${label}-ours`),
    theirs: path.join(root, `${label}-theirs`),
  };
  for (const dir of [dirs.ours, dirs.theirs]) {
    runGit(['init', '-q', '-b', 'main', dir], { env: DATED_ENV });
    dated(dir, 'config', 'user.name', 't');
    dated(dir, 'config', 'user.email', 't@t');
    shape(dir);
  }
  return dirs;
};

const readGit = (dir: string, name: string): string | undefined => {
  const file = path.join(dir, '.git', name);
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
};

const state = (dir: string) => ({
  log: git(dir, 'log', '--format=%H %P %an %s', 'HEAD'),
  headLog: git(dir, 'reflog', '--format=%H %gs', 'HEAD'),
  topicLog: git(dir, 'reflog', '-2', '--format=%H %gs', 'refs/heads/topic'),
  origHead: readGit(dir, 'ORIG_HEAD'),
  rewritten: git(dir, 'for-each-ref', 'refs/rewritten'),
  rewrittenDir: existsSync(path.join(dir, '.git', 'refs', 'rewritten')),
  merge: ['MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE', 'REBASE_HEAD'].map((f) => readGit(dir, f)),
  stop: STOP_FILES.map((f) => readGit(dir, `rebase-merge/${f}`)),
});

const tsgitAt = (dir: string) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(EPOCH * 1000);
  return createNodeContext({ workDir: dir });
};

const rebaseBoth = async (
  dirs: { ours: string; theirs: string },
  gitArgs: ReadonlyArray<string>,
  input: RebaseRunInput,
): Promise<void> => {
  tryRunGitWithExit(['-C', dirs.theirs, 'rebase', ...gitArgs, 'main'], { env: DATED_ENV });
  await rebaseRun(tsgitAt(dirs.ours), input);
};

/** base carries p; the side commit deletes p and conflicts on k with main's u1; topic merges side. */
const sideDeletingP: Shape = (dir) => {
  writeFileSync(path.join(dir, 'p'), 'p\n');
  commitFile(dir, 'k', 'base\n');
  dated(dir, 'add', 'p');
  dated(dir, 'commit', '-q', '-m', 'p');
  dated(dir, 'checkout', '-q', '-b', 'topic');
  commitFile(dir, 'c1');
  dated(dir, 'checkout', '-q', '-b', 'side', 'main');
  dated(dir, 'rm', '-q', 'p');
  writeFileSync(path.join(dir, 'k'), 'side\n');
  dated(dir, 'add', 'k');
  dated(dir, 'commit', '-q', '-m', 's1');
  dated(dir, 'checkout', '-q', 'topic');
  dated(dir, 'merge', '-q', '--no-ff', 'side', '-m', "Merge branch 'side' into topic");
  dated(dir, 'checkout', '-q', 'main');
  commitFile(dir, 'k', 'main\n');
  dated(dir, 'checkout', '-q', 'topic');
};

/** The side commit `t` conflicts on keep with main and is followed by a `reset onto` once labelled. */
const sideConflictingOnKeep =
  (entries: ReturnType<typeof entriesOf>): Shape =>
  (dir) => {
    buildStoppedMerge(dir, entries);
    dated(dir, 'checkout', '-q', '-b', 'topic', 't~1');
    commitFile(dir, 'c1');
    dated(dir, 'merge', '-q', '--no-ff', 't', '-m', "Merge branch 't' into topic");
  };

// git checks an ignored occupant out of the way, so the reset step does not stop on these shapes.
const GIT_DISPLACES_IGNORED_ADDS: ReadonlySet<string> = new Set(['I1', 'I2', 'I4']);

const RESET_ROWS = ABORT_ROWS.flatMap((row) => row.variants.map((variant) => ({ row, variant })));

const resetStepState = (dir: string) => ({
  head: git(dir, 'rev-parse', 'HEAD'),
  listing: listing(dir),
  index: indexState(dir),
  todo: readGit(dir, 'rebase-merge/git-rebase-todo'),
  done: readGit(dir, 'rebase-merge/done'),
  rebaseHead: readGit(dir, 'REBASE_HEAD'),
});

const refusedResetState = (dir: string) => ({
  head: git(dir, 'rev-parse', 'HEAD'),
  occupant: readFileSync(path.join(dir, 'p'), 'utf8'),
  index: git(dir, 'ls-files', '--stage'),
  todo: readGit(dir, 'rebase-merge/git-rebase-todo'),
  done: readGit(dir, 'rebase-merge/done'),
  end: readGit(dir, 'rebase-merge/end'),
  msgnum: readGit(dir, 'rebase-merge/msgnum'),
  rebaseHead: readGit(dir, 'REBASE_HEAD'),
});

describe.skipIf(!GIT_AVAILABLE)('rebase --rebase-merges interop', () => {
  describe('Given a topic that merged a side branch, and an advanced main', () => {
    describe('When both tools rebase it with merges', () => {
      it('Then the commits, the merge, the reflogs and the cleaned labels agree', async () => {
        // Arrange
        const dirs = setUp('clean', forked());
        const sut = rebaseBoth;

        // Act
        await sut(dirs, ['-r'], { upstream: 'main', rebaseMerges: true });

        // Assert
        expect(state(dirs.ours)).toEqual(state(dirs.theirs));
      });
    });
  });

  describe('Given main already carries the merged side commit', () => {
    describe('When both tools rebase it with merges', () => {
      it('Then both drop the merge that has nothing left to merge', async () => {
        // Arrange
        const dirs = setUp('kept-merge', forked({ upstreamFile: 'y' }));
        const sut = rebaseBoth;

        // Act
        await sut(dirs, ['-r'], { upstream: 'main', rebaseMerges: true });

        // Assert
        expect(state(dirs.ours)).toEqual(state(dirs.theirs));
      });
    });
  });

  describe('Given a topic with merges already on main', () => {
    describe('When both tools rebase it with merges', () => {
      it('Then every instruction fast-forwards alike', async () => {
        // Arrange
        const dirs = setUp('kept', forked({ advanceMain: false }));
        const sut = rebaseBoth;

        // Act
        await sut(dirs, ['-r'], { upstream: 'main', rebaseMerges: true });

        // Assert
        expect(state(dirs.ours)).toEqual(state(dirs.theirs));
      });
    });
  });

  describe('Given a merged side branch rooted outside the range', () => {
    describe.each([
      { mode: 'no-rebase-cousins', args: ['-r'], rebaseMerges: true },
      {
        mode: 'rebase-cousins',
        args: ['--rebase-merges=rebase-cousins'],
        rebaseMerges: 'rebase-cousins' as const,
      },
    ])('When both tools rebase it with $mode', ({ mode, args, rebaseMerges }) => {
      it('Then the cousin lands where git puts it', async () => {
        // Arrange
        const dirs = setUp(`cousin-${mode}`, cousin);
        const sut = rebaseBoth;

        // Act
        await sut(dirs, args, { upstream: 'main', rebaseMerges });

        // Assert
        expect(state(dirs.ours)).toEqual(state(dirs.theirs));
      });
    });
  });

  describe('Given a topic commit that starts empty', () => {
    describe('When both tools rebase it with merges', () => {
      it('Then both keep it as an empty commit', async () => {
        // Arrange
        const dirs = setUp('empty', withEmptyCommit);
        const sut = rebaseBoth;

        // Act
        await sut(dirs, ['-r'], { upstream: 'main', rebaseMerges: true });

        // Assert
        expect(state(dirs.ours)).toEqual(state(dirs.theirs));
      });
    });
  });

  describe('Given a merge whose recreation conflicts', () => {
    describe('When both tools rebase it with merges', () => {
      it('Then both stop on the merge with the same state', async () => {
        // Arrange
        const dirs = setUp('stop', forked({ conflict: true }));
        const sut = rebaseBoth;

        // Act
        await sut(dirs, ['-r'], { upstream: 'main', rebaseMerges: true });

        // Assert
        expect(state(dirs.ours)).toEqual(state(dirs.theirs));
      });
    });

    describe.each([
      {
        action: 'continue',
        gitArgs: ['--continue'],
        run: (dir: string) => rebaseContinue(tsgitAt(dir)),
      },
      { action: 'skip', gitArgs: ['--skip'], run: (dir: string) => rebaseSkip(tsgitAt(dir)) },
      { action: 'abort', gitArgs: ['--abort'], run: (dir: string) => rebaseAbort(tsgitAt(dir)) },
    ])('When both tools resolve and $action', ({ action, gitArgs, run }) => {
      it('Then the finished history agrees', async () => {
        // Arrange
        const dirs = setUp(`stop-${action}`, forked({ conflict: true }));
        await rebaseBoth(dirs, ['-r'], { upstream: 'main', rebaseMerges: true });
        for (const dir of [dirs.ours, dirs.theirs]) {
          writeFileSync(path.join(dir, 'y'), 'st\n');
          dated(dir, 'add', 'y');
        }
        const sut = run;

        // Act
        tryRunGitWithExit(['-C', dirs.theirs, 'rebase', ...gitArgs], { env: DATED_ENV });
        await sut(dirs.ours);

        // Assert
        expect(state(dirs.ours)).toEqual(state(dirs.theirs));
      });
    });
  });

  describe('Given a resolved conflict followed by a reset step that would restore an untracked file', () => {
    describe('When both tools continue', () => {
      it('Then both refuse, keep the file and HEAD, and reschedule the reset step', async () => {
        // Arrange
        const dirs = setUp('reset-occupant', sideDeletingP);
        await rebaseBoth(dirs, ['-r'], { upstream: 'main', rebaseMerges: true });
        for (const dir of [dirs.ours, dirs.theirs]) {
          writeFileSync(path.join(dir, 'k'), 'resolved\n');
          dated(dir, 'add', 'k');
          writeFileSync(path.join(dir, 'p'), 'occupant\n');
        }
        const sut = rebaseContinue;

        // Act
        const gitExit = tryRunGitWithExit(['-C', dirs.theirs, 'rebase', '--continue'], {
          env: DATED_ENV,
        }).exitCode;
        const failure = await sut(tsgitAt(dirs.ours)).catch((err: unknown) => err);

        // Assert
        expect(gitExit).toBe(1);
        expect(failure).toMatchObject({ data: { code: 'WORKING_TREE_DIRTY', untracked: ['p'] } });
        expect(refusedResetState(dirs.ours)).toEqual(refusedResetState(dirs.theirs));
        expect(readGit(dirs.theirs, 'rebase-merge/git-rebase-todo')).toMatch(/^reset onto\n/);
      });
    });
  });

  describe.each(RESET_ROWS)(
    'Given $row.shape/$variant at a reset step over an occupant',
    ({
      row,
      variant,
    }: {
      row: AbortRow;
      variant: (typeof ABORT_ROWS)[number]['variants'][number];
    }) => {
      describe('When both tools continue the rebase', () => {
        it('Then the refusal, work tree, index and stop state match', async () => {
          // Arrange
          const dirs = setUp(
            `reset-${row.shape}-${variant}`,
            sideConflictingOnKeep(entriesOf(variant, row)),
          );
          await rebaseBoth(dirs, ['-r'], { upstream: 'main', rebaseMerges: true });
          const occupant =
            variant === 'reset-adds' ? (row.addOccupant ?? row.occupant) : row.occupant;
          for (const dir of [dirs.ours, dirs.theirs]) {
            writeFileSync(path.join(dir, 'keep'), 'a\n');
            dated(dir, 'add', 'keep');
            occupant(dir);
          }
          const sut = rebaseContinue;

          // Act
          const gitExit = tryRunGitWithExit(['-C', dirs.theirs, 'rebase', '--continue'], {
            env: DATED_ENV,
          }).exitCode;
          const failure = await sut(tsgitAt(dirs.ours)).then(
            () => undefined,
            (err: unknown) => err,
          );

          // Assert
          expect(failure !== undefined).toBe(gitExit !== 0);
          expect(listing(dirs.ours)).toEqual(listing(dirs.theirs));
          expect(indexState(dirs.ours)).toEqual(indexState(dirs.theirs));
          if (variant === 'reset-adds' && !GIT_DISPLACES_IGNORED_ADDS.has(row.shape)) {
            expect(gitExit).toBe(1);
            expect(readGit(dirs.theirs, 'rebase-merge/git-rebase-todo')).toMatch(/^reset /);
          }
          if (variant === 'reset-adds' && gitExit !== 0) {
            expect(resetStepState(dirs.ours)).toEqual(resetStepState(dirs.theirs));
          }
        });
      });
    },
  );
});
