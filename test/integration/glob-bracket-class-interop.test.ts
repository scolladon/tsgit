/**
 * Cross-tool interop — bracket sets, backslash escapes and case folding in
 * ignore, attribute and non-cone sparse patterns. Each verdict is compared
 * with live git (`git check-ignore`, `git check-attr`, `git sparse-checkout set --no-cone`), under both values of
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
import { buildAttributeProvider } from '../../src/application/primitives/internal/read-gitattributes.js';
import { isIgnored } from '../../src/application/primitives/is-ignored.js';
import { resolveAttribute } from '../../src/domain/attributes/index.js';
import type { FilePath } from '../../src/domain/objects/object-id.js';
import { GIT_AVAILABLE, git, runGit, tryRunGitWithExit } from './interop-helpers.js';

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

/**
 * One pattern, the paths an ignore check asks about, and the paths only an
 * attribute check can ask about (git reads a leading `:` as pathspec magic).
 */
type GlobCase = readonly [
  pattern: string,
  paths: ReadonlyArray<string>,
  attributeOnlyPaths?: ReadonlyArray<string>,
];

const CASES: ReadonlyArray<GlobCase> = [
  ['\\[a]', ['[a]', 'a']],
  ['\\*', ['*', 'x']],
  ['a\\', ['a', 'a\\']],
  ['\\!a', ['!a', 'a']],
  ['a\\/b', ['a/b']],
  ['\\a', ['a', 'A']],
  ['\\A', ['a', 'A']],
  ['A', ['a', 'A']],
  ['*.LOG', ['x.log', 'x.LOG']],
  ['Dir/f', ['dir/f', 'Dir/f', 'DIR/F']],
  ['?', ['é', 'e']],
  ['??', ['é', 'ee']],
  ['**\\/b', ['b', 'x/b', 'x/y/b']],
  ['a/**\\/b', ['a/b', 'a/x/b', 'a/x/y/b']],
  ['a/[b]**/c', ['a/bc', 'a/b/x/c', 'a/bX/c', 'a/b/c']],
  ['[!a]', ['a', 'b', '!']],
  ['[^a]', ['a', 'b', '^']],
  ['[a!]', ['a', '!', 'b']],
  ['[]a]', [']', 'a', 'b']],
  ['[!]a]', [']', 'a', 'b']],
  ['[]-a]', [']', '^', 'a', '-', 'b']],
  ['[a', ['[a', 'a']],
  ['*[', ['a[', '[', 'x']],
  ['[a\\]', ['a', '\\', 'a]', '[a\\]']],
  ['[\\]]', [']', '\\', 'a']],
  ['[a\\-c]', ['a', '-', 'c', 'b']],
  ['[a-\\c]', ['b', 'c', '\\', 'd']],
  ['[a-c]', ['a', 'b', 'c', 'd', '-']],
  ['[c-a]', ['c', 'a', 'b']],
  ['[a-]', ['a', '-', 'b']],
  ['[a-c-e]', ['b', '-', 'e', 'd']],
  ['x[--0]', ['x.', 'x-', 'x,', 'x1']],
  ['[[:digit:]', ['5', '[[:digit:]']],
  ['[[:alpha]', ['[', 'a', 'p', 'x'], [':']],
  ['[[:]]', ['[]', '[', ']'], [':]']],
  ['[[a:]', ['a', '[', 'b', 'a]'], [':']],
  ['[[:digit:]]', ['5', 'a', '[']],
  ['[[:space:]]', [' ', '\t', '\v', '\f', 'a']],
  ['[[:punct:]]', ['!', '_', '~', 'a', '5']],
  ['[[:digit:]-z]', ['5', '-', 'z', 'a']],
  ['[a-[:digit:]]', ['a]', 'd]', '5', '5]'], [':]']],
  ['[[:foo:]]', ['a', 'f', '[[:foo:]]']],
  ['[[::]]', ['[', '[[::]]'], [':']],
  ['[[:constructor:]]', ['a']],
  ['[[:__proto__:]]', ['a']],
  ['*.py[cod]', ['m.pyc', 'm.pyo', 'm.pyd', 'd/m.pyc', 'm.py', 'm.pyx', 'm.py[cod]']],
  ['[ab]', ['a', 'b', 'd/a', 'c', '[ab]']],
  ['[ab]c', ['x/ac', 'cc']],
  ['a[/]b', ['a/b']],
  ['x/a[!b]c', ['x/a/c', 'x/adc', 'x/abc']],
  ['a[b/c]d', ['abd', 'acd', 'a/d']],
  ['[A]', ['a', 'A']],
  ['[A-Z]', ['a', 'A', '5']],
  ['[X-c]', ['a', 'A', 'Y', 'y', 'd', '{']],
  ['[!A]', ['a', 'A', 'b']],
  ['[!b]', ['B', 'b', 'c']],
  ['[[:upper:]]', ['A', 'a', '5']],
  ['[[:lower:]]', ['a', 'A', '5']],
  ['x[A]', ['xa', 'xA', 'Xa']],
  ['[A-A]', ['a', 'A']],
  ['[é]', ['é', 'e']],
  ['[!a][!a]', ['é', 'bb']],
  ['[\\a-c]', ['a', 'b', 'c', '\\', 'd']],
  ['[[:]:]]', ['[:]]', 'x:]]'], ['::]]']],
  ['[a^]', ['a', '^', 'b']],
  ['[![:digit:]]', ['5', 'a']],
  ['[[:alpha:][:digit:]]', ['a', '5', '_']],
  ['[[:DIGIT:]]', ['5', 'D']],
  ['d/a[[:punct:]]b', ['d/a/b', 'd/a_b']],
  ['x[ab]', ['xa', 'd/xa', 'd/xc']],
];

