/**
 * Cross-tool interop — `-X` strategy options that steer the content merge. One
 * history is built by git and copied per tool; each tool merges `side` into
 * `main` with the same options, and the merge commit, index, working-tree
 * files and stop state must agree with canonical git's ort.
 *
 * @proves
 *   surface:        repo.merge.run
 *   bucket:         cross-tool-interop
 *   unique:         -X options resolve overlapping hunks, whitespace, diff algorithm, renormalization and subtree shifts as git's ort does
 *   interopSurface: merge
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { cp } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const EPOCH = 1_700_000_000;
const IDENTITY: AuthorIdentity = {
  name: 't',
  email: 't@t',
  timestamp: EPOCH,
  timezoneOffset: '+0000',
};
const DATED_ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_AUTHOR_DATE: `${EPOCH} +0000`,
  GIT_COMMITTER_DATE: `${EPOCH} +0000`,
  GIT_EDITOR: 'true',
};
const STATE_FILES = ['MERGE_HEAD', 'MERGE_MSG'];

type Files = Readonly<Record<string, string>>;

interface Scenario {
  readonly base: Files;
  readonly side: Files;
  readonly main: Files;
}

let root: string;
let copies = 0;

const dated = (args: ReadonlyArray<string>): void => {
  runGit(args, { env: DATED_ENV });
};

/** A file whose content starts with this is written as a symlink to the rest. */
const SYMLINK = '-> ';

/** A file whose content is this is deleted. */
const DELETED = '<deleted>';

const writeEntry = (target: string, content: string): void => {
  rmSync(target, { force: true });
  if (content === DELETED) return;
  if (content.startsWith(SYMLINK)) symlinkSync(content.slice(SYMLINK.length), target);
  else writeFileSync(target, content);
};

const writeAll = (dir: string, files: Files): void => {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeEntry(path.join(dir, name), content);
  }
};

const commitAll = (dir: string, files: Files, message: string): void => {
  writeAll(dir, files);
  dated(['-C', dir, 'add', '-A']);
  dated(['-C', dir, 'commit', '-q', '-m', message]);
};

const buildScenario = ({ base, side, main }: Scenario): string => {
  const dir = path.join(root, `scenario-${copies++}`);
  runGit(['init', '-q', '-b', 'main', dir]);
  commitAll(dir, base, 'base');
  dated(['-C', dir, 'checkout', '-q', '-b', 'side']);
  commitAll(dir, side, 'side');
  dated(['-C', dir, 'checkout', '-q', 'main']);
  commitAll(dir, main, 'main');
  return dir;
};

const copyOf = async (dir: string): Promise<string> => {
  const target = path.join(root, `copy-${copies++}`);
  await cp(dir, target, { recursive: true, verbatimSymlinks: true });
  return target;
};

const readEntry = (target: string): string =>
  lstatSync(target).isSymbolicLink()
    ? `${SYMLINK}${readlinkSync(target)}`
    : readFileSync(target, 'latin1');

const worktreeFiles = (dir: string): Record<string, string> =>
  Object.fromEntries(
    readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((name) => !name.startsWith('.git/') && name !== '.git')
      .filter((name) => !lstatSync(path.join(dir, name)).isDirectory())
      .sort()
      .map((name) => [name, readEntry(path.join(dir, name))]),
  );

const snapshot = (dir: string) => ({
  head: git(dir, 'rev-parse', 'HEAD').trim(),
  index: git(dir, 'ls-files', '--stage'),
  files: worktreeFiles(dir),
  state: STATE_FILES.filter((name) => existsSync(path.join(dir, '.git', name))),
});

const mergeBoth = async (scenario: Scenario, options: ReadonlyArray<string>, strategy?: string) => {
  const theirs = buildScenario(scenario);
  const ours = await copyOf(theirs);
  const xArgs = options.flatMap((option) => ['-X', option]);
  const sArgs = strategy === undefined ? [] : ['-s', strategy];
  tryRunGitWithExit(['-C', theirs, 'merge', ...sArgs, ...xArgs, 'side'], { env: DATED_ENV });
  const repo = await openRepository({ cwd: ours });
  await repo.merge.run({
    rev: 'side',
    ...(strategy === undefined ? {} : { strategy }),
    strategyOptions: options,
    author: IDENTITY,
    committer: IDENTITY,
  });
  await repo.dispose();
  return { ours: snapshot(ours), theirs: snapshot(theirs) };
};

