/**
 * Cross-tool interop — linked-worktree, submodule, and `--separate-git-dir`
 * discovery. Builds each on-disk layout shape with canonical git, then proves
 * `openRepository`'s discovery walk resolves the identical `gitDir` /
 * `commonDir` pair git itself reports (`git rev-parse --git-dir
 * --git-common-dir`), and that read commands (`revParse`, `log`, `status`,
 * `diff`) agree with git run from the same cwd. Also pins the discovery
 * refusals (malformed / no-path / dangling gitfile) co-refused by both tools,
 * and the `repo.worktree.add` → `openRepository` round trip.
 *
 * @proves
 *   surface:        openRepository
 *   bucket:         cross-tool-interop
 *   unique:         linked-worktree, submodule and separate-git-dir discovery matches git rev-parse
 *   interopSurface: worktree
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const COMMIT_ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: AUTHOR.name,
  GIT_AUTHOR_EMAIL: AUTHOR.email,
  GIT_AUTHOR_DATE: `${AUTHOR.timestamp} ${AUTHOR.timezoneOffset}`,
  GIT_COMMITTER_NAME: AUTHOR.name,
  GIT_COMMITTER_EMAIL: AUTHOR.email,
  GIT_COMMITTER_DATE: `${AUTHOR.timestamp} ${AUTHOR.timezoneOffset}`,
};

const commit = (dir: string, message: string): void => {
  runGit(['-C', dir, 'commit', '-q', '-m', message], { env: COMMIT_ENV });
};

/** A fresh, realpath-resolved tmpdir root for one scenario group. */
const mkRoot = async (slug: string): Promise<string> =>
  realpath(await mkdtemp(path.join(os.tmpdir(), `tsgit-interop-lwd-${slug}-`)));

/** `git rev-parse --path-format=absolute --git-dir --git-common-dir`, split into a pair. */
const gitDirPair = (cwd: string): readonly [string, string] => {
  const [gitDir, commonDir] = git(
    cwd,
    'rev-parse',
    '--path-format=absolute',
    '--git-dir',
    '--git-common-dir',
  )
    .trim()
    .split('\n');
  if (gitDir === undefined || commonDir === undefined) {
    throw new Error(`unexpected rev-parse output for ${cwd}`);
  }
  return [gitDir, commonDir];
};

