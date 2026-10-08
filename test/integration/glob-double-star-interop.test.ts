/**
 * Cross-tool interop — `**` in gitattributes, gitignore and non-cone sparse
 * patterns. git matches these with WM_PATHNAME: a star run spans directories
 * only as a whole path component (a `**` between slashes or at either end of
 * the pattern); anywhere else (`d/a**b`, `d/**b`) it is a single `*`. Each
 * verdict is compared with `git check-attr`, `git check-ignore` and
 * `git sparse-checkout set --no-cone`.
 *
 * @proves
 *   surface:        globDoubleStar
 *   bucket:         cross-tool-interop
 *   unique:         a `**` that is not a whole path component stays inside one directory for attributes, ignore and sparse rules, as in git
 *   interopSurface: globDoubleStar
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { sparseCheckoutSet } from '../../src/application/commands/sparse-checkout.js';
import { buildAttributeProvider } from '../../src/application/primitives/internal/read-gitattributes.js';
import { isIgnored } from '../../src/application/primitives/is-ignored.js';
import { resolveAttribute } from '../../src/domain/attributes/index.js';
import type { FilePath } from '../../src/domain/objects/object-id.js';
import { GIT_AVAILABLE, git, runGit, tryRunGitWithExit } from './interop-helpers.js';

const ATTRIBUTE = 'probe';

/** One pattern and the paths whose verdict git and tsgit must agree on. */
const CASES: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ['d/a**b', ['d/a/c/b', 'd/a/b', 'd/axb', 'd/ab']],
  ['d/**b', ['d/x/yb', 'd/yb', 'd/b']],
  ['d/a**/b', ['d/ax/y/b', 'd/ax/b', 'd/a/b']],
  ['d/***/b', ['d/x/y/b', 'd/x/b', 'd/b']],
  ['a**b', ['a/c/b', 'acb']],
  ['**/x', ['x', 'p/q/x']],
  ['x/**', ['x/a', 'x/a/b']],
  ['a/**/b', ['a/b', 'a/x/y/b']],
  ['**', ['a', 'a/b/c']],
];

/** The shapes whose sparse verdict differs from a free-spanning `**` (file and directory names cannot collide). */
const SPARSE_CASES = CASES.filter(([pattern]) => pattern.startsWith('d/') || pattern === 'a**b');

const ROWS = CASES.flatMap(([pattern, paths]) => paths.map((p) => [pattern, p] as const));

const gitAttribute = (repo: string, file: string): string =>
  git(repo, 'check-attr', ATTRIBUTE, '--', file).trim().split(': ').pop() as string;

const IGNORED_EXIT_CODE = 0;

const gitIgnores = (repo: string, file: string): boolean =>
  tryRunGitWithExit(['-C', repo, 'check-ignore', '-q', '--no-index', '--', file]).exitCode ===
  IGNORED_EXIT_CODE;

const tsgitAttribute = async (repo: string, file: string): Promise<string> => {
  const provider = await buildAttributeProvider(createNodeContext({ workDir: repo }));
  const { sources, macros } = await provider.sourcesForPath(file as FilePath);
  const value = resolveAttribute(sources, file, ATTRIBUTE, macros);
  return value === true ? 'set' : String(value);
};

const tsgitIgnores = async (repo: string, file: string): Promise<boolean> => {
  const [match] = await isIgnored(createNodeContext({ workDir: repo }), [
    { path: file as FilePath },
  ]);
  return match?.ignored === true;
};

const seedCommittedRepo = async (repo: string, paths: ReadonlyArray<string>): Promise<void> => {
  runGit(['init', '-q', '-b', 'main', repo]);
  for (const file of paths) {
    await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
    await writeFile(path.join(repo, file), `${file}\n`);
  }
  await writeFile(path.join(repo, 'keep'), 'keep\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=Ada', '-c', 'user.email=ada@example.com', 'commit', '-qm', 'seed');
};

const presentFiles = (repo: string, paths: ReadonlyArray<string>): ReadonlyArray<string> =>
  paths.filter((file) => existsSync(path.join(repo, file)));

describe.skipIf(!GIT_AVAILABLE)('integration — `**` path-component interop', () => {
  let root = '';

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-glob-double-star-')));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const freshRepo = async (pattern: string, file: string): Promise<string> => {
    const repo = await mkdtemp(path.join(root, 'rules-'));
    runGit(['init', '-q', repo]);
    await writeFile(path.join(repo, '.gitattributes'), `${pattern} ${ATTRIBUTE}\n`);
    await writeFile(path.join(repo, '.gitignore'), `${pattern}\n`);
    await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
    return repo;
  };

  describe('Given a .gitattributes rule', () => {
    describe('When the attribute of a path is resolved', () => {
      it.each(ROWS)('Then %s on %s matches git check-attr', async (pattern, file) => {
        // Arrange
        const repo = await freshRepo(pattern, file);
        const expected = gitAttribute(repo, file);

        // Act
        const result = await tsgitAttribute(repo, file);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given a .gitignore rule', () => {
    describe('When a path is checked', () => {
      it.each(ROWS)('Then %s on %s matches git check-ignore', async (pattern, file) => {
        // Arrange
        const repo = await freshRepo(pattern, file);
        const expected = gitIgnores(repo, file);

        // Act
        const result = await tsgitIgnores(repo, file);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given a non-cone sparse-checkout rule', () => {
    describe('When the rule is applied to a committed tree', () => {
      it.each(SPARSE_CASES)(
        'Then %s materialises the same files as git',
        async (pattern, paths) => {
          // Arrange
          const peer = await mkdtemp(path.join(root, 'sparse-peer-'));
          const ours = await mkdtemp(path.join(root, 'sparse-ours-'));
          await seedCommittedRepo(peer, paths);
          await seedCommittedRepo(ours, paths);
          git(peer, 'sparse-checkout', 'set', '--no-cone', pattern);
          const expected = presentFiles(peer, paths);

          // Act
          await sparseCheckoutSet(createNodeContext({ workDir: ours }), {
            patterns: [pattern],
            cone: false,
          });

          // Assert
          expect(presentFiles(ours, paths)).toEqual(expected);
        },
      );
    });
  });
});
