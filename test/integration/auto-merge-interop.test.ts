/**
 * Cross-tool interop — `AUTO_MERGE` after a conflicted ort merge. git's
 * `merge_switch_to_result` records the conflicted result tree (clean entries
 * plus each conflicted file's marked bytes) in `AUTO_MERGE`. Every row builds
 * the same history in two repositories, stops one operation on a conflict in
 * each tool, and compares the tree `AUTO_MERGE` names.
 *
 * @proves
 *   surface:        merge, cherryPick, revert, rebase
 *   bucket:         cross-tool-interop
 *   unique:         a conflicted ort merge records git's result tree in AUTO_MERGE
 *   interopSurface: merge
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
};

let root: string;

const dated = (dir: string, ...args: ReadonlyArray<string>): string =>
  runGit(['-C', dir, ...args], { env: DATED_ENV });

const commit = (dir: string, content: string, message: string): void => {
  writeFileSync(path.join(dir, 'f'), `${content}\n`);
  writeFileSync(path.join(dir, `${message}.txt`), `${message}\n`);
  dated(dir, 'add', '.');
  dated(dir, 'commit', '-q', '-m', message);
};

/** base → side changes f one way, main another; main then gains m2. */
const setUp = (dir: string): void => {
  runGit(['init', '-q', '-b', 'main', dir], { env: DATED_ENV });
  dated(dir, 'config', 'user.name', 'A');
  dated(dir, 'config', 'user.email', 'a@x');
  commit(dir, 'base', 'base');
  dated(dir, 'checkout', '-q', '-b', 'side');
  commit(dir, 'side', 'side');
  dated(dir, 'checkout', '-q', 'main');
  commit(dir, 'main', 'main');
  commit(dir, 'm2', 'm2');
};

interface Row {
  readonly label: string;
  readonly gitArgs: ReadonlyArray<string>;
  readonly prepare?: ReadonlyArray<string>;
  readonly run: (repo: Repository) => Promise<unknown>;
}

const ROWS: ReadonlyArray<Row> = [
  { label: 'merge', gitArgs: ['merge', 'side'], run: (repo) => repo.merge.run({ rev: 'side' }) },
  {
    label: 'cherry-pick',
    gitArgs: ['cherry-pick', 'side'],
    run: (repo) => repo.cherryPick.run({ commits: ['side'] }),
  },
  {
    label: 'revert',
    gitArgs: ['revert', '--no-edit', 'HEAD~1'],
    run: (repo) => repo.revert.run({ commits: ['HEAD~1'] }),
  },
  {
    label: 'rebase',
    prepare: ['checkout', '-q', 'side'],
    gitArgs: ['rebase', 'main'],
    run: (repo) => repo.rebase.run({ upstream: 'main' }),
  },
];

const autoMerge = (dir: string): string =>
  readFileSync(path.join(dir, '.git', 'AUTO_MERGE'), 'utf8');

beforeAll(() => {
  if (!GIT_AVAILABLE) return;
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tsgit-interop-auto-merge-')));
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe.skipIf(!GIT_AVAILABLE)('AUTO_MERGE interop', () => {
  describe.each(ROWS)('Given a $label that conflicts', ({ label, gitArgs, prepare, run }) => {
    describe('When both tools stop on the conflict', () => {
      it(
        'Then AUTO_MERGE names the same conflicted result tree',
        async () => {
          // Arrange
          const theirs = path.join(root, `${label}-git`);
          const ours = path.join(root, `${label}-ts`);
          for (const dir of [theirs, ours]) {
            setUp(dir);
            if (prepare !== undefined) dated(dir, ...prepare);
          }
          vi.useFakeTimers({ toFake: ['Date'] });
          vi.setSystemTime(EPOCH * 1000);
          const repo = await openRepository({ cwd: ours });
          const sut = run;

          // Act
          const gitResult = tryRunGitWithExit(['-C', theirs, ...gitArgs], { env: DATED_ENV });
          await sut(repo);

          // Assert
          expect(gitResult.exitCode).not.toBe(0);
          expect(autoMerge(ours)).toBe(autoMerge(theirs));
        },
        ROW_TIMEOUT,
      );
    });
  });
});