const IGNORE_CASES: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = CASES.map(
  ([pattern, paths]) => [pattern, paths] as const,
).filter(([, paths]) => process.platform !== 'win32' || !paths.some(isWindowsHostilePath));

const ATTRIBUTE_CASES: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = CASES.map(
  ([pattern, paths, attributeOnlyPaths = []]) =>
    [pattern, [...paths, ...attributeOnlyPaths]] as const,
).filter(([, paths]) => process.platform !== 'win32' || !paths.some(isWindowsHostilePath));

const NEGATIVE_CASES: ReadonlyArray<readonly [string, string, ReadonlyArray<string>]> = [
  ['!a', '!a probe', ['!a', 'a']],
  ['\\!b', '\\!b probe', ['!b']],
];

const ATTRIBUTE = 'probe';

const writeAttributeRepo = async (
  root: string,
  ignoreCase: string,
  gitattributes: string,
): Promise<string> => {
  const repo = await mkdtemp(path.join(root, 'attr-'));
  runGit(['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'core.ignorecase', ignoreCase);
  await writeFile(path.join(repo, '.gitattributes'), gitattributes);
  return repo;
};

/** `<path> <attribute> <value>` NUL-separated triples; a warning on stderr is not a failure. */
const attributesByGit = (
  repo: string,
  paths: ReadonlyArray<string>,
): ReadonlyMap<string, string> => {
  const { stdout, stderr, exitCode } = tryRunGitWithExit(
    ['-C', repo, 'check-attr', '-z', '--stdin', ATTRIBUTE],
    { input: `${paths.join('\0')}\0` },
  );
  if (exitCode !== 0) throw new Error(`git check-attr failed (${exitCode}): ${stderr}`);
  const fields = stdout.split('\0');
  const verdicts = new Map<string, string>();
  for (let index = 0; index + 2 < fields.length; index += 3) {
    verdicts.set(fields[index] as string, fields[index + 2] as string);
  }
  return verdicts;
};

const attributesByTsgit = async (
  repo: string,
  paths: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, string>> => {
  const provider = await buildAttributeProvider(createNodeContext({ workDir: repo }));
  const verdicts = new Map<string, string>();
  for (const candidate of paths) {
    const { sources, macros } = await provider.sourcesForPath(candidate as FilePath);
    const value = resolveAttribute(sources, candidate as FilePath, ATTRIBUTE, macros);
    verdicts.set(candidate, value === true ? 'set' : String(value));
  }
  return verdicts;
};

const checkAttributeRow = async (
  root: string,
  ignoreCase: string,
  line: string,
  paths: ReadonlyArray<string>,
): Promise<{
  readonly expected: ReadonlyArray<readonly [string, string]>;
  readonly result: ReadonlyArray<readonly [string, string]>;
}> => {
  const repo = await writeAttributeRepo(root, ignoreCase, `${line}\n`);
  return {
    expected: [...attributesByGit(repo, paths)],
    result: [...(await attributesByTsgit(repo, paths))],
  };
};

const writeIgnoreRepo = async (
  root: string,
  ignoreCase: string,
  gitignore: string,
  directories: ReadonlyArray<string>,
): Promise<string> => {
  const repo = await mkdtemp(path.join(root, 'ignore-'));
  runGit(['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'core.ignorecase', ignoreCase);
  await writeFile(path.join(repo, '.gitignore'), gitignore);
  for (const directory of directories) {
    await mkdir(path.join(repo, directory), { recursive: true });
  }
  return repo;
};

const parentDirectories = (paths: ReadonlyArray<string>): ReadonlyArray<string> =>
  paths.map((candidate) => path.dirname(candidate)).filter((directory) => directory !== '.');

/** `-z` is only valid with `--stdin` (or `-v`): the paths go over stdin, NUL-separated. */
const gitCheckIgnore = (
  repo: string,
  flags: ReadonlyArray<string>,
  paths: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const { stdout, stderr, exitCode } = tryRunGitWithExit(
    ['-C', repo, 'check-ignore', '--stdin', '-z', '--no-index', ...flags],
    { input: `${paths.join('\0')}\0` },
  );
  if (exitCode > 1) throw new Error(`git check-ignore failed (${exitCode}): ${stderr}`);
  return stdout.split('\0').filter((field) => field !== '');
};

const ignoredByGit = (repo: string, paths: ReadonlyArray<string>): ReadonlyArray<string> =>
  gitCheckIgnore(repo, [], paths);

const ignoredByTsgit = async (
  repo: string,
  paths: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> => {
  const matches = await isIgnored(
    createNodeContext({ workDir: repo }),
    paths.map((candidate) => ({ path: candidate as FilePath })),
  );
  return matches.filter((match) => match.ignored).map((match) => match.path);
};

const checkIgnoreRow = async (
  root: string,
  ignoreCase: string,
  pattern: string,
  paths: ReadonlyArray<string>,
): Promise<{
  readonly expected: ReadonlyArray<string>;
  readonly result: ReadonlyArray<string>;
}> => {
  const repo = await writeIgnoreRepo(root, ignoreCase, `${pattern}\n`, parentDirectories(paths));
  return {
    expected: [...ignoredByGit(repo, paths)].sort(),
    result: [...(await ignoredByTsgit(repo, paths))].sort(),
  };
};

// `e*` ignores `e[x]` unless the negated line after it matches: the escaped
// negation is then visible in both tools.
const PATTERN_LINES = ['e*', '!e\\[x]', 'f\\[ab]/', '/g[h]', '\\#a', 'c\\ ', 'd\\*', 'g\\\\h   '];
const PATTERN_PATHS = ['e[x]', 'ex', 'f[ab]', 'gh', '#a', 'c ', 'd*', 'g\\h'];
const NEGATION = '!';
const QUAD = 4;

interface VerboseMatch {
  readonly pattern: string;
  readonly path: string;
  /** `<source>|<line>|<pattern>|<path>`, as `check-ignore -v` reports them. */
  readonly triple: string;
}

/** `<source> <line> <pattern> <path>` quads of `check-ignore -v -z`. */
const verboseMatches = (stdoutFields: ReadonlyArray<string>): ReadonlyArray<VerboseMatch> => {
  const matches: VerboseMatch[] = [];
  for (let index = 0; index + QUAD <= stdoutFields.length; index += QUAD) {
    const [source, line, pattern, matched] = stdoutFields.slice(index, index + QUAD) as [
      string,
      string,
      string,
      string,
    ];
    matches.push({ pattern, path: matched, triple: `${source}|${line}|${pattern}|${matched}` });
  }
  return matches;
};

const checkVerboseRow = async (
  root: string,
  ignoreCase: string,
): Promise<{
  readonly expected: ReadonlyArray<string>;
  readonly negated: ReadonlyArray<string>;
  readonly result: ReadonlyArray<string>;
}> => {
  const repo = await writeIgnoreRepo(root, ignoreCase, `${PATTERN_LINES.join('\n')}\n`, ['f[ab]']);
  const reported = verboseMatches(gitCheckIgnore(repo, ['-v'], PATTERN_PATHS));
  // With -v git also reports the negated line that un-ignores a path.
  const negated = reported.filter((match) => match.pattern.startsWith(NEGATION));
  const expected = reported
    .filter((match) => !match.pattern.startsWith(NEGATION))
    .map((match) => match.triple)
    .sort();
  const matches = await isIgnored(
    createNodeContext({ workDir: repo }),
    PATTERN_PATHS.map((candidate) => ({
      path: candidate as FilePath,
      isDirectory: candidate === 'f[ab]',
    })),
  );
  const result = matches
    .filter((match) => match.ignored && match.source !== undefined)
    .map((match) => `.gitignore|${match.source?.line}|${match.source?.pattern}|${match.path}`)
    .sort();
  return { expected, negated: negated.map((match) => match.triple), result };
};

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

    describe('When a .gitignore rule is checked', () => {
      it.each(IGNORE_CASES)('Then %j over %j matches git check-ignore', async (pattern, paths) => {
        // Arrange
        const sut = checkIgnoreRow;

        // Act
        const { expected, result } = await sut(root, ignoreCase, pattern, paths);

        // Assert
        expect(result).toEqual(expected);
      });
    });

    describe('When a .gitattributes rule is resolved', () => {
      it.each(ATTRIBUTE_CASES)('Then %j over %j matches git check-attr', async (pattern, paths) => {
        // Arrange
        const sut = checkAttributeRow;

        // Act
        const { expected, result } = await sut(root, ignoreCase, `${pattern} ${ATTRIBUTE}`, paths);

        // Assert
        expect(result).toEqual(expected);
      });
    });

    describe('When a negative .gitattributes pattern is resolved', () => {
      it.each(NEGATIVE_CASES)('Then %j matches git check-attr', async (_pattern, line, paths) => {
        // Arrange
        const sut = checkAttributeRow;

        // Act
        const { expected, result } = await sut(root, ignoreCase, line, paths);

        // Assert
        expect(result).toEqual(expected);
      });
    });

    describe('When .gitignore lines hold escapes and trailing spaces', () => {
      it.skipIf(process.platform === 'win32')(
        'Then the matching source line and pattern text are those git reports',
        async () => {
          // Arrange
          const sut = checkVerboseRow;

          // Act
          const { expected, negated, result } = await sut(root, ignoreCase);

          // Assert — git reports the escaped negation as written, and the path
          // it un-ignores is absent from both ignored lists.
          expect(negated).toEqual(['.gitignore|2|!e\\[x]|e[x]']);
          expect(result).toEqual(expected);
        },
      );
    });
  });
});