describe.skipIf(!GIT_AVAILABLE)('linked-worktree discovery interop', () => {
  describe('Given a git-built linked worktree checked out at HEAD~1 (scenarios A, D)', () => {
    let root: string;
    let wt: string;
    let repo: Repository;

    beforeAll(async () => {
      root = await mkRoot('a');
      const main = path.join(root, 'main');
      runGit(['init', '-q', '-b', 'main', main]);
      await writeFile(path.join(main, 'a.txt'), 'one\n');
      git(main, 'add', 'a.txt');
      commit(main, 'c1');
      await writeFile(path.join(main, 'a.txt'), 'two\n');
      git(main, 'add', 'a.txt');
      commit(main, 'c2');
      wt = path.join(root, 'wt');
      git(main, 'worktree', 'add', '-q', wt, 'HEAD~1');
      await mkdir(path.join(wt, 'sub', 'dir'), { recursive: true });
      repo = await openRepository({ cwd: wt });
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await repo?.dispose();
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    });

    describe('When opened at the worktree root (scenario A)', () => {
      it('Then layout.gitDir/commonDir match git rev-parse --git-dir --git-common-dir', () => {
        // Arrange
        const [expectedGitDir, expectedCommonDir] = gitDirPair(wt);

        // Act
        const result = repo.ctx.layout;

        // Assert
        expect(result.gitDir).toBe(expectedGitDir);
        expect(result.commonDir).toBe(expectedCommonDir);
      });

      it('Then revParse(HEAD) matches git rev-parse HEAD', async () => {
        // Arrange
        const expected = git(wt, 'rev-parse', 'HEAD').trim();

        // Act
        const result = await repo.revParse('HEAD');

        // Assert
        expect(result).toBe(expected);
      });

      it('Then log oids match git log --format=%H', async () => {
        // Arrange
        const expected = git(wt, 'log', '--format=%H').trim().split('\n');

        // Act
        const result = await repo.log();

        // Assert
        expect(result.map((entry) => entry.id)).toEqual(expected);
      });

      it('Then status reports clean, matching an empty git status --porcelain', async () => {
        // Arrange
        const expectedClean = git(wt, 'status', '--porcelain').trim() === '';

        // Act
        const result = await repo.status();

        // Assert
        expect(expectedClean).toBe(true);
        expect(result.clean).toBe(true);
      });

      it('Then diff(to: main) matches git diff --name-only HEAD main', async () => {
        // Arrange — HEAD (this worktree's detached commit, c1) vs the shared
        // branch tip main (c2, read from the common dir) differ by a.txt.
        const expectedPath = git(wt, 'diff', '--name-only', 'HEAD', 'main').trim();

        // Act
        const result = await repo.diff({ to: 'main' });

        // Assert
        expect(result.changes).toHaveLength(1);
        expect((result.changes[0] as { path: string }).path).toBe(expectedPath);
      });
    });

    describe('When opened at a nested sub-directory of the worktree (scenario D)', () => {
      it('Then findLayout walks up to the identical gitDir/commonDir pair', async () => {
        // Arrange
        const sub = path.join(wt, 'sub', 'dir');
        const [expectedGitDir, expectedCommonDir] = gitDirPair(wt);

        // Act
        const nested = await openRepository({ cwd: sub });
        try {
          // Assert
          expect(nested.ctx.layout.gitDir).toBe(expectedGitDir);
          expect(nested.ctx.layout.commonDir).toBe(expectedCommonDir);
          expect(await nested.revParse('HEAD')).toBe(await repo.revParse('HEAD'));
        } finally {
          await nested.dispose();
        }
      });
    });
  });

  describe('Given a real git submodule working directory (scenario E)', () => {
    let root: string;
    let mainDir: string;
    let submodulePath: string;

    beforeAll(async () => {
      root = await mkRoot('e');
      const subDir = path.join(root, 'sub');
      runGit(['init', '-q', '-b', 'main', subDir]);
      await writeFile(path.join(subDir, 's.txt'), 'sub\n');
      git(subDir, 'add', 's.txt');
      commit(subDir, 'sub commit');

      mainDir = path.join(root, 'main');
      runGit(['init', '-q', '-b', 'main', mainDir]);
      await writeFile(path.join(mainDir, 'r.txt'), 'root\n');
      git(mainDir, 'add', 'r.txt');
      commit(mainDir, 'root commit');
      runGit(
        [
          '-c',
          'protocol.file.allow=always',
          '-C',
          mainDir,
          'submodule',
          'add',
          '-q',
          '../sub',
          'sub',
        ],
        { env: COMMIT_ENV },
      );
      commit(mainDir, 'add submodule');
      submodulePath = path.join(mainDir, 'sub');
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    });

    describe('When opened at the submodule working directory', () => {
      it('Then revParse(HEAD) resolves the submodule HEAD, not the superproject HEAD', async () => {
        // Arrange
        const expectedSubHead = git(submodulePath, 'rev-parse', 'HEAD').trim();
        const superprojectHead = git(mainDir, 'rev-parse', 'HEAD').trim();
        const repo = await openRepository({ cwd: submodulePath });

        try {
          // Act
          const result = await repo.revParse('HEAD');

          // Assert
          expect(result).toBe(expectedSubHead);
          expect(result).not.toBe(superprojectHead);
        } finally {
          await repo.dispose();
        }
      });
    });
  });

  describe('Given a git init --separate-git-dir repository (scenario F)', () => {
    let root: string;
    let workDir: string;

    beforeAll(async () => {
      root = await mkRoot('f');
      workDir = path.join(root, 'work');
      const gitDir = path.join(root, 'sep.git');
      runGit(['init', '-q', '-b', 'main', `--separate-git-dir=${gitDir}`, workDir]);
      await writeFile(path.join(workDir, 'a.txt'), 'x\n');
      git(workDir, 'add', 'a.txt');
      commit(workDir, 'c1');
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    });

    describe('When opened at the working directory', () => {
      it('Then commonDir is absent and gitDir matches git --git-dir', async () => {
        // Arrange
        const [expectedGitDir] = gitDirPair(workDir);
        const repo = await openRepository({ cwd: workDir });

        try {
          // Act
          const result = repo.ctx.layout;

          // Assert
          expect(result.gitDir).toBe(expectedGitDir);
          expect(result.commonDir).toBeUndefined();
        } finally {
          await repo.dispose();
        }
      });

      it('Then revParse(HEAD) matches git rev-parse HEAD', async () => {
        // Arrange
        const expected = git(workDir, 'rev-parse', 'HEAD').trim();
        const repo = await openRepository({ cwd: workDir });

        try {
          // Act
          const result = await repo.revParse('HEAD');

          // Assert
          expect(result).toBe(expected);
        } finally {
          await repo.dispose();
        }
      });
    });
  });

  describe('Given an outer repo with malformed / no-path / dangling inner gitfiles (scenario G)', () => {
    let root: string;
    let outer: string;

    beforeAll(async () => {
      root = await mkRoot('g');
      outer = path.join(root, 'outer');
      runGit(['init', '-q', '-b', 'main', outer]);
      await writeFile(path.join(outer, 'a.txt'), 'x\n');
      git(outer, 'add', 'a.txt');
      commit(outer, 'c1');

      for (const name of ['malformed', 'nopath', 'dangling']) {
        await mkdir(path.join(outer, name));
      }
      await writeFile(path.join(outer, 'malformed', '.git'), 'gitdir:nospace\n');
      await writeFile(path.join(outer, 'nopath', '.git'), 'gitdir: \n');
      await writeFile(path.join(outer, 'dangling', '.git'), 'gitdir: /nonexistent/path\n');
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    });

    /** Opens `dir` and returns the rejection — fails the test if it resolves. */
    const openAndCatch = async (dir: string): Promise<unknown> => {
      try {
        await openRepository({ cwd: dir });
      } catch (err) {
        return err;
      }
      expect.unreachable('expected openRepository to reject');
    };

    /**
     * tsgit throws the structured refusal with the exact path, and canonical
     * git co-refuses with exit 128; neither falls back to the enclosing
     * (valid) outer repository.
     */
    const assertRefused = (
      caught: unknown,
      dir: string,
      expectedCode: string,
      expectedPath: string,
    ): void => {
      const data = (caught as { data: { code: string; path: string } }).data;
      expect(data.code).toBe(expectedCode);
      expect(data.path).toBe(expectedPath);
      expect(tryRunGitWithExit(['-C', dir, 'rev-parse', '--git-dir']).exitCode).toBe(128);
    };

    describe('When opened at a directory whose .git file lacks the gitdir: prefix', () => {
      it('Then tsgit throws GITFILE_INVALID_FORMAT with the gitfile path', async () => {
        // Arrange
        const dir = path.join(outer, 'malformed');

        // Act
        const caught = await openAndCatch(dir);

        // Assert
        assertRefused(caught, dir, 'GITFILE_INVALID_FORMAT', path.join(dir, '.git'));
      });
    });

    describe('When opened at a directory whose .git file has an empty path', () => {
      it('Then tsgit throws GITFILE_NO_PATH with the gitfile path', async () => {
        // Arrange
        const dir = path.join(outer, 'nopath');

        // Act
        const caught = await openAndCatch(dir);

        // Assert
        assertRefused(caught, dir, 'GITFILE_NO_PATH', path.join(dir, '.git'));
      });
    });

    describe('When opened at a directory whose .git file points at a non-existent target', () => {
      it('Then tsgit throws NOT_A_REPOSITORY with the worktree directory path', async () => {
        // Arrange
        const dir = path.join(outer, 'dangling');

        // Act
        const caught = await openAndCatch(dir);

        // Assert
        assertRefused(caught, dir, 'NOT_A_REPOSITORY', dir);
      });
    });
  });

  describe('Given a tsgit repo (scenario H)', () => {
    describe('When repo.worktree.add creates a worktree, then openRepository opens it', () => {
      it('Then git and tsgit agree on --git-dir/--git-common-dir', async () => {
        // Arrange
        const root = await mkRoot('h');
        const mainDir = path.join(root, 'main');
        await mkdir(mainDir, { recursive: true });
        const repo = await openRepository({ cwd: mainDir });
        try {
          await repo.init();
          await writeFile(path.join(mainDir, 'a.txt'), 'x\n');
          await repo.add(['a.txt']);
          await repo.commit({ message: 'c1', author: AUTHOR });
          const wt = path.join(root, 'wt');

          // Act
          await repo.worktree.add({ path: wt, branch: 'wt' });
          const opened = await openRepository({ cwd: wt });
          try {
            const [expectedGitDir, expectedCommonDir] = gitDirPair(wt);

            // Assert
            expect(opened.ctx.layout.gitDir).toBe(expectedGitDir);
            expect(opened.ctx.layout.commonDir).toBe(expectedCommonDir);
          } finally {
            await opened.dispose();
          }
        } finally {
          await repo.dispose();
          await rm(root, { recursive: true, force: true });
        }
      });
    });
  });
});
