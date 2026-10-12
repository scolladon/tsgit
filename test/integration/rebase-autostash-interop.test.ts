/**
 * Cross-tool `rebase --autostash` interop: both tools stash a dirty tree under a
 * pinned clock (byte-identical stash commits), rebase, and re-apply it — cleanly,
 * into a conflict that stores the stash, or across a stop and its abort.
 *
 * @writes
 *   surface: rebase
 *   kind:    byte-identical
 *   format:  rebase-merge-state
 *
 * @proves
 *   surface:        rebase, rebase.abort
 *   bucket:         cross-tool-interop
 *   unique:         a --autostash rebase stashes, records and re-applies local changes exactly as git does, storing the stash when the re-apply conflicts
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
import { rebaseAbort, rebaseRun } from '../../src/application/commands/rebase.js';
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
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tsgit-interop-rebase-autostash-')));
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
});

/** topic: base, f, t1; main: base, f, then u1, a rewrite of f, or a clashing t1. */
const shape = (dir: string, upstream: 'u1' | 'f' | 't1'): void => {
  commitFile(dir, 'base');
  commitFile(dir, 'f');
  dated(dir, 'checkout', '-q', '-b', 'topic');
  commitFile(dir, 't1');
  dated(dir, 'checkout', '-q', 'main');
  commitFile(dir, upstream, 'up\n');
  dated(dir, 'checkout', '-q', 'topic');
  writeFileSync(path.join(dir, 'f'), 'dirty\n');
};

const setUp = (label: string, upstream: 'u1' | 'f' | 't1') => {
  const dirs = {
    ours: path.join(root, `${label}-ours`),
    theirs: path.join(root, `${label}-theirs`),
  };
  for (const dir of [dirs.ours, dirs.theirs]) {
    runGit(['init', '-q', '-b', 'main', dir], { env: DATED_ENV });
    dated(dir, 'config', 'user.name', 't');
    dated(dir, 'config', 'user.email', 't@t');
    shape(dir, upstream);
  }
  return dirs;
};

const readGit = (dir: string, name: string): string | undefined => {
  const file = path.join(dir, '.git', name);
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
};

const state = (dir: string) => ({
  log: git(dir, 'log', '--format=%H %P %s', 'HEAD'),
  headLog: git(dir, 'reflog', '--format=%H %gs', 'HEAD'),
  stash: tryRunGitWithExit(['-C', dir, 'reflog', '--format=%H %gs', 'refs/stash']).stdout,
  autostash: readGit(dir, 'rebase-merge/autostash'),
  status: git(dir, 'status', '--porcelain'),
  f: readFileSync(path.join(dir, 'f'), 'utf8'),
});

const tsgitAt = (dir: string) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(EPOCH * 1000);
  return createNodeContext({ workDir: dir });
};

const rebaseBoth = async (dirs: { ours: string; theirs: string }): Promise<void> => {
  tryRunGitWithExit(['-C', dirs.theirs, 'rebase', '--autostash', 'main'], { env: DATED_ENV });
  await rebaseRun(tsgitAt(dirs.ours), { upstream: 'main', autostash: true });
};

describe.skipIf(!GIT_AVAILABLE)('rebase --autostash interop', () => {
  describe.each([
    { label: 'a clean re-apply', upstream: 'u1' as const },
    { label: 'a conflicting re-apply', upstream: 'f' as const },
    { label: 'a stop on a conflicting pick', upstream: 't1' as const },
  ])('Given a dirty tree and $label', ({ upstream }) => {
    describe('When both tools rebase with autostash', () => {
      it('Then the stash, its re-apply and the refs agree', async () => {
        // Arrange
        const dirs = setUp(`autostash-${upstream}`, upstream);
        const sut = rebaseBoth;

        // Act
        await sut(dirs);

        // Assert
        expect(state(dirs.ours)).toEqual(state(dirs.theirs));
      });
    });
  });

  describe('Given a stopped autostash rebase, When both tools abort', () => {
    it('Then both re-apply the stash', async () => {
      // Arrange
      const dirs = setUp('autostash-abort', 't1');
      await rebaseBoth(dirs);
      const sut = rebaseAbort;

      // Act
      tryRunGitWithExit(['-C', dirs.theirs, 'rebase', '--abort'], { env: DATED_ENV });
      await sut(tsgitAt(dirs.ours));

      // Assert
      expect(state(dirs.ours)).toEqual(state(dirs.theirs));
    });
  });
});
