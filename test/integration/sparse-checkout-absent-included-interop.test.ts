/**
 * Cross-tool interop — a sparse-checkout apply writes only an entry it re-includes: an
 * in-pattern entry the work tree lost stays absent, as git leaves it.
 *
 * @proves
 *   surface:        sparseCheckout
 *   bucket:         cross-tool-interop
 *   unique:         reapply, set, add and disable leave an absent in-pattern file or gitlink absent as git does
 *   interopSurface: sparseCheckout
 */
import { mkdir, mkdtemp, readdir, realpath, rm as removeTree, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import {
  sparseCheckoutAdd,
  sparseCheckoutDisable,
  sparseCheckoutReapply,
  sparseCheckoutSet,
} from '../../src/application/commands/sparse-checkout.js';
import { GIT_AVAILABLE, runGit, runGitEnv } from './interop-helpers.js';

const PINNED_DATE = '@1700000000 +0000';
const GITLINK_ID = '1111111111111111111111111111111111111111';

const gitIn = (repo: string, args: ReadonlyArray<string>): string =>
  runGit(['-C', repo, ...args], {
    env: { ...runGitEnv(), GIT_AUTHOR_DATE: PINNED_DATE, GIT_COMMITTER_DATE: PINNED_DATE },
  });

/** lib/f, deep/x, top and a gitlink sub; the patterns of `cone` applied over `lib` and `deep`, then the in-pattern top, lib/f and sub removed from the work tree. */
const seed = async (repo: string, cone: boolean): Promise<void> => {
  runGit(['init', '-q', '-b', 'main', repo]);
  gitIn(repo, ['config', 'user.name', 'A']);
  gitIn(repo, ['config', 'user.email', 'a@a']);
  for (const [file, content] of [
    ['lib/f', 'f\n'],
    ['deep/x', 'x\n'],
    ['top', 'top\n'],
  ] as const) {
    await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
    await writeFile(path.join(repo, file), content);
  }
  gitIn(repo, ['add', '-A']);
  gitIn(repo, ['update-index', '--add', '--cacheinfo', `160000,${GITLINK_ID},sub`]);
  gitIn(repo, ['commit', '-qm', 'c']);
  const mode = cone ? '--cone' : '--no-cone';
  gitIn(repo, ['sparse-checkout', 'set', mode, ...(cone ? ['lib', 'deep'] : ['/*', '!/deep/'])]);
  for (const lost of ['top', 'lib/f', 'sub']) {
    await removeTree(path.join(repo, lost), { recursive: true, force: true });
  }
};

const tagsOf = (repo: string): string =>
  gitIn(repo, ['-c', 'sparse.expectFilesOutsideOfPatterns=true', 'ls-files', '-t']);

const listDisk = async (repo: string): Promise<ReadonlyArray<string>> =>
  (await readdir(repo, { recursive: true })).filter((name) => !name.startsWith('.git')).sort();

interface Operation {
  readonly name: string;
  readonly cone: boolean;
  readonly git: ReadonlyArray<string>;
  readonly tsgit: (workDir: string) => Promise<unknown>;
}

const ctxOf = (workDir: string) => createNodeContext({ workDir });

const OPERATIONS: ReadonlyArray<Operation> = [
  ...[true, false].flatMap(
    (cone): ReadonlyArray<Operation> => [
      {
        name: `reapplying a ${cone ? 'cone' : 'non-cone'} checkout`,
        cone,
        git: ['sparse-checkout', 'reapply'],
        tsgit: (workDir) => sparseCheckoutReapply(ctxOf(workDir)),
      },
      {
        name: `setting a ${cone ? 'cone' : 'non-cone'} checkout to lib`,
        cone,
        git: ['sparse-checkout', 'set', cone ? '--cone' : '--no-cone', 'lib'],
        tsgit: (workDir) => sparseCheckoutSet(ctxOf(workDir), { patterns: ['lib'], cone }),
      },
      {
        name: `adding deep to a ${cone ? 'cone' : 'non-cone'} checkout`,
        cone,
        git: ['sparse-checkout', 'add', cone ? 'deep' : '/deep/'],
        tsgit: (workDir) =>
          sparseCheckoutAdd(ctxOf(workDir), { patterns: [cone ? 'deep' : '/deep/'] }),
      },
      {
        name: `disabling a ${cone ? 'cone' : 'non-cone'} checkout`,
        cone,
        git: ['sparse-checkout', 'disable'],
        tsgit: (workDir) => sparseCheckoutDisable(ctxOf(workDir)),
      },
    ],
  ),
];

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'a sparse checkout whose in-pattern files and gitlink are absent',
  () => {
    let root = '';
    let counter = 0;

    beforeAll(async () => {
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-sparse-absent-')));
    });

    afterAll(async () => {
      await removeTree(root, { recursive: true, force: true });
    });

    describe.each(OPERATIONS)('Given $name', (operation) => {
      describe('When it runs', () => {
        it('Then tsgit leaves the index tags and the files git leaves', async () => {
          // Arrange
          counter += 1;
          const gitRepo = path.join(root, `git-${counter}`);
          const tsgitRepo = path.join(root, `tsgit-${counter}`);
          await seed(gitRepo, operation.cone);
          await seed(tsgitRepo, operation.cone);
          gitIn(gitRepo, operation.git);

          // Act
          await operation.tsgit(tsgitRepo);

          // Assert
          expect(tagsOf(tsgitRepo)).toBe(tagsOf(gitRepo));
          expect(await listDisk(tsgitRepo)).toEqual(await listDisk(gitRepo));
        });
      });
    });
  },
);
