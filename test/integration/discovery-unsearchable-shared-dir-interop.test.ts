/**
 * Cross-tool interop — discovery of a repository whose shared `objects/` or
 * `refs/` directory is not searchable. Canonical git's `is_git_directory`
 * runs `access(X_OK)` on both, so a mode-000 or read-only (0400) directory
 * makes `git rev-parse --git-dir` exit 128 while a search-only (0300, 0100)
 * directory is accepted. Proves `openRepository` refuses (gitfile route) and
 * climbs past (walk route) the same shapes git does, and accepts the rest.
 *
 * @proves
 *   surface:        openRepository
 *   bucket:         cross-tool-interop
 *   unique:         unsearchable shared-dir discovery matches git rev-parse
 *   interopSurface: init
 */
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GIT_AVAILABLE, git, runGit, tryRunGitWithExit } from './interop-helpers.js';
import { trackedRepositories } from './repository-lifecycle.js';

const SETUP_TIMEOUT = 60_000;
const POSIX = process.platform !== 'win32';
const UNPRIVILEGED = POSIX && process.getuid?.() !== 0;
const GIT_REFUSED = 128;
const GIT_ACCEPTED = 0;

type SharedDir = 'refs' | 'objects';

const REFUSED_ROWS = [
  ['refs-000', 'refs', 0o000],
  ['refs-0400', 'refs', 0o400],
  ['objects-000', 'objects', 0o000],
] as const;

const ACCEPTED_ROWS = [
  ['refs-0300', 'refs', 0o300],
  ['refs-0100', 'refs', 0o100],
] as const;

const openTrackedRepository = trackedRepositories();

describe.skipIf(!GIT_AVAILABLE || !UNPRIVILEGED)(
  'Given a gitdir whose shared directory has a restricted mode',
  () => {
    let root: string;

    beforeAll(async () => {
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-unsearchable-')));
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    });

    /** Runs `act` with `<gitDir>/<shared>` at `mode`, restoring 0755 so the cleanup can delete it. */
    const withMode = async <T>(
      gitDir: string,
      shared: SharedDir,
      mode: number,
      act: () => Promise<T>,
    ): Promise<T> => {
      const target = path.join(gitDir, shared);
      await chmod(target, mode);
      try {
        return await act();
      } finally {
        await chmod(target, 0o755);
      }
    };

    const absoluteGitDir = (cwd: string): string =>
      git(cwd, 'rev-parse', '--path-format=absolute', '--git-dir').trim();

    const openedGitDir = async (cwd: string): Promise<string> =>
      (await openTrackedRepository({ cwd })).ctx.layout.gitDir;

    const openOutcome = async (cwd: string): Promise<string> => {
      try {
        await openTrackedRepository({ cwd });
        return 'OPENED';
      } catch (err) {
        return (err as { data?: { code?: string } }).data?.code ?? 'UNKNOWN';
      }
    };

    describe.each([...REFUSED_ROWS, ...ACCEPTED_ROWS])(
      'When the walk meets an inner repository with %s',
      (slug, shared, mode) => {
        it('Then tsgit lands on the same gitdir as git (the outer one when refused)', async () => {
          // Arrange
          const outer = path.join(root, `walk-${slug}`);
          const inner = path.join(outer, 'inner');
          runGit(['init', '-q', outer]);
          runGit(['init', '-q', inner]);
          const sut = openedGitDir;

          // Act
          const [result, expected] = await withMode(
            path.join(inner, '.git'),
            shared,
            mode,
            async () => [await sut(inner), absoluteGitDir(inner)],
          );

          // Assert
          expect(result).toBe(expected);
        });
      },
    );

    describe.each(REFUSED_ROWS)(
      'When a gitfile points at a gitdir with %s',
      (slug, shared, mode) => {
        it('Then git exits 128 and tsgit refuses with NOT_A_REPOSITORY', async () => {
          // Arrange
          const target = path.join(root, `file-${slug}`);
          const wt = path.join(root, `file-${slug}-wt`);
          runGit(['init', '-q', target]);
          await mkdir(wt);
          await writeFile(path.join(wt, '.git'), `gitdir: ${path.join(target, '.git')}\n`);
          const sut = openOutcome;

          // Act
          const result = await withMode(path.join(target, '.git'), shared, mode, async () => ({
            gitExit: tryRunGitWithExit(['-C', wt, 'rev-parse', '--git-dir']).exitCode,
            outcome: await sut(wt),
          }));

          // Assert
          expect(result).toEqual({ gitExit: GIT_REFUSED, outcome: 'NOT_A_REPOSITORY' });
        });
      },
    );

    describe.each(ACCEPTED_ROWS)(
      'When a gitfile points at a gitdir with %s',
      (slug, shared, mode) => {
        it('Then git exits 0 and tsgit opens it', async () => {
          // Arrange
          const target = path.join(root, `file-${slug}`);
          const wt = path.join(root, `file-${slug}-wt`);
          runGit(['init', '-q', target]);
          await mkdir(wt);
          await writeFile(path.join(wt, '.git'), `gitdir: ${path.join(target, '.git')}\n`);
          const sut = openOutcome;

          // Act
          const result = await withMode(path.join(target, '.git'), shared, mode, async () => ({
            gitExit: tryRunGitWithExit(['-C', wt, 'rev-parse', '--git-dir']).exitCode,
            outcome: await sut(wt),
          }));

          // Assert
          expect(result).toEqual({ gitExit: GIT_ACCEPTED, outcome: 'OPENED' });
        });
      },
    );
  },
);
