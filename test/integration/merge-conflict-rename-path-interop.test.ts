/**
 * Cross-tool interop — a merge whose conflict would rename a side onto a path
 * the index refuses (`git~1`, the NTFS 8.3 alias of `.git`), or write a
 * `.gitmodules` symlink. Real git fails the merge before touching the index or
 * the work tree; tsgit must do the same. Each written path is checked with the
 * mode it is written with, so a regular `gitmod~1` beside a symlink `gitmod`
 * is a plain conflict for both.
 *
 * @proves
 *   surface:        merge
 *   bucket:         cross-tool-interop
 *   unique:         a conflict rename onto an invalid path refuses like git
 *   interopSurface: merge
 */
import { lstatSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
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

/**
 * main (ours) holds `name` as `oursKind`; branch 1 holds it as the other kind.
 * Branch 1 is built with plumbing, since git itself refuses to `add` a symlink
 * `.gitmodules`.
 */
const seedKinds = (dir: string, name: string, oursKind: 'regular' | 'symlink'): void => {
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'readme'), 'base\n');
  git(dir, 'add', 'readme');
  git(dir, 'commit', '-q', '-m', 'base');
  const readme = git(dir, 'rev-parse', 'HEAD:readme').trim();
  const blob = runGit(['-C', dir, 'hash-object', '-w', '--stdin'], {
    input: 'target',
    env: COMMIT_ENV,
  }).trim();
  const theirsMode = oursKind === 'regular' ? '120000' : '100644';
  const tree = runGit(['-C', dir, 'mktree'], {
    input: `100644 blob ${readme}\treadme\n${theirsMode} blob ${blob}\t${name}\n`,
    env: COMMIT_ENV,
  }).trim();
  const theirs = runGit(
    ['-C', dir, 'commit-tree', tree, '-p', git(dir, 'rev-parse', 'HEAD').trim(), '-m', 'theirs'],
    { env: COMMIT_ENV },
  ).trim();
  git(dir, 'branch', '1', theirs);
  if (oursKind === 'symlink') symlinkSync('target', join(dir, name));
  else writeFileSync(join(dir, name), 'target');
  git(dir, 'add', name);
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
        const peerHeadBefore = git(pair.peer, 'rev-parse', 'HEAD');
        const oursHeadBefore = git(pair.ours, 'rev-parse', 'HEAD');
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
        expect(lsStage(pair.peer)).toBe(lsStage(pair.ours));
        expect(lsStage(pair.ours)).toBe(indexBefore);
        expect(git(pair.peer, 'rev-parse', 'HEAD')).toBe(peerHeadBefore);
        expect(git(pair.ours, 'rev-parse', 'HEAD')).toBe(oursHeadBefore);
      });
    });
  });

  describe('Given ours holds a regular .gitmodules and branch 1 holds a symlink .gitmodules', () => {
    describe('When merging branch 1', () => {
      it('Then tsgit refuses like git and leaves the index and work tree untouched', async () => {
        // Arrange
        seedKinds(pair.peer, '.gitmodules', 'regular');
        seedKinds(pair.ours, '.gitmodules', 'regular');
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
        expect(lstatSync(join(pair.ours, '.gitmodules')).isSymbolicLink()).toBe(false);
        expect(() => lstatSync(join(pair.ours, '.gitmodules~HEAD'))).toThrow();
      });
    });
  });

  describe('Given ours holds a symlink gitmod and branch 1 holds a regular gitmod', () => {
    describe('When merging branch 1', () => {
      it('Then tsgit records the same conflict stages as git', async () => {
        // Arrange
        seedKinds(pair.peer, 'gitmod', 'symlink');
        seedKinds(pair.ours, 'gitmod', 'symlink');
        tryRunGit(['-C', pair.peer, 'merge', '1'], { env: COMMIT_ENV });
        repo = await openRepository({ cwd: pair.ours });
        const sut = repo.merge;

        // Act
        const result = await sut.run({ rev: '1' });

        // Assert
        expect(result.kind).toBe('conflict');
        expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
        expect(lstatSync(join(pair.ours, 'gitmod')).isSymbolicLink()).toBe(true);
        expect(lstatSync(join(pair.ours, 'gitmod~1')).isFile()).toBe(true);
      });
    });
  });
});