/** A scenario repository with `diff.algorithm` set, as both tools read it. */
const configuredScenario = (scenario: Scenario, algorithm: string): string => {
  const dir = buildScenario(scenario);
  runGit(['-C', dir, 'config', 'diff.algorithm', algorithm]);
  return dir;
};

const errorCodeOf = (run: Promise<unknown>): Promise<unknown> =>
  run.then(
    () => undefined,
    (e: unknown) => (e as { readonly data: { readonly code: string } }).data.code,
  );

/** Both tools merge — or cherry-pick — `side` under a configured `diff.algorithm`. */
const runConfigured = async (
  scenario: Scenario,
  algorithm: string,
  command: 'merge' | 'cherry-pick',
  options: ReadonlyArray<string> = [],
) => {
  const theirs = configuredScenario(scenario, algorithm);
  const ours = await copyOf(theirs);
  const xArgs = options.flatMap((option) => ['-X', option]);
  const exit = tryRunGitWithExit(['-C', theirs, command, ...xArgs, 'side'], { env: DATED_ENV });
  const repo = await openRepository({ cwd: ours });
  const refusal = await errorCodeOf(
    command === 'merge'
      ? repo.merge.run({
          rev: 'side',
          strategyOptions: options,
          author: IDENTITY,
          committer: IDENTITY,
        })
      : repo.cherryPick.run({ commits: ['side'] }),
  );
  await repo.dispose();
  return { ours: snapshot(ours), theirs: snapshot(theirs), exit: exit.exitCode, refusal };
};

/** Each side edits `f` so histogram, myers and patience each merge it differently. */
const ALGORITHM_SENSITIVE: Scenario = {
  base: { f: 'b\na\nc\na\nb\n' },
  side: { f: 'a\na\na\nb\nc\n' },
  main: { f: 'b\na\na\nc\na\nb\n' },
};

const NINE = '1\n2\n3\n4\n5\n6\n7\n8\n9\n';
const OVERLAP: Scenario = {
  base: { f: NINE, bin: 'b\n' },
  side: { f: '1\nS2\n3\n4\n5\n6\n7\n8\nS9\n', bin: 's\0\n' },
  main: { f: '1\nM2\nM2b\n3\n4\n5\n6\n7\n8\n9\n', bin: 'm\0\n' },
};
const UNSET_MERGE: Scenario = {
  base: { '.gitattributes': 'f -merge\n', f: 'b\n' },
  side: { f: 's\n' },
  main: { f: 'm\n' },
};

const WS_BASE = 'a b\nl2\nl3\nl4\nc d\nl6\nl7\nl8\ne f\nl10\nl11\nl12\ng h\n';
/** `side` edits line 5 for real and line 1 / 13 in whitespace only; main the reverse. */
const whitespaceEdits = (side: string, main: string): Scenario => ({
  base: { f: WS_BASE },
  side: { f: side },
  main: { f: main },
});
const SPACE_RUNS = whitespaceEdits(
  'a  b\nl2\nl3\nl4\nCD\nl6\nl7\nl8\ne f\nl10\nl11\nl12\ng\th\n',
  'AB\nl2\nl3\nl4\nc   d\nl6\nl7\nl8\ne f \nl10\nl11\nl12\ng  h\n',
);
const TRAILING = whitespaceEdits(
  'a b \nl2\nl3\nl4\nCD\nl6\nl7\nl8\ne f\nl10\nl11\nl12\ng h  \n',
  'AB\nl2\nl3\nl4\nc d \nl6\nl7\nl8\ne f\nl10\nl11\nl12\ng h \n',
);
const SQUEEZED = whitespaceEdits(
  'ab\nl2\nl3\nl4\nCD\nl6\nl7\nl8\ne f\nl10\nl11\nl12\ngh\n',
  'AB\nl2\nl3\nl4\ncd\nl6\nl7\nl8\ne f\nl10\nl11\nl12\ng h\t\n',
);
const CARRIAGE = whitespaceEdits(
  'a b\r\nl2\nl3\nl4\nCD\nl6\nl7\nl8\ne f\nl10\nl11\nl12\ng h\r\n',
  'AB\nl2\nl3\nl4\nc d\r\nl6\nl7\nl8\ne f\nl10\nl11\nl12\ng h\r\n',
);

