/**
 * Cross-tool interop — a merge whose conflict would rename a side onto a path
 * the index refuses (`git~1`, the NTFS 8.3 alias of `.git`). Real git fails the
 * merge before touching the index or the work tree; tsgit must do the same.
 *
 * @proves
 *   surface:        merge
 *   bucket:         cross-tool-interop
 *   unique:         a conflict rename onto an invalid path refuses like git
 *   interopSurface: merge
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  git,
  initBothRepos,
  lsStage,
  makePeerPair,
  type PeerPair,
  runGitEnv,
  tryRunGit,
} from './interop-helpers.js';

const COMMIT_ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
};

/** main: directory git/; branch 1: file git — the merge renames the file to git~1. */
const seedFileDirectory = (dir: string): void => {
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', '1');
  writeFileSync(join(dir, 'git'), 'file\n');
  git(dir, 'add', 'git');
  git(dir, 'commit', '-q', '-m', 'theirs');
  git(dir, 'checkout', '-q', 'main');
  mkdirSync(join(dir, 'git'));
  writeFileSync(join(dir, 'git', 'x'), 'dir\n');
  git(dir, 'add', 'git/x');
  git(dir, 'commit', '-q', '-m', 'ours');
};

describe.skipIf(!GIT_AVAILABLE)('merge conflict rename path interop', { timeout: 60_000 }, () => {
  let pair: PeerPair;
  let repo: Repository | undefined;

  beforeEach(async () => {
    pair = await makePeerPair('merge-conflict-rename');
    initBothRepos(pair.peer, pair.ours);
  });

  afterEach(async () => {
    await repo?.dispose();
    repo = undefined;
    await pair.dispose();
  });

  describe('Given ours holds a directory git/ and branch 1 holds a file git', () => {
    describe('When merging branch 1', () => {
      it('Then tsgit refuses like git and leaves the index and HEAD untouched', async () => {
        // Arrange
        seedFileDirectory(pair.peer);
        seedFileDirectory(pair.ours);
        const headBefore = git(pair.ours, 'rev-parse', 'HEAD');
        const indexBefore = lsStage(pair.ours);
        const gitRun = tryRunGit(['-C', pair.peer, 'merge', '1'], { env: COMMIT_ENV });
        repo = await openRepository({ cwd: pair.ours });
        const sut = repo.merge;

        // Act
        const tsgitRun = await sut.run({ rev: '1' }).then(
          () => true,
          () => false,
        );

        // Assert
        expect(gitRun.ok).toBe(false);
        expect(tsgitRun).toBe(false);
        expect(lsStage(pair.peer)).toBe(indexBefore);
        expect(lsStage(pair.ours)).toBe(indexBefore);
        expect(git(pair.peer, 'rev-parse', 'HEAD')).toBe(headBefore);
        expect(git(pair.ours, 'rev-parse', 'HEAD')).toBe(headBefore);
      });
    });
  });
});
