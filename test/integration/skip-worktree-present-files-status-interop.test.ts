/**
 * Cross-tool interop — every index read clears the skip-worktree bit of an entry whose path is
 * present in the working tree, so `status` reports a present out-of-pattern file as git does,
 * and the opportunistic writers persist the cleared bit exactly when git does. One row per
 * branch of git's presence decision. Run under both `core.ignorecase` values.
 *
 * @proves
 *   surface:        status
 *   bucket:         cross-tool-interop
 *   unique:         a skip-worktree entry whose file is present is read cleared and reported as git does
 *   interopSurface: status
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { add } from '../../src/application/commands/add.js';
import { commit } from '../../src/application/commands/commit.js';
import { status } from '../../src/application/commands/status.js';
import { readIndex } from '../../src/application/primitives/read-index.js';
import { GIT_AVAILABLE, tryRunGitWithExit } from './interop-helpers.js';
import {
  createTwinFactory,
  diskOf,
  gitIn,
  gitPorcelain,
  porcelainOf,
  settle,
  type TwinFactory,
  tagsOf,
  writeFiles,
} from './skip-worktree-present-files-fixtures.js';

const probeCaseInsensitiveFs = (): boolean => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tsgit-case-probe-'));
  try {
    writeFileSync(path.join(dir, 'probe'), '');
    return existsSync(path.join(dir, 'PROBE'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const CASE_INSENSITIVE_FS = probeCaseInsensitiveFs();

interface Row {
  readonly label: string;
  readonly patterns?: 'cone' | 'non-cone';
  readonly tune?: (repo: string) => Promise<void> | void;
  readonly arrange: (repo: string) => Promise<void>;
  readonly expected: string;
}

const present = (files: Record<string, string>) => (repo: string) => writeFiles(repo, files);

const ROWS: ReadonlyArray<Row> = [
  {
    label: 'a modified file at a skip-worktree path',
    arrange: present({ 'a/f': 'hi\n' }),
    expected: ' M a/f',
  },
  {
    label: 'a file at a skip-worktree path with unchanged content',
    arrange: present({ 'a/f': 'base\n' }),
    expected: '',
  },
  {
    label: 'an empty directory at a skip-worktree path',
    arrange: async (repo) => {
      await mkdir(path.join(repo, 'a/f'), { recursive: true });
    },
    expected: ' D a/f',
  },
  {
    label: 'a modified file under a directory whose siblings are absent',
    arrange: present({ 'a/d/x': 'y\n' }),
    expected: ' M a/d/x',
  },
  {
    label: 'a regular file where a directory is expected',
    arrange: async (repo) => {
      await writeFile(path.join(repo, 'a'), 'file\n');
    },
    expected: '?? a',
  },
  {
    label: 'non-cone patterns and a modified file at a skip-worktree path',
    patterns: 'non-cone',
    arrange: present({ 'a/f': 'hi\n' }),
    expected: ' M a/f',
  },
  {
    label: 'core.sparseCheckout off',
    tune: (repo) => {
      gitIn(repo, ['config', '--worktree', 'core.sparseCheckout', 'false']);
    },
    arrange: present({ 'a/f': 'hi\n' }),
    expected: '',
  },
  {
    label: 'a skip-worktree bit set without sparse checkout',
    tune: (repo) => {
      gitIn(repo, ['sparse-checkout', 'disable']);
      gitIn(repo, ['update-index', '--skip-worktree', 'a/f']);
    },
    arrange: present({ 'a/f': 'hi\n' }),
    expected: '',
  },
  {
    label: 'core.sparseCheckout only in config.worktree',
    arrange: present({ 'a/f': 'hi\n' }),
    expected: ' M a/f',
  },
  {
    label: 'expectFilesOutsideOfPatterns true',
    tune: (repo) => {
      gitIn(repo, ['config', 'sparse.expectFilesOutsideOfPatterns', 'true']);
    },
    arrange: present({ 'a/f': 'hi\n' }),
    expected: '',
  },
  {
    label: 'expectFilesOutsideOfPatterns true locally and false in config.worktree',
    tune: (repo) => {
      gitIn(repo, ['config', 'sparse.expectFilesOutsideOfPatterns', 'true']);
      gitIn(repo, ['config', '--worktree', 'sparse.expectFilesOutsideOfPatterns', 'false']);
    },
    arrange: present({ 'a/f': 'hi\n' }),
    expected: ' M a/f',
  },
  {
    label: 'expectFilesOutsideOfPatterns true then false in one file',
    tune: (repo) => {
      gitIn(repo, ['config', '--add', 'sparse.expectFilesOutsideOfPatterns', 'true']);
      gitIn(repo, ['config', '--add', 'sparse.expectFilesOutsideOfPatterns', 'false']);
    },
    arrange: present({ 'a/f': 'hi\n' }),
    expected: ' M a/f',
  },
  {
    label: 'expectFilesOutsideOfPatterns valueless',
    tune: async (repo) => {
      const config = path.join(repo, '.git', 'config');
      const { appendFile } = await import('node:fs/promises');
      await appendFile(config, '[sparse]\n\texpectFilesOutsideOfPatterns\n');
    },
    arrange: present({ 'a/f': 'hi\n' }),
    expected: '',
  },
];

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'status and the opportunistic writers over present skip-worktree files',
  () => {
    let factory: TwinFactory;
    beforeAll(async () => {
      factory = await createTwinFactory('tsgit-sw-status-');
    });
    afterAll(async () => {
      await factory.dispose();
    });

    describe.each(['false', 'true'])('with core.ignorecase=%s in both twins', (ignorecase) => {
      describe.each(ROWS)('Given $label', ({ patterns, tune, arrange, expected }) => {
        describe('When git and tsgit report the status', () => {
          it('Then tsgit reports what git reports', async () => {
            // Arrange
            const { gitRepo, tsgitRepo } = await factory.make({ ignorecase, patterns }, tune);
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

      describe('Given a case variant of a skip-worktree path', () => {
        describe('When git and tsgit report the status', () => {
          it.skipIf(!CASE_INSENSITIVE_FS)('Then tsgit reports what git reports', async () => {
            // Arrange
            const { gitRepo, tsgitRepo } = await factory.make({ ignorecase });
            await writeFiles(gitRepo, { 'A/f': 'hi\n' });
            await writeFiles(tsgitRepo, { 'A/f': 'hi\n' });

            // Act
            const result = await porcelainOf(tsgitRepo);

            // Assert
            const tracked = (text: string): string =>
              text
                .split('\n')
                .filter((line) => !line.startsWith('??'))
                .join('\n');
            const comparable = ignorecase === 'true' ? tracked : (text: string): string => text;
            expect(comparable(result)).toBe(comparable(gitPorcelain(gitRepo)));
          });
        });
      });

      describe('Given an unsettled index and a present file', () => {
        describe('When git and tsgit run status', () => {
          it('Then both persist the cleared bit', async () => {
            // Arrange
            const twins = await factory.make({ ignorecase });
            await writeFiles(twins.gitRepo, { 'a/f': 'hi\n' });
            await writeFiles(twins.tsgitRepo, { 'a/f': 'hi\n' });

            // Act
            gitIn(twins.gitRepo, ['status', '--porcelain']);
            await status(createNodeContext({ workDir: twins.tsgitRepo }));

            // Assert
            expect(tagsOf(twins.gitRepo)).toMatch(/^H 100644 \S+ 0\ta\/f$/m);
            expect(tagsOf(twins.tsgitRepo)).toBe(tagsOf(twins.gitRepo));
          });
        });
      });

      describe('Given a settled index and a present file', () => {
        describe('When git and tsgit run status', () => {
          it('Then both leave the bit on disk', async () => {
            // Arrange
            const twins = await factory.make({ ignorecase });
            await writeFiles(twins.gitRepo, { 'a/f': 'base\n' });
            await writeFiles(twins.tsgitRepo, { 'a/f': 'base\n' });
            await Promise.all([settle(twins.gitRepo), settle(twins.tsgitRepo)]);

            // Act
            gitIn(twins.gitRepo, ['status', '--porcelain']);
            await status(createNodeContext({ workDir: twins.tsgitRepo }));

            // Assert
            expect(tagsOf(twins.gitRepo)).toMatch(/^S 100644 \S+ 0\ta\/f$/m);
            expect(tagsOf(twins.tsgitRepo)).toBe(tagsOf(twins.gitRepo));
          });
        });
      });

      describe('Given a settled index and a present file with nothing staged', () => {
        describe('When git and tsgit commit', () => {
          it('Then both refuse and persist the cleared bit', async () => {
            // Arrange
            const twins = await factory.make({ ignorecase });
            await writeFiles(twins.gitRepo, { 'a/f': 'hi\n' });
            await writeFiles(twins.tsgitRepo, { 'a/f': 'hi\n' });
            await Promise.all([settle(twins.gitRepo), settle(twins.tsgitRepo)]);

            // Act
            const gitRun = tryRunGitWithExit(['-C', twins.gitRepo, 'commit', '-qm', 'x']);
            let code: string | undefined;
            try {
              await commit(createNodeContext({ workDir: twins.tsgitRepo }), { message: 'x' });
            } catch (error) {
              code = (error as { data?: { code?: string } }).data?.code;
            }

            // Assert
            expect(gitRun.exitCode).toBe(1);
            expect(code).toBe('NOTHING_TO_COMMIT');
            expect(tagsOf(twins.tsgitRepo)).toBe(tagsOf(twins.gitRepo));
            expect(tagsOf(twins.gitRepo)).toMatch(/^H 100644 \S+ 0\ta\/f$/m);
          });
        });
      });

      describe('Given a present skip-worktree file and a changed in-pattern file', () => {
        describe('When git and tsgit stage and commit the in-pattern change', () => {
          it('Then both persist the cleared bit', async () => {
            // Arrange
            const twins = await factory.make({ ignorecase });
            for (const repo of [twins.gitRepo, twins.tsgitRepo]) {
              await writeFiles(repo, { 'a/f': 'base\n', 'b/f': 'b2\n' });
            }
            const ctx = createNodeContext({ workDir: twins.tsgitRepo });

            // Act
            gitIn(twins.gitRepo, ['add', 'b/f']);
            gitIn(twins.gitRepo, ['commit', '-qm', 'x']);
            await add(ctx, ['b/f']);
            await commit(ctx, { message: 'x' });

            // Assert
            expect(tagsOf(twins.gitRepo)).toMatch(/^H 100644 \S+ 0\ta\/f$/m);
            expect(tagsOf(twins.tsgitRepo)).toBe(tagsOf(twins.gitRepo));
            expect(await diskOf(twins.tsgitRepo)).toEqual(await diskOf(twins.gitRepo));
          });
        });
      });

      describe('Given a present skip-worktree file', () => {
        describe('When git ls-files -t and tsgit readIndex read the index', () => {
          it('Then both show the entry without the bit', async () => {
            // Arrange
            const { gitRepo, tsgitRepo } = await factory.make({ ignorecase });
            await writeFiles(gitRepo, { 'a/f': 'hi\n' });
            await writeFiles(tsgitRepo, { 'a/f': 'hi\n' });

            // Act
            const index = await readIndex(createNodeContext({ workDir: tsgitRepo }));

            // Assert
            const tsgitTags = index.entries.map(
              (e) => `${e.flags.skipWorktree ? 'S' : 'H'} ${e.path}`,
            );
            const gitTags = gitIn(gitRepo, ['ls-files', '-t']).split('\n').filter(Boolean);
            expect(tsgitTags).toEqual(gitTags);
            expect(gitTags).toContain('H a/f');
          });
        });
      });
    });
  },
);
