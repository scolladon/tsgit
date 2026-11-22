/**
 * Cross-tool interop — `sparse-checkout set` and `add` match their patterns case-insensitively
 * under `core.ignorecase`, as git does when it applies them.
 *
 * @proves
 *   surface:        sparseCheckout
 *   bucket:         cross-tool-interop
 *   unique:         sparse-checkout set and add honour core.ignorecase when they apply the patterns as git does
 *   interopSurface: sparseCheckout
 */
import { mkdir, mkdtemp, realpath, rm as removeTree, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import {
  sparseCheckoutAdd,
  sparseCheckoutSet,
} from '../../src/application/commands/sparse-checkout.js';
import { GIT_AVAILABLE, runGit, runGitEnv } from './interop-helpers.js';

const PINNED_DATE = '@1700000000 +0000';

const gitIn = (repo: string, args: ReadonlyArray<string>): string =>
  runGit(['-C', repo, ...args], {
    env: { ...runGitEnv(), GIT_AUTHOR_DATE: PINNED_DATE, GIT_COMMITTER_DATE: PINNED_DATE },
  });

/** foo/x and top committed; `core.ignorecase` on and sparse checkout enabled with no pattern yet. */
const seed = async (repo: string): Promise<void> => {
  runGit(['init', '-q', '-b', 'main', repo]);
  gitIn(repo, ['config', 'user.name', 'A']);
  gitIn(repo, ['config', 'user.email', 'a@a']);
  gitIn(repo, ['config', 'core.ignorecase', 'true']);
  await mkdir(path.join(repo, 'foo'));
  await writeFile(path.join(repo, 'foo/x'), 'x\n');
  await writeFile(path.join(repo, 'top'), 'top\n');
  gitIn(repo, ['add', '-A']);
  gitIn(repo, ['commit', '-qm', 'c']);
};

const tagsOf = (repo: string): string =>
  gitIn(repo, ['-c', 'sparse.expectFilesOutsideOfPatterns=true', 'ls-files', '-t']);

interface Verb {
  readonly name: string;
  readonly git: ReadonlyArray<ReadonlyArray<string>>;
  readonly tsgit: (workDir: string) => Promise<unknown>;
}

const SET = ['sparse-checkout', 'set', '--no-cone', '/FOO/'];

const VERBS: ReadonlyArray<Verb> = [
  {
    name: 'set',
    git: [SET],
    tsgit: (workDir) =>
      sparseCheckoutSet(createNodeContext({ workDir }), { patterns: ['/FOO/'], cone: false }),
  },
  {
    name: 'add',
    git: [
      ['sparse-checkout', 'set', '--no-cone', '/nothing/'],
      ['sparse-checkout', 'add', '/FOO/'],
    ],
    tsgit: async (workDir) => {
      const ctx = createNodeContext({ workDir });
      await sparseCheckoutSet(ctx, { patterns: ['/nothing/'], cone: false });
      return sparseCheckoutAdd(ctx, { patterns: ['/FOO/'] });
    },
  },
];

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'sparse-checkout under core.ignorecase',
  () => {
    let root = '';
    let counter = 0;

    beforeAll(async () => {
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-sparse-ignorecase-')));
    });

    afterAll(async () => {
      await removeTree(root, { recursive: true, force: true });
    });

    describe.each(VERBS)('Given a case-variant non-cone directory pattern', (verb) => {
      describe(`When ${verb.name} applies it`, () => {
        it('Then tsgit leaves the index tags git leaves', async () => {
          // Arrange
          counter += 1;
          const gitRepo = path.join(root, `git-${counter}`);
          const tsgitRepo = path.join(root, `tsgit-${counter}`);
          await seed(gitRepo);
          await seed(tsgitRepo);
          for (const args of verb.git) gitIn(gitRepo, args);

          // Act
          await verb.tsgit(tsgitRepo);

          // Assert
          expect(tagsOf(gitRepo)).toBe('H foo/x\nS top\n');
          expect(tagsOf(tsgitRepo)).toBe(tagsOf(gitRepo));
        });
      });
    });
  },
);
