/**
 * POSIX-only interop — a skip-worktree entry is cleared on read when `lstat` succeeds on its
 * path: a live or dangling symlink and a path under a symlinked leading directory count as
 * present; an unreadable parent directory reads as absent and keeps the bit. Run under both
 * `core.ignorecase` values.
 *
 * @proves
 *   surface:        repo.status
 *   bucket:         platform-only
 *   unique:         symlinks and refusals at a skip-worktree path decide its bit as canonical git does
 *   interopSurface: status
 */
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../../src/adapters/node/index.js';
import { status } from '../../../src/application/commands/status.js';
import { readIndex } from '../../../src/application/primitives/read-index.js';
import { TsgitError } from '../../../src/domain/error.js';
import { GIT_AVAILABLE, tryRunGitWithExit } from '../interop-helpers.js';
import {
  createTwinFactory,
  gitIn,
  gitPorcelain,
  porcelainOf,
  type TwinFactory,
} from '../skip-worktree-present-files-fixtures.js';

const RUNNING_AS_ROOT = process.getuid?.() === 0;

interface Row {
  readonly label: string;
  readonly arrange: (repo: string) => Promise<void>;
  readonly expected: string;
}

const ROWS: ReadonlyArray<Row> = [
  {
    label: 'a live symlink at a skip-worktree path',
    arrange: async (repo) => {
      await mkdir(path.join(repo, 'a'), { recursive: true });
      await writeFile(path.join(repo, 'target'), 'base\n');
      await symlink('../target', path.join(repo, 'a/f'));
    },
    expected: ' T a/f\n?? target',
  },
  {
    label: 'a dangling symlink at a skip-worktree path',
    arrange: async (repo) => {
      await mkdir(path.join(repo, 'a'), { recursive: true });
      await symlink('nowhere', path.join(repo, 'a/f'));
    },
    expected: ' T a/f',
  },
  {
    label: 'a directory symlink holding the file at its parent',
    arrange: async (repo) => {
      await mkdir(path.join(repo, 'real'), { recursive: true });
      await writeFile(path.join(repo, 'real/f'), 'base\n');
      await symlink('real', path.join(repo, 'a'));
    },
    expected: ' D a/f\n?? a\n?? real/f',
  },
];

describe.skipIf(!GIT_AVAILABLE)(
  'status over skip-worktree paths that are symlinks or unreadable',
  () => {
    let factory: TwinFactory;
    beforeAll(async () => {
      factory = await createTwinFactory('tsgit-sw-posix-');
    });
    afterAll(async () => {
      await factory.dispose();
    });

    describe.each(['false', 'true'])('with core.ignorecase=%s in both twins', (ignorecase) => {
      describe.each(ROWS)('Given $label', ({ arrange, expected }) => {
        describe('When git and tsgit report the status', () => {
          it('Then tsgit reports what git reports', async () => {
            // Arrange
            const { gitRepo, tsgitRepo } = await factory.make({ ignorecase });
            await arrange(gitRepo);
            await arrange(tsgitRepo);

            // Act
            const result = await porcelainOf(tsgitRepo);

            // Assert
            expect(gitPorcelain(gitRepo)).toBe(expected);
            expect(result).toBe(expected);
          });
        });
      });

      describe('Given an unreadable parent directory holding a skip-worktree file', () => {
        describe('When git ls-files -t and tsgit readIndex read the index', () => {
          it.skipIf(RUNNING_AS_ROOT)('Then both keep the bit', async () => {
            // Arrange
            const { gitRepo, tsgitRepo } = await factory.make({ ignorecase });
            for (const repo of [gitRepo, tsgitRepo]) {
              await mkdir(path.join(repo, 'a'), { recursive: true });
              await writeFile(path.join(repo, 'a/f'), 'hi\n');
              await chmod(path.join(repo, 'a'), 0o000);
            }

            // Act
            const index = await readIndex(createNodeContext({ workDir: tsgitRepo }));

            // Assert
            const tsgitTags = index.entries.map(
              (e) => `${e.flags.skipWorktree ? 'S' : 'H'} ${e.path}`,
            );
            const gitTags = gitIn(gitRepo, ['ls-files', '-t']).split('\n').filter(Boolean);
            for (const repo of [gitRepo, tsgitRepo]) await chmod(path.join(repo, 'a'), 0o755);
            expect(tsgitTags).toEqual(gitTags);
            expect(gitTags).toContain('S a/f');
          });
        });
      });

      describe('Given an unreadable parent directory holding a skip-worktree file', () => {
        describe('When git and tsgit report the status', () => {
          it.skipIf(RUNNING_AS_ROOT)(
            'Then git warns and exits 0 while tsgit refuses with PERMISSION_DENIED',
            async () => {
              // Arrange
              const { gitRepo, tsgitRepo } = await factory.make({ ignorecase });
              for (const repo of [gitRepo, tsgitRepo]) {
                await mkdir(path.join(repo, 'a'), { recursive: true });
                await writeFile(path.join(repo, 'a/f'), 'hi\n');
                await chmod(path.join(repo, 'a'), 0o000);
              }
              const gitRun = tryRunGitWithExit(['-C', gitRepo, 'status', '--porcelain', '-uall']);

              // Act
              const failure = await status(createNodeContext({ workDir: tsgitRepo })).then(
                () => undefined,
                (error: unknown) => error,
              );

              // Assert
              for (const repo of [gitRepo, tsgitRepo]) await chmod(path.join(repo, 'a'), 0o755);
              expect(gitRun.exitCode).toBe(0);
              expect(gitRun.stderr).toContain("could not open directory 'a/': Permission denied");
              expect(failure).toBeInstanceOf(TsgitError);
              expect((failure as TsgitError).data.code).toBe('PERMISSION_DENIED');
              expect((failure as TsgitError).data).toEqual({
                code: 'PERMISSION_DENIED',
                path: path.join(tsgitRepo, 'a'),
              });
            },
          );
        });
      });
    });
  },
);
