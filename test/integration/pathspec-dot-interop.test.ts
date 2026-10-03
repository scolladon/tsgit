/**
 * Cross-tool interop — pathspecs carrying `.` components. git collapses them
 * (`.` is the whole tree, `./a` is `a`, `d/.` is `d`): a path restore puts back
 * and stages the same files and refuses a whole-tree pathspec over an empty
 * index, while `add .` stages the whole tree and never refuses it.
 *
 * @proves
 *   surface:        checkout, add
 *   bucket:         cross-tool-interop
 *   unique:         `.`-component pathspecs collapse as git's prefix_path does
 *   interopSurface: checkout, add
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { add } from '../../src/application/commands/add.js';
import { checkout } from '../../src/application/commands/checkout.js';
import type { TsgitError } from '../../src/domain/error.js';
import { GIT_AVAILABLE, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const MODIFIED = 'zz\n';

describe.skipIf(!GIT_AVAILABLE)('Given pathspecs carrying `.` components', () => {
  let root = '';

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-checkout-dot-')));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const twin = async (slug: string): Promise<string> => {
    const repo = path.join(root, slug);
    runGit(['init', '-q', '-b', 'main', repo]);
    await mkdir(path.join(repo, 'd'));
    await writeFile(path.join(repo, 'a'), 'a\n');
    await writeFile(path.join(repo, 'd', 'b'), 'b\n');
    runGit(['-C', repo, 'add', '.']);
    runGit(['-C', repo, '-c', 'user.name=A', '-c', 'user.email=a@a', 'commit', '-qm', 'c'], {
      env: {
        ...runGitEnv(),
        GIT_AUTHOR_DATE: '@1700000000 +0000',
        GIT_COMMITTER_DATE: '@1700000000 +0000',
      },
    });
    await writeFile(path.join(repo, 'a'), MODIFIED);
    await writeFile(path.join(repo, 'd', 'b'), MODIFIED);
    return repo;
  };

  const state = async (repo: string) => ({
    a: await readFile(path.join(repo, 'a'), 'utf8'),
    b: await readFile(path.join(repo, 'd', 'b'), 'utf8'),
    index: runGit(['-C', repo, 'ls-files', '-s']),
  });

  describe.each([
    { label: '`.` from the index', pathspec: '.', source: undefined },
    { label: '`.` from HEAD', pathspec: '.', source: 'HEAD' },
    { label: '`./a` from the index', pathspec: './a', source: undefined },
    { label: '`d/.` from HEAD', pathspec: 'd/.', source: 'HEAD' },
  ])('When git and tsgit restore $label', ({ label, pathspec, source }) => {
    it('Then both restore and stage the same files', async () => {
      // Arrange
      const slug = label.replaceAll(/[^a-z]/gi, '');
      const gitRepo = await twin(`git-${slug}`);
      const tsgitRepo = await twin(`tsgit-${slug}`);
      const sut = checkout;

      // Act
      runGit([
        '-C',
        gitRepo,
        'checkout',
        ...(source === undefined ? [] : [source]),
        '--',
        pathspec,
      ]);
      await sut(createNodeContext({ workDir: tsgitRepo }), {
        paths: [pathspec],
        ...(source !== undefined && { source }),
      });

      // Assert
      expect(await state(tsgitRepo)).toEqual(await state(gitRepo));
    });
  });

  describe('When git and tsgit restore `.` over an empty index', () => {
    it('Then both refuse the pathspec as matching nothing', async () => {
      // Arrange
      const gitRepo = path.join(root, 'git-empty');
      const tsgitRepo = path.join(root, 'tsgit-empty');
      runGit(['init', '-q', '-b', 'main', gitRepo]);
      runGit(['init', '-q', '-b', 'main', tsgitRepo]);
      const sut = checkout;

      // Act
      const git = tryRunGitWithExit(['-C', gitRepo, 'checkout', '--', '.']);
      const result = await sut(createNodeContext({ workDir: tsgitRepo }), { paths: ['.'] }).catch(
        (err: unknown) => err,
      );

      // Assert
      expect(git.exitCode).toBe(1);
      expect(git.stderr).toContain("error: pathspec '.' did not match any file(s) known to git");
      expect((result as TsgitError).data).toEqual({ code: 'PATHSPEC_NO_MATCH', pattern: '.' });
    });
  });

  describe.each([
    { label: 'an empty work tree', files: [] as ReadonlyArray<string> },
    { label: 'a nested work tree', files: ['a', 'd/b'] },
  ])('When git and tsgit add `.` over $label', ({ label, files }) => {
    it('Then both stage the same entries without refusing', async () => {
      // Arrange
      const slug = label.replaceAll(/[^a-z]/gi, '');
      const gitRepo = path.join(root, `git-add-${slug}`);
      const tsgitRepo = path.join(root, `tsgit-add-${slug}`);
      for (const repo of [gitRepo, tsgitRepo]) {
        runGit(['init', '-q', '-b', 'main', repo]);
        await mkdir(path.join(repo, 'd'));
        for (const file of files) await writeFile(path.join(repo, file), `${file}\n`);
      }
      const sut = add;

      // Act
      runGit(['-C', gitRepo, 'add', '.']);
      await sut(createNodeContext({ workDir: tsgitRepo }), ['.']);

      // Assert
      const staged = (repo: string) => runGit(['-C', repo, 'ls-files', '-s']);
      expect(staged(tsgitRepo)).toEqual(staged(gitRepo));
    });
  });
});
