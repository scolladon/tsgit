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
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
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

const writeAll = (dir: string, files: Files): void => {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
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
  await cp(dir, target, { recursive: true });
  return target;
};

const worktreeFiles = (dir: string): Record<string, string> =>
  Object.fromEntries(
    readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((name) => !name.startsWith('.git/') && name !== '.git')
      .filter((name) => statSync(path.join(dir, name)).isFile())
      .sort()
      .map((name) => [name, readFileSync(path.join(dir, name), 'latin1')]),
  );

const snapshot = (dir: string) => ({
  head: git(dir, 'rev-parse', 'HEAD').trim(),
  index: git(dir, 'ls-files', '--stage'),
  files: worktreeFiles(dir),
  state: STATE_FILES.filter((name) => existsSync(path.join(dir, '.git', name))),
});

const mergeBoth = async (scenario: Scenario, options: ReadonlyArray<string>) => {
  const theirs = buildScenario(scenario);
  const ours = await copyOf(theirs);
  const xArgs = options.flatMap((option) => ['-X', option]);
  tryRunGitWithExit(['-C', theirs, 'merge', ...xArgs, 'side'], { env: DATED_ENV });
  const repo = await openRepository({ cwd: ours });
  await repo.merge.run({
    rev: 'side',
    strategyOptions: options,
    author: IDENTITY,
    committer: IDENTITY,
  });
  await repo.dispose();
  return { ours: snapshot(ours), theirs: snapshot(theirs) };
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
    ['ignore-space-at-eol and ours over space runs', SPACE_RUNS, ['ignore-space-at-eol', 'ours']],
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
});