const mulberry32 = (initial: number): (() => number) => {
  let seed = initial;
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
/** Edits heavy enough that xdiff's Myers heuristic cuts the search short where minimal does not. */
const heavyEdits = (): Scenario => {
  const rand = mulberry32(7);
  const pick = (): string => 'abcd'[Math.floor(rand() * 4)]!;
  const lines = Array.from({ length: 3000 }, pick);
  const resample = (rate: number): string =>
    lines.map((line) => `${rand() < rate ? pick() : line}\n`).join('');
  const base = lines.map((line) => `${line}\n`).join('');
  const main = resample(0.5);
  return { base: { f: base }, side: { f: resample(0.3) }, main: { f: main } };
};

/** Dense small inserts, deletes and replacements, where xdiff's region walk and refinement show. */
const denseEdits = (seed: number, length: number): Scenario => {
  const rand = mulberry32(seed);
  const pick = (): string => 'abcd}'[Math.floor(rand() * 5)]!;
  const lines = Array.from({ length }, pick);
  const edit = (): string[] => {
    if (rand() < 0.3) return [];
    return rand() < 0.5 ? [pick(), pick()] : [pick()];
  };
  const resample = (rate: number): string =>
    lines
      .flatMap((line) => (rand() < rate ? edit() : [line]))
      .map((line) => `${line}\n`)
      .join('');
  const base = lines.map((line) => `${line}\n`).join('');
  const main = resample(rand() * 0.6);
  return { base: { f: base }, side: { f: resample(rand() * 0.6) }, main: { f: main } };
};

/** Side turns into the subproject that main keeps under `lib/sub/`; main edits around it. */
const SUBPROJECT: Scenario = {
  base: { 'lib/sub/a': '1\n2\n3\n', 'lib/sub/b': 'b\n', 'lib/sub/c': 'c\n', top: 't\n' },
  side: {
    'lib/sub/a': DELETED,
    'lib/sub/b': DELETED,
    'lib/sub/c': DELETED,
    top: DELETED,
    a: '1\n2\nS3\n',
    b: 'b\n',
    c: 'c\n',
    d: 'new\n',
  },
  main: { 'lib/sub/a': 'M1\n2\n3\n', top: 'T\n', other: 'o\n' },
};

/** Both sides retarget one symlink and add another at the same path. */
const SYMLINKS: Scenario = {
  base: { f: 'x\n', l: '-> base' },
  side: { l: '-> theirs', added: '-> t2' },
  main: { l: '-> ours', added: '-> o2' },
};

/** Both sides adopt `text=auto`; side also strips the CRLFs, main edits a line. */
const LINE_ENDINGS: Scenario = {
  base: { f: 'a\r\nb\r\nc\r\n' },
  side: { '.gitattributes': '* text=auto\n', f: 'a\nb\nc\n' },
  main: { '.gitattributes': '* text=auto\n', f: 'a\r\nB\r\nc\r\n' },
};

/** Side renormalizes `f` under `text=auto` and edits line 1; main edits line 3 in CRLF. */
const RENORMALIZING: Scenario = {
  base: { f: 'a\r\nb\r\nc\r\n' },
  side: { '.gitattributes': '* text=auto\n', f: 'A\nb\nc\n' },
  main: { f: 'a\r\nb\r\nC\r\n' },
};

/** Side only renormalizes `f`; main deletes it. */
const RENORMALIZED_THEN_DELETED: Scenario = {
  base: { f: 'a\r\nb\r\nc\r\n', k: 'k\n' },
  side: { '.gitattributes': '* text=auto\n', f: 'a\nb\nc\n' },
  main: { f: DELETED },
};

const RENORMALIZED_BLOB = '24938456d42b76634c499d30bb6db8c59df815ec';

describe.skipIf(!GIT_AVAILABLE)('merge strategy options interop', () => {
  beforeAll(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tsgit-merge-x-')));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe.each([
    ['ours over an overlapping text hunk and a binary file', OVERLAP, ['ours']],
    ['theirs over an overlapping text hunk and a binary file', OVERLAP, ['theirs']],
    ['theirs over a file whose merge attribute is unset', UNSET_MERGE, ['theirs']],
    ['ignore-space-change over space runs', SPACE_RUNS, ['ignore-space-change']],
    ['ignore-space-change over trailing spaces', TRAILING, ['ignore-space-change']],
    ['ignore-space-change over a squeezed space', SQUEEZED, ['ignore-space-change']],
    ['ignore-all-space over space runs', SPACE_RUNS, ['ignore-all-space']],
    ['ignore-all-space over a squeezed space', SQUEEZED, ['ignore-all-space']],
    ['ignore-space-at-eol over space runs', SPACE_RUNS, ['ignore-space-at-eol']],
    ['ignore-space-at-eol over trailing spaces', TRAILING, ['ignore-space-at-eol']],
    ['ignore-cr-at-eol over carriage returns', CARRIAGE, ['ignore-cr-at-eol']],
    [
      'diff-algorithm=minimal and ours over heavy edits',
      heavyEdits(),
      ['diff-algorithm=minimal', 'ours'],
    ],
    [
      'diff-algorithm=myers and ours over heavy edits',
      heavyEdits(),
      ['diff-algorithm=myers', 'ours'],
    ],
    [
      'theirs and diff-algorithm=minimal over heavy edits',
      heavyEdits(),
      ['theirs', 'diff-algorithm=minimal'],
    ],
    ['diff-algorithm=minimal over heavy edits', heavyEdits(), ['diff-algorithm=minimal']],
    ['diff-algorithm=myers over heavy edits', heavyEdits(), ['diff-algorithm=myers']],
    ['nothing over heavy edits', heavyEdits(), []],
    ['diff-algorithm=myers over dense edits', denseEdits(4, 90), ['diff-algorithm=myers']],
    ['diff-algorithm=myers over denser edits', denseEdits(11, 195), ['diff-algorithm=myers']],
    ['nothing over dense edits', denseEdits(4, 90), []],
    ['nothing over denser edits', denseEdits(11, 195), []],
    ['histogram over dense edits', denseEdits(4, 90), ['histogram']],
    [
      'diff-algorithm=histogram over denser edits',
      denseEdits(11, 195),
      ['diff-algorithm=histogram'],
    ],
    [
      'diff-algorithm=minimal then histogram over dense edits',
      denseEdits(4, 90),
      ['diff-algorithm=minimal', 'histogram'],
    ],
    ['histogram over heavy edits', heavyEdits(), ['histogram']],
    ['patience over dense edits', denseEdits(4, 90), ['patience']],
    ['diff-algorithm=patience over denser edits', denseEdits(11, 195), ['diff-algorithm=patience']],
    ['patience over heavy edits', heavyEdits(), ['patience']],
    ['patience then histogram over dense edits', denseEdits(4, 90), ['patience', 'histogram']],
    ['no-renormalize over line endings', LINE_ENDINGS, ['no-renormalize']],
    [
      'renormalize then no-renormalize over line endings',
      LINE_ENDINGS,
      ['renormalize', 'no-renormalize'],
    ],
    ['nothing over a renormalizing history', RENORMALIZING, []],
    ['renormalize over a renormalizing history', RENORMALIZING, ['renormalize']],
    [
      'renormalize over a renormalized-then-deleted file',
      RENORMALIZED_THEN_DELETED,
      ['renormalize'],
    ],
    ['nothing over a renormalized-then-deleted file', RENORMALIZED_THEN_DELETED, []],
    ['ignore-space-at-eol and ours over space runs', SPACE_RUNS, ['ignore-space-at-eol', 'ours']],
    ['nothing over symlinks both sides changed', SYMLINKS, []],
    ['ours over symlinks both sides changed', SYMLINKS, ['ours']],
    ['theirs over symlinks both sides changed', SYMLINKS, ['theirs']],
    ['subtree over a subproject', SUBPROJECT, ['subtree']],
    ['subtree=lib/sub over a subproject', SUBPROJECT, ['subtree=lib/sub']],
    ['subtree=lib/sub/ over a subproject', SUBPROJECT, ['subtree=lib/sub/']],
    ['subtree=other over a subproject', SUBPROJECT, ['subtree=other']],
  ])('Given -X %s', (_label, scenario, options) => {
    describe('When both tools merge the side', () => {
      it("Then the merge commit, index, files and stop state match git's", async () => {
        // Arrange
        const sut = mergeBoth;

        // Act
        const result = await sut(scenario, options);

        // Assert
        expect(result.ours).toEqual(result.theirs);
      });
    });
  });

  describe.each([
    ['nothing', []],
    ['subtree=lib/sub', ['subtree=lib/sub']],
  ] as const)('Given -s subtree and -X %s over a subproject', (_label, options) => {
    describe('When both tools merge the side', () => {
      it("Then the merge commit, index, files and stop state match git's", async () => {
        // Arrange
        const sut = mergeBoth;

        // Act
        const result = await sut(SUBPROJECT, options, 'subtree');

        // Assert
        expect(result.ours).toEqual(result.theirs);
      });
    });
  });

  describe.each([
    ['myers', 'merge', []],
    ['default', 'merge', []],
    ['minimal', 'merge', []],
    ['patience', 'merge', []],
    ['PATIENCE', 'merge', []],
    ['Histogram', 'merge', []],
    ['myers', 'merge', ['histogram']],
    ['patience', 'merge', ['diff-algorithm=myers']],
    ['patience', 'cherry-pick', []],
    ['myers', 'cherry-pick', []],
  ] as const)('Given diff.algorithm=%s', (algorithm, command, options) => {
    describe(`When both tools ${command} the side with -X [${options.join(', ')}]`, () => {
      it("Then the commit, index, files and stop state match git's", async () => {
        // Arrange
        const sut = runConfigured;

        // Act
        const result = await sut(ALGORITHM_SENSITIVE, algorithm, command, options);

        // Assert
        expect(result.ours).toEqual(result.theirs);
      });
    });
  });

  describe.each(['merge', 'cherry-pick'] as const)(
    'Given diff.algorithm names no algorithm',
    (command) => {
      describe(`When both tools ${command} the side`, () => {
        it('Then both refuse and leave the repository as it was', async () => {
          // Arrange
          const sut = runConfigured;

          // Act
          const result = await sut(ALGORITHM_SENSITIVE, 'bogus', command);

          // Assert
          expect(result.ours).toEqual(result.theirs);
          expect(result.exit).toBe(128);
          expect(result.refusal).toBe('CONFIG_UNKNOWN_VALUE');
        });
      });
    },
  );

  describe('Given the renormalizing history', () => {
    describe('When both tools merge the side', () => {
      it('Then it conflicts without -X renormalize', async () => {
        // Arrange
        const sut = mergeBoth;

        // Act
        const result = await sut(RENORMALIZING, []);

        // Assert
        expect(result.theirs.state).toEqual(['MERGE_HEAD', 'MERGE_MSG']);
        expect(result.ours.state).toEqual(result.theirs.state);
      });
    });

    describe('When both tools merge the side with -X renormalize', () => {
      it('Then f is the renormalized merge in the same blob', async () => {
        // Arrange
        const sut = mergeBoth;

        // Act
        const result = await sut(RENORMALIZING, ['renormalize']);

        // Assert
        expect(result.theirs.state).toEqual([]);
        expect(result.theirs.files.f).toBe('A\nb\nC\n');
        expect(result.theirs.index).toContain(RENORMALIZED_BLOB);
        expect(result.ours.index).toContain(RENORMALIZED_BLOB);
      });
    });
  });
});
