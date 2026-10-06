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
});
