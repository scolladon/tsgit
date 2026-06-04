/**
 * Cross-tool interop — `readFileAt(rev, path)`. Builds a two-commit repo with
 * canonical `git` (a nested file, an executable, a symlink), then opens the SAME
 * repo through `openRepository` and proves that reading a file as of a revision
 * matches `git cat-file blob <rev>:<path>` byte-for-byte, that the tree-entry
 * mode matches `git ls-tree`, and that a directory / missing path refuses exactly
 * where canonical git does.
 *
 * @proves
 *   surface:        readFileAt
 *   bucket:         cross-tool-interop
 *   unique:         <rev>:<path> blob bytes + mode + refusals match canonical git
 *   interopSurface: readFileAt
 */
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TsgitError } from '../../src/domain/error.js';
import { openRepository } from '../../src/index.node.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv, tryRunGit } from './interop-helpers.js';

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
} as const;

const dateEnv = (epoch: number): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  ...IDENTITY,
  GIT_AUTHOR_DATE: `${epoch} +0000`,
  GIT_COMMITTER_DATE: `${epoch} +0000`,
});

const dec = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe.skipIf(!GIT_AVAILABLE)('read-file-at interop', () => {
  let dir: string;
  let repo: Awaited<ReturnType<typeof openRepository>>;

  const catBlob = (spec: string): string => git(dir, 'cat-file', 'blob', spec);
  const gitMode = (rev: string, file: string): string =>
    git(dir, 'ls-tree', rev, file).split(/\s+/)[0] ?? '';

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-read-file-at-interop-')));
    runGit(['init', '-q', '-b', 'main', dir]);

    await writeFile(path.join(dir, 'a.txt'), 'old\n');
    git(dir, 'add', '.');
    runGit(['-C', dir, 'commit', '-q', '-m', 'parent'], { env: dateEnv(1700000001) });

    await writeFile(path.join(dir, 'a.txt'), 'hello\n');
    await mkdir(path.join(dir, 'dir'), { recursive: true });
    await writeFile(path.join(dir, 'dir', 'nested.txt'), 'deep\n');
    await writeFile(path.join(dir, 'run.sh'), '#!/bin/sh\necho hi\n');
    await chmod(path.join(dir, 'run.sh'), 0o755);
    await symlink('a.txt', path.join(dir, 'link'));
    git(dir, 'add', '.');
    runGit(['-C', dir, 'commit', '-q', '-m', 'child'], { env: dateEnv(1700000002) });

    repo = await openRepository({ cwd: dir });
  }, 60_000);

  afterAll(async () => {
    await repo?.dispose();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  describe('Given a committed file at HEAD', () => {
    describe('When readFileAt reads it', () => {
      it('Then the bytes equal git cat-file blob HEAD:<path>', async () => {
        // Act
        const sut = await repo.readFileAt('HEAD', 'a.txt');
        // Assert
        expect(dec(sut.content)).toBe(catBlob('HEAD:a.txt'));
      });
    });
  });

  describe('Given a nested committed file', () => {
    describe('When readFileAt reads the deep path', () => {
      it('Then the bytes equal git cat-file blob HEAD:dir/nested.txt', async () => {
        // Act
        const sut = await repo.readFileAt('HEAD', 'dir/nested.txt');
        // Assert
        expect(dec(sut.content)).toBe(catBlob('HEAD:dir/nested.txt'));
      });
    });
  });

  describe('Given a parent-relative rev HEAD~1', () => {
    describe('When readFileAt reads a file', () => {
      it('Then the bytes equal git cat-file blob HEAD~1:<path>', async () => {
        // Act
        const sut = await repo.readFileAt('HEAD~1', 'a.txt');
        // Assert
        expect(dec(sut.content)).toBe(catBlob('HEAD~1:a.txt'));
      });
    });
  });

  describe('Given an executable file', () => {
    describe('When readFileAt reads it', () => {
      it('Then the mode equals git ls-tree (100755)', async () => {
        // Act
        const sut = await repo.readFileAt('HEAD', 'run.sh');
        // Assert
        expect(sut.mode).toBe(gitMode('HEAD', 'run.sh'));
        expect(sut.mode).toBe('100755');
      });
    });
  });

  describe('Given a symlink entry', () => {
    describe('When readFileAt reads it', () => {
      it('Then the mode is 120000 and the content is the link target', async () => {
        // Act
        const sut = await repo.readFileAt('HEAD', 'link');
        // Assert
        expect(sut.mode).toBe(gitMode('HEAD', 'link'));
        expect(sut.mode).toBe('120000');
        expect(dec(sut.content)).toBe('a.txt');
      });
    });
  });

  describe('Given a directory path', () => {
    describe('When readFileAt reads it', () => {
      it('Then it refuses where git cat-file blob also refuses', async () => {
        // Arrange — canonical git refuses `<rev>:<dir>` as not-a-blob
        expect(tryRunGit(['-C', dir, 'cat-file', 'blob', 'HEAD:dir']).ok).toBe(false);
        // Act / Assert
        try {
          await repo.readFileAt('HEAD', 'dir');
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('UNEXPECTED_OBJECT_TYPE');
        }
      });
    });
  });

  describe('Given a path absent from the tree', () => {
    describe('When readFileAt reads it', () => {
      it('Then it refuses where git cat-file blob also refuses', async () => {
        // Arrange — canonical git refuses a path not in the tree
        expect(tryRunGit(['-C', dir, 'cat-file', 'blob', 'HEAD:nope']).ok).toBe(false);
        // Act / Assert
        try {
          await repo.readFileAt('HEAD', 'nope');
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('PATH_NOT_IN_TREE');
        }
      });
    });
  });
});
