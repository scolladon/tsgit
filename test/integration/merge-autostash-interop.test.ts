/**
 * Cross-tool `merge --autostash` interop: both tools stash a dirty tree under a
 * pinned clock (byte-identical stash commits) as `MERGE_AUTOSTASH`, then
 * re-apply it when the merge concludes, commits or aborts, or file it in the
 * stash list when a hard reset drops the merge state.
 *
 * @writes
 *   surface: branch-state
 *   kind:    byte-identical
 *   format:  git-merge-state-files
 *
 * @proves
 *   surface:        merge, merge.abort, commit, reset
 *   bucket:         cross-tool-interop
 *   unique:         a --autostash merge stashes into MERGE_AUTOSTASH and re-applies, or saves, it at the same points git does
 *   interopSurface: mergeState, reflog
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
import { mergeAbort } from '../../src/application/commands/abort-merge.js';
import { add } from '../../src/application/commands/add.js';
import { commit } from '../../src/application/commands/commit.js';
import { mergeRun } from '../../src/application/commands/merge.js';
import { reset } from '../../src/application/commands/reset.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const EPOCH = 1_700_000_000;
const IDENTITY = { name: 't', email: 't@t', timestamp: EPOCH, timezoneOffset: '+0000' };
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

let root: string;

const dated = (dir: string, ...args: ReadonlyArray<string>): string =>
  runGit(['-C', dir, ...args], { env: DATED_ENV });

const commitFile = (dir: string, file: string, body: string): void => {
  writeFileSync(path.join(dir, file), body);
  dated(dir, 'add', file);
  dated(dir, 'commit', '-q', '-m', `${file} ${body.trim()}`);
};

beforeAll(() => {
  if (!GIT_AVAILABLE) return;
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tsgit-interop-merge-autostash-')));
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
});

type Shape = 'fast-forward' | 'clean' | 'conflict';

/** side rewrites f; main stays (fast-forward), adds g (clean) or rewrites f (conflict); u is dirtied. */
const shape = (dir: string, kind: Shape): void => {
  commitFile(dir, 'f', 'base\n');
  commitFile(dir, 'u', 'u\n');
  dated(dir, 'checkout', '-q', '-b', 'side');
  commitFile(dir, 'f', 'side\n');
  dated(dir, 'checkout', '-q', 'main');
  if (kind === 'clean') commitFile(dir, 'g', 'main\n');
  if (kind === 'conflict') commitFile(dir, 'f', 'main\n');
  writeFileSync(path.join(dir, 'u'), 'dirty\n');
};

const setUp = (label: string, kind: Shape) => {
  const dirs = {
    ours: path.join(root, `${label}-ours`),
    theirs: path.join(root, `${label}-theirs`),
  };
  for (const dir of [dirs.ours, dirs.theirs]) {
    runGit(['init', '-q', '-b', 'main', dir], { env: DATED_ENV });
    dated(dir, 'config', 'user.name', 't');
    dated(dir, 'config', 'user.email', 't@t');
    shape(dir, kind);
  }
  return dirs;
};

const readGit = (dir: string, name: string): string | undefined => {
  const file = path.join(dir, '.git', name);
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
};

const state = (dir: string) => ({
  log: git(dir, 'log', '--format=%H %P %s', 'HEAD'),
  stash: tryRunGitWithExit(['-C', dir, 'reflog', '--format=%H %gs', 'refs/stash']).stdout,
  autostash: readGit(dir, 'MERGE_AUTOSTASH'),
  mergeHead: readGit(dir, 'MERGE_HEAD'),
  status: git(dir, 'status', '--porcelain'),
  u: readFileSync(path.join(dir, 'u'), 'utf8'),
});

const tsgitAt = (dir: string): Context => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(EPOCH * 1000);
  return createNodeContext({ workDir: dir });
};

const mergeBoth = async (dirs: { ours: string; theirs: string }): Promise<Context> => {
  tryRunGitWithExit(['-C', dirs.theirs, 'merge', '--autostash', 'side'], { env: DATED_ENV });
  const ctx = tsgitAt(dirs.ours);
  await mergeRun(ctx, { rev: 'side', autostash: true, author: IDENTITY, committer: IDENTITY });
  return ctx;
};

describe.skipIf(!GIT_AVAILABLE)('merge --autostash interop', () => {
  describe.each([
    { kind: 'fast-forward' as const },
    { kind: 'clean' as const },
    { kind: 'conflict' as const },
  ])('Given a dirty tree and a $kind merge', ({ kind }) => {
    describe('When both tools merge with autostash', () => {
      it('Then the stash, its re-apply or keeping, and the refs agree', async () => {
        // Arrange
        const dirs = setUp(`merge-${kind}`, kind);
        const sut = mergeBoth;

        // Act
        await sut(dirs);

        // Assert
        expect(state(dirs.ours)).toEqual(state(dirs.theirs));
      });
    });
  });

  describe.each([
    {
      label: 'the resolution is committed',
      git: (dir: string) => {
        writeFileSync(path.join(dir, 'f'), 'resolved\n');
        dated(dir, 'add', 'f');
        dated(dir, 'commit', '-q', '-m', 'merged');
      },
      tsgit: async (ctx: Context, dir: string) => {
        writeFileSync(path.join(dir, 'f'), 'resolved\n');
        await add(ctx, ['f']);
        await commit(ctx, { message: 'merged', author: IDENTITY, committer: IDENTITY });
      },
    },
    {
      label: 'the merge is aborted',
      git: (dir: string) => void dated(dir, 'merge', '--abort'),
      tsgit: async (ctx: Context) => void (await mergeAbort(ctx)),
    },
    {
      label: 'the tree is hard-reset',
      git: (dir: string) => void dated(dir, 'reset', '-q', '--hard'),
      tsgit: async (ctx: Context) => void (await reset(ctx, { mode: 'hard', rev: 'HEAD' })),
    },
  ])('Given an autostash merge stopped on a conflict', ({ label, git: gitStep, tsgit }) => {
    describe(`When ${label} by both tools`, () => {
      it('Then the autostash ends up in the same place', async () => {
        // Arrange
        const dirs = setUp(`merge-end-${label.split(' ').at(-1)}`, 'conflict');
        const ctx = await mergeBoth(dirs);
        const sut = tsgit;

        // Act
        gitStep(dirs.theirs);
        await sut(ctx, dirs.ours);

        // Assert
        expect(state(dirs.ours)).toEqual(state(dirs.theirs));
      });
    });
  });
});
