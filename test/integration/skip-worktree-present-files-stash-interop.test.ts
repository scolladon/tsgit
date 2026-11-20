/**
 * Cross-tool interop — `stash` retires an out-of-pattern file whose skip-worktree bit is
 * cleared, as git does: a push removes it from the work tree and marks it skip-worktree, and an
 * apply that changes it leaves it absent at HEAD's blob. Run under both `core.ignorecase` values.
 *
 * @proves
 *   surface:        stash
 *   bucket:         cross-tool-interop
 *   unique:         stash push and apply retire a clean out-of-pattern file without the skip-worktree bit as git does
 *   interopSurface: stash
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm as removeTree, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { stashApply, stashPush } from '../../src/application/commands/stash.js';
import { TsgitError } from '../../src/domain/error.js';
import { GIT_AVAILABLE, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const PINNED_DATE = '@1700000000 +0000';

const COMMITTED: Readonly<Record<string, string>> = {
  'a/f': 'base\n',
  'a/g': 'g\n',
  'b/f': 'b\n',
};

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

const baseRepo = async (repo: string, ignorecase: string): Promise<void> => {
  runGit(['init', '-q', '-b', 'main', repo]);
  gitIn(repo, ['config', 'core.ignorecase', ignorecase]);
  gitIn(repo, ['config', 'user.name', 'A']);
  gitIn(repo, ['config', 'user.email', 'a@a']);
  await writeFiles(repo, COMMITTED);
  gitIn(repo, ['add', '-A']);
  gitIn(repo, ['commit', '-qm', 'c']);
  gitIn(repo, ['sparse-checkout', 'set', '--cone', 'b']);
  gitIn(repo, ['config', 'sparse.expectFilesOutsideOfPatterns', 'true']);
};

/** A stash holding "a/f" = st, then the cone re-applied so "a/f" is absent and skip-worktree. */
const stashOfOutOfPattern = async (repo: string): Promise<void> => {
  await baseRepo(repo, repo.endsWith('-ic') ? 'true' : 'false');
  gitIn(repo, ['update-index', '--no-skip-worktree', 'a/f']);
  await writeFiles(repo, { 'a/f': 'st\n' });
  gitIn(repo, ['stash']);
  gitIn(repo, ['sparse-checkout', 'reapply']);
  await removeTree(path.join(repo, 'a/f'), { force: true });
  gitIn(repo, ['update-index', '--skip-worktree', 'a/f']);
};

const present = async (repo: string, body: string): Promise<void> => {
  await writeFiles(repo, { 'a/f': body });
  gitIn(repo, ['update-index', '--no-skip-worktree', 'a/f']);
};

const snapshotOf = async (repo: string) => ({
  tags: gitIn(repo, ['ls-files', '-t', '-s']),
  af: existsSync(path.join(repo, 'a/f')) ? await readFile(path.join(repo, 'a/f'), 'utf8') : null,
});

interface Row {
  readonly label: string;
  readonly seed: (repo: string) => Promise<void>;
  readonly verb: 'apply' | 'push';
}

const ROWS: ReadonlyArray<Row> = [
  {
    label: 'apply of a stash changing a/f with a/f absent and skip-worktree',
    seed: stashOfOutOfPattern,
    verb: 'apply',
  },
  {
    label: 'apply of a stash changing a/f with a/f present at the base blob',
    seed: async (repo) => {
      await stashOfOutOfPattern(repo);
      await present(repo, 'base\n');
    },
    verb: 'apply',
  },
  {
    label: 'apply of a stash changing a/f with a/f present and edited',
    seed: async (repo) => {
      await stashOfOutOfPattern(repo);
      await present(repo, 'hi\n');
    },
    verb: 'apply',
  },
  {
    label: 'push with a/f present and edited',
    seed: async (repo) => {
      await baseRepo(repo, repo.endsWith('-ic') ? 'true' : 'false');
      await present(repo, 'hi\n');
    },
    verb: 'push',
  },
  {
    label: 'push with an in-pattern change and a/f present at the base blob',
    seed: async (repo) => {
      await baseRepo(repo, repo.endsWith('-ic') ? 'true' : 'false');
      await present(repo, 'base\n');
      await writeFiles(repo, { 'b/f': 'b2\n' });
    },
    verb: 'push',
  },
];

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'stash over out-of-pattern files without the skip-worktree bit',
  () => {
    let root = '';
    let counter = 0;

    beforeAll(async () => {
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-stash-present-')));
    });

    afterAll(async () => {
      await removeTree(root, { recursive: true, force: true });
    });

    describe.each([
      ['false', ''],
      ['true', '-ic'],
    ])('with core.ignorecase=%s', (_ignorecase, suffix) => {
      describe.each(ROWS)('Given $label', ({ seed, verb }) => {
        describe(`When git and tsgit stash ${verb}`, () => {
          it('Then both leave the same index tags and a/f, and agree on the outcome', async () => {
            // Arrange
            counter += 1;
            const gitRepo = path.join(root, `git-${counter}${suffix}`);
            const tsgitRepo = path.join(root, `tsgit-${counter}${suffix}`);
            await seed(gitRepo);
            await seed(tsgitRepo);
            const ctx = createNodeContext({ workDir: tsgitRepo });

            // Act
            const gitRun = tryRunGitWithExit(['-C', gitRepo, 'stash', verb, '-q']);
            const outcome = await (verb === 'apply'
              ? stashApply(ctx, {})
              : stashPush(ctx, {})
            ).then(
              (r) => r.kind,
              (e: unknown) => (e instanceof TsgitError ? e.data.code : 'unexpected'),
            );

            // Assert
            const refused = gitRun.exitCode !== 0;
            expect(outcome === 'STASH_APPLY_WOULD_OVERWRITE').toBe(refused);
            expect(await snapshotOf(tsgitRepo)).toEqual(await snapshotOf(gitRepo));
            if (verb === 'push')
              expect(gitIn(tsgitRepo, ['rev-parse', 'refs/stash^{tree}'])).toBe(
                gitIn(gitRepo, ['rev-parse', 'refs/stash^{tree}']),
              );
          });
        });
      });
    });
  },
);
