/**
 * Cross-tool interop — `reset --mixed` carries the skip-worktree bit as git does: an unchanged
 * entry is left alone, a changed entry keeps the bit of the entry it replaces, and a path the
 * index did not hold follows the sparse patterns. Run under both `core.ignorecase` values.
 *
 * @proves
 *   surface:        reset
 *   bucket:         cross-tool-interop
 *   unique:         reset --mixed keeps the skip-worktree bit of each rebuilt entry as git does
 *   interopSurface: reset
 */
import { mkdir, mkdtemp, realpath, rm as removeTree, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { reset } from '../../src/application/commands/reset.js';
import { GIT_AVAILABLE, runGit, runGitEnv } from './interop-helpers.js';

const PINNED_DATE = '@1700000000 +0000';

const writeFiles = async (repo: string, files: Readonly<Record<string, string>>): Promise<void> => {
  for (const [name, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repo, name)), { recursive: true });
    await writeFile(path.join(repo, name), body);
  }
};

const gitIn = (repo: string, args: ReadonlyArray<string>): string =>
  runGit(['-C', repo, ...args], {
    env: { ...runGitEnv(), GIT_AUTHOR_DATE: PINNED_DATE, GIT_COMMITTER_DATE: PINNED_DATE },
  });

/** t1 = a/f, a/g, b/f; t2 = a/f changed, a/new and b/n added, a/g removed; HEAD = t2, sparse on. */
const baseRepo = async (repo: string): Promise<void> => {
  runGit(['init', '-q', '-b', 'main', repo]);
  gitIn(repo, ['config', 'core.ignorecase', repo.endsWith('-ic') ? 'true' : 'false']);
  gitIn(repo, ['config', 'user.name', 'A']);
  gitIn(repo, ['config', 'user.email', 'a@a']);
  await writeFiles(repo, { 'a/f': 'v1\n', 'a/g': 'g\n', 'b/f': 'b\n' });
  gitIn(repo, ['add', '-A']);
  gitIn(repo, ['commit', '-qm', 't1']);
  await writeFiles(repo, { 'a/f': 'v2\n', 'a/new': 'n\n', 'b/n': 'n\n' });
  gitIn(repo, ['rm', '-q', 'a/g']);
  gitIn(repo, ['add', '-A']);
  gitIn(repo, ['commit', '-qm', 't2']);
  gitIn(repo, ['sparse-checkout', 'set', '--cone', 'b']);
  gitIn(repo, ['config', 'sparse.expectFilesOutsideOfPatterns', 'true']);
};

const stageBlob = (repo: string, name: string, body: string): void => {
  const id = runGit(['-C', repo, 'hash-object', '-w', '--stdin'], { input: body }).trim();
  gitIn(repo, ['update-index', '--cacheinfo', `100644,${id},${name}`]);
};

const present = async (repo: string, name: string, body: string): Promise<void> => {
  await writeFiles(repo, { [name]: body });
  gitIn(repo, ['update-index', '--no-skip-worktree', name]);
};

interface Row {
  readonly label: string;
  readonly seed: (repo: string) => Promise<void>;
}

const ROWS: ReadonlyArray<Row> = [
  {
    label: 'an unchanged a/f present without the bit',
    seed: async (repo) => {
      await baseRepo(repo);
      await present(repo, 'a/f', 'v2\n');
    },
  },
  {
    label: 'an unchanged a/f absent with the bit',
    seed: baseRepo,
  },
  {
    label: 'an unchanged a/f absent without the bit',
    seed: async (repo) => {
      await baseRepo(repo);
      gitIn(repo, ['update-index', '--no-skip-worktree', 'a/f']);
    },
  },
  {
    label: 'an unchanged in-pattern b/f carrying the bit',
    seed: async (repo) => {
      await baseRepo(repo);
      gitIn(repo, ['update-index', '--skip-worktree', 'b/f']);
    },
  },
  {
    label: 'a changed a/f present without the bit',
    seed: async (repo) => {
      await baseRepo(repo);
      stageBlob(repo, 'a/f', 'v1\n');
      await present(repo, 'a/f', 'v1\n');
    },
  },
  {
    label: 'a changed a/f with the bit',
    seed: async (repo) => {
      await baseRepo(repo);
      stageBlob(repo, 'a/f', 'v1\n');
      gitIn(repo, ['update-index', '--skip-worktree', 'a/f']);
    },
  },
  {
    label: 'new a/new present and untracked',
    seed: async (repo) => {
      await baseRepo(repo);
      gitIn(repo, ['update-index', '--force-remove', 'a/new']);
      await writeFiles(repo, { 'a/new': 'n\n' });
    },
  },
  {
    label: 'new b/n absent from the index',
    seed: async (repo) => {
      await baseRepo(repo);
      gitIn(repo, ['update-index', '--force-remove', 'b/n']);
    },
  },
];

const tagsOf = (repo: string): string => gitIn(repo, ['ls-files', '-t', '-s']);

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'reset --mixed over skip-worktree entries',
  () => {
    let root = '';
    let counter = 0;

    beforeAll(async () => {
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-reset-bit-')));
    });

    afterAll(async () => {
      await removeTree(root, { recursive: true, force: true });
    });

    describe.each([
      ['false', ''],
      ['true', '-ic'],
    ])('with core.ignorecase=%s', (_ignorecase, suffix) => {
      describe.each(ROWS)('Given $label', ({ seed }) => {
        describe('When git and tsgit reset --mixed to HEAD', () => {
          it('Then both leave the same index tags and object ids', async () => {
            // Arrange
            counter += 1;
            const gitRepo = path.join(root, `git-${counter}${suffix}`);
            const tsgitRepo = path.join(root, `tsgit-${counter}${suffix}`);
            await seed(gitRepo);
            await seed(tsgitRepo);
            const ctx = createNodeContext({ workDir: tsgitRepo });

            // Act
            gitIn(gitRepo, ['reset', '-q', '--mixed', 'HEAD']);
            await reset(ctx, { mode: 'mixed', rev: 'HEAD' });

            // Assert
            expect(tagsOf(tsgitRepo)).toBe(tagsOf(gitRepo));
          });
        });
      });
    });
  },
);
