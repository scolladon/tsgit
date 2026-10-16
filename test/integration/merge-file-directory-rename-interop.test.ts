/**
 * Cross-tool interop — one side renames `q` to `p/x` while the other edits `q`
 * and adds a file `p`. The rename carries the edit under `p/`, so the added
 * file is in the way of a directory: git moves it to `p~<label>` as a
 * file/directory conflict and keeps `p/x` merged at stage 0. tsgit must leave
 * the same index stages.
 *
 * @proves
 *   surface:        merge
 *   bucket:         cross-tool-interop
 *   unique:         a file blocking a rename-carried path steps aside like git
 *   interopSurface: merge
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  initBothRepos,
  lsStage,
  makePeerPair,
  type PeerPair,
  runGit,
  runGitEnv,
  tryRunGit,
} from './interop-helpers.js';

const COMMIT_ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_DATE: '2024-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2024-01-01T00:00:00Z',
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
};

const BASE_LINES = ['one', 'two', 'three', 'four', 'five', 'six'];

const content = (lines: ReadonlyArray<string>): string => `${lines.join('\n')}\n`;

const gitAt = (dir: string, ...args: ReadonlyArray<string>): string =>
  runGit(['-C', dir, ...args], { env: COMMIT_ENV });

type Branch = 'main' | 'side';

interface Scenario {
  readonly renamingBranch: Branch;
  readonly renameEdits: boolean;
}

const renameQ = (dir: string, renameEdits: boolean): void => {
  mkdirSync(join(dir, 'p'));
  gitAt(dir, 'mv', 'q', 'p/x');
  if (renameEdits) writeFileSync(join(dir, 'p', 'x'), content([...BASE_LINES.slice(0, 5), 'SIX']));
  gitAt(dir, 'commit', '-q', '-am', 'rename');
};

const editQAndAddP = (dir: string): void => {
  writeFileSync(join(dir, 'q'), content(['ONE', ...BASE_LINES.slice(1)]));
  writeFileSync(join(dir, 'p'), 'file\n');
  gitAt(dir, 'add', 'q', 'p');
  gitAt(dir, 'commit', '-q', '-m', 'edit and add');
};

/** Builds `scenario` on main and side, leaving main checked out. */
const seed = (dir: string, { renamingBranch, renameEdits }: Scenario): void => {
  gitAt(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'q'), content(BASE_LINES));
  gitAt(dir, 'add', 'q');
  gitAt(dir, 'commit', '-q', '-m', 'base');
  gitAt(dir, 'branch', 'side');
  const order: ReadonlyArray<Branch> = ['side', 'main'];
  for (const branch of order) {
    gitAt(dir, 'checkout', '-q', branch);
    if (branch === renamingBranch) renameQ(dir, renameEdits);
    else editQAndAddP(dir);
  }
};

describe.skipIf(!GIT_AVAILABLE)('merge file/directory rename interop', { timeout: 60_000 }, () => {
  let pair: PeerPair;
  let repo: Repository | undefined;

  beforeEach(async () => {
    pair = await makePeerPair('merge-fd-rename');
    initBothRepos(pair.peer, pair.ours);
  });

  afterEach(async () => {
    await repo?.dispose();
    repo = undefined;
    await pair.dispose();
  });

  describe.each([
    { renamingBranch: 'side', renameEdits: false, moved: 'p~HEAD', stage: 2 },
    { renamingBranch: 'side', renameEdits: true, moved: 'p~HEAD', stage: 2 },
    { renamingBranch: 'main', renameEdits: false, moved: 'p~side', stage: 3 },
    { renamingBranch: 'main', renameEdits: true, moved: 'p~side', stage: 3 },
  ] as const)(
    'Given $renamingBranch renames q to p/x (edited: $renameEdits) and the other branch edits q and adds a file p',
    (scenario) => {
      describe('When merging side into main', () => {
        it('Then tsgit moves p aside and records the same index stages as git', async () => {
          // Arrange
          seed(pair.peer, scenario);
          seed(pair.ours, scenario);
          const gitRun = tryRunGit(['-C', pair.peer, 'merge', 'side'], { env: COMMIT_ENV });
          repo = await openRepository({ cwd: pair.ours });
          const sut = repo.merge;

          // Act
          const result = await sut.run({ rev: 'side' });

          // Assert
          expect(gitRun.ok).toBe(false);
          expect(result).toMatchObject({
            kind: 'conflict',
            conflicts: [{ path: 'p', type: 'file-directory' }],
          });
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
          expect(lsStage(pair.ours)).toMatch(
            new RegExp(
              `^100644 [0-9a-f]{40} 0\\tp/x\\n100644 [0-9a-f]{40} ${scenario.stage}\\t${scenario.moved}\\n$`,
            ),
          );
        });
      });
    },
  );
});
