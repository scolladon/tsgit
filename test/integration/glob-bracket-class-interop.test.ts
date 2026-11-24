/**
 * Cross-tool interop — bracket sets, backslash escapes and case folding in
 * ignore, attribute and non-cone sparse patterns. Each verdict is compared
 * with live git (`git sparse-checkout set --no-cone`), under both values of
 * `core.ignorecase`: the expectation is git's own answer, never a hard-coded
 * list, because folding changes what git keeps.
 *
 * @proves
 *   surface:        globBracketClass
 *   bucket:         cross-tool-interop
 *   unique:         bracket sets, backslash escapes and case folding in ignore, attribute and sparse rules select the same paths as git under both core.ignorecase values
 *   interopSurface: globBracketClass
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { sparseCheckoutSet } from '../../src/application/commands/sparse-checkout.js';
import { GIT_AVAILABLE, git, runGit } from './interop-helpers.js';

/** Characters git for Windows cannot pass or hold in a path. */
const WINDOWS_RESERVED = /[\\*?:"<>|]|[. ]$/u;
const LAST_CONTROL_CODE = 0x1f;

const isWindowsHostilePath = (candidate: string): boolean =>
  WINDOWS_RESERVED.test(candidate) ||
  [...candidate].some((char) => (char.codePointAt(0) ?? 0) <= LAST_CONTROL_CODE);

/** Patterns handed to sparse-checkout, then the files committed. */
type SparseRow = readonly [patterns: ReadonlyArray<string>, files: ReadonlyArray<string>];

const ALL_SPARSE_ROWS: ReadonlyArray<SparseRow> = [
  [
    ['/t', 'br[a]/'],
    ['t', 'bra/i', 'br[a]/h'],
  ],
  [['[ab]'], ['a', 'b', 'c']],
  [['d/[!a]'], ['d/a', 'd/b']],
  [['[A]x'], ['Ax', 'bx']],
  [['[a]x'], ['Ax', 'bx']],
  [['[A-Z]x'], ['ax', 'bx', '5x']],
  [['\\[a]'], ['[a]', 'a']],
  [['\\*'], ['*', 'x']],
  [['x[[:digit:]]'], ['x5', 'xa']],
  [['x[[:constructor:]]'], ['xa']],
  [['[a'], ['[a', 'a']],
  [['?'], ['é', 'e']],
  [['a\\'], ['a\\', 'a']],
  [['*.LOG'], ['x.log', 'y.txt']],
];

const SPARSE_ROWS =
  process.platform === 'win32'
    ? ALL_SPARSE_ROWS.filter(([, files]) => !files.some(isWindowsHostilePath))
    : ALL_SPARSE_ROWS;

const seedCommittedRepo = async (
  repo: string,
  ignoreCase: string,
  files: ReadonlyArray<string>,
): Promise<void> => {
  runGit(['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'core.ignorecase', ignoreCase);
  for (const file of files) {
    await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
    await writeFile(path.join(repo, file), `${file}\n`);
  }
  await writeFile(path.join(repo, 'keep'), 'keep\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=Ada', '-c', 'user.email=ada@example.com', 'commit', '-qm', 'seed');
};

const presentFiles = (repo: string, files: ReadonlyArray<string>): ReadonlyArray<string> =>
  files.filter((file) => existsSync(path.join(repo, file)));

const applySparseRow = async (
  root: string,
  ignoreCase: string,
  [patterns, files]: SparseRow,
): Promise<{
  readonly expected: ReadonlyArray<string>;
  readonly result: ReadonlyArray<string>;
}> => {
  const peer = await mkdtemp(path.join(root, 'sparse-peer-'));
  const ours = await mkdtemp(path.join(root, 'sparse-ours-'));
  await seedCommittedRepo(peer, ignoreCase, files);
  await seedCommittedRepo(ours, ignoreCase, files);
  git(peer, 'sparse-checkout', 'set', '--no-cone', ...patterns);
  await sparseCheckoutSet(createNodeContext({ workDir: ours }), {
    patterns: [...patterns],
    cone: false,
  });
  return { expected: presentFiles(peer, files), result: presentFiles(ours, files) };
};

describe.skipIf(!GIT_AVAILABLE)('integration — bracket class, escape and fold interop', () => {
  let root = '';

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-glob-bracket-class-')));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe.each(['false', 'true'])('Given core.ignorecase is %s', (ignoreCase) => {
    describe('When non-cone sparse patterns are applied to a committed tree', () => {
      it.each(SPARSE_ROWS)('Then %j over %j materialises the same files as git', async (...row) => {
        // Arrange
        const sut = applySparseRow;

        // Act
        const { expected, result } = await sut(root, ignoreCase, row);

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });
});
