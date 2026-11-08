/**
 * Cross-tool interop — `fsck` over the ref stores of every worktree.
 *
 * Each row seeds a repository with a linked worktree (and more when it asks), runs real
 * `git fsck` and tsgit's `fsck` from a chosen working directory, rebuilds git's stderr
 * lines from tsgit's structured findings and compares: exit codes equal, pointer lines in
 * sequence, every other line as a sorted multiset.
 *
 * @proves
 *   surface:        fsck
 *   bucket:         cross-tool-interop
 *   unique:         tsgit checks and names every worktree's private refs as git does
 *   interopSurface: fsck
 */
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FsckFinding, FsckOptions, FsckResult } from '../../src/application/commands/fsck.js';
import { __resetConfigCacheForTests } from '../../src/application/primitives/config-read.js';
import { TsgitError } from '../../src/domain/index.js';
import { GIT_AVAILABLE, runGit, tryRunGitWithExit } from './interop-helpers.js';
import { trackedRepositories } from './repository-lifecycle.js';

const SETUP_TIMEOUT = 60_000;
const MAIN = 'w';
const LINKED = 'wt';
const FATAL_EXIT = 128;
const ZERO_OID = '0'.repeat(40);
const ABSENT_OID = 'deadbeef'.repeat(5);
const GARBAGE = 'garbage\n';
const COMMIT_LINE = '{commit}\n';
const BISECT_BAD = 'refs/bisect/bad';
const LINKED_BISECT_BAD = `worktrees/${LINKED}/${BISECT_BAD}`;
const POINTER_LINE = /^error: .*: invalid sha1 pointer /;
const REPORT_LINE = /^(error|warning|notice|fatal): /;
const TRAILING_BYTES = /[ \t\r\n]+$/;
const RESTORED = 0o755;
const HOP_CAP = 32;
const PACKED_HEADER = '# pack-refs with: peeled fully-peeled sorted \n';
const GITFILE_PREFIX = 'gitdir: ';

type Fill = (text: string) => string;
type BadRef = Extract<FsckFinding, { readonly type: 'bad-ref' }>;

interface HandMade {
  /** `undefined`: the work tree's `.git` file; a string (possibly empty): the `gitdir` file's body. */
  readonly gitdir?: string;
  readonly refsFile?: true;
  readonly workDir?: true;
}

interface Shape {
  /** The state, spelled as a Given clause. */
  readonly given: string;
  /** Linked worktrees created after `wt`, in creation order. */
  readonly worktrees?: ReadonlyArray<string>;
  readonly handMade?: Readonly<Record<string, HandMade>>;
  /** Files by gitdir-relative path; a finding's `ref` is its key. `{commit}` and `{root}` are filled. */
  readonly files?: Readonly<Record<string, string>>;
  /** Files by path relative to the throwaway root, beside the repository. */
  readonly beside?: Readonly<Record<string, string>>;
  /** Symbolic links by gitdir-relative path, to the link text. */
  readonly links?: Readonly<Record<string, string>>;
  /** Gitdir-relative paths deleted once seeded. */
  readonly removed?: ReadonlyArray<string>;
  /** Gitdir-relative paths given a mode once seeded. */
  readonly restricted?: Readonly<Record<string, number>>;
  readonly packed?: ReadonlyArray<string>;
  readonly config?: Readonly<Record<string, string>>;
  readonly flags?: ReadonlyArray<string>;
  readonly options?: FsckOptions;
}

interface Row extends Shape {
  /** Working directories the shape runs from: `w` or a linked worktree's id. */
  readonly origins: ReadonlyArray<string>;
  /** git dies (exit 128) and tsgit refuses to open with this data code. */
  readonly fatal?: 'NOT_A_REPOSITORY';
}

interface Arranged {
  readonly root: string;
  readonly cwd: string;
  readonly from: string;
  readonly shape: Shape;
  readonly fill: Fill;
}

const NO_REFERENCES = { flags: ['--no-references'], options: { checkReferences: false } } as const;
const bisectGarbage = (id: string): Record<string, string> => ({
  [`worktrees/${id}/${BISECT_BAD}`]: GARBAGE,
});
const garbageAt = (name: string): Shape => ({
  given: `garbage in a linked worktree's ${name} ref`,
  files: { [`worktrees/${LINKED}/${name}`]: GARBAGE },
});
const BOTH = [MAIN, LINKED] as const;
const FROM_MAIN = [MAIN] as const;
const FROM_LINKED = [LINKED] as const;

const rows: ReadonlyArray<Row> = [
  { given: 'a clean repository', origins: BOTH },
  {
    given: "a symbolic link as a linked worktree's bisect ref",
    links: { [LINKED_BISECT_BAD]: '../../../../refs/heads/main' },
    origins: BOTH,
  },
  { ...garbageAt('refs/bisect/bad'), origins: BOTH },
  { ...garbageAt('refs/worktree/x'), origins: BOTH },
  { ...garbageAt('refs/rewritten/x'), origins: BOTH },
  {
    given: "garbage in the main store's bisect ref",
    files: { [BISECT_BAD]: GARBAGE },
    origins: BOTH,
  },
  {
    given: "a symbolic link as the main store's worktree ref",
    links: { 'refs/worktree/x': '../heads/main' },
    origins: BOTH,
  },
  { ...garbageAt('HEAD'), origins: FROM_MAIN },
  {
    ...garbageAt('HEAD'),
    given: "garbage in a linked worktree's HEAD",
    origins: FROM_LINKED,
    fatal: 'NOT_A_REPOSITORY',
  },
  {
    given: "a symbolic link as a linked worktree's HEAD",
    links: { [`worktrees/${LINKED}/HEAD`]: '../../refs/heads/side' },
    origins: FROM_MAIN,
  },
  {
    given: "a symbolic link as a linked worktree's HEAD",
    links: { [`worktrees/${LINKED}/HEAD`]: '../../refs/heads/side' },
    origins: FROM_LINKED,
    fatal: 'NOT_A_REPOSITORY',
  },
  { given: "garbage in the main store's HEAD", files: { HEAD: GARBAGE }, origins: FROM_LINKED },
  {
    given: "garbage in the main store's HEAD",
    files: { HEAD: GARBAGE },
    origins: FROM_MAIN,
    fatal: 'NOT_A_REPOSITORY',
  },
  {
    given: 'a hand-made worktree admin dir without a refs dir',
    handMade: { vt: { workDir: true } },
    origins: [MAIN, 'vt'],
  },
  {
    given: 'a packed ref in the bisect namespace',
    packed: [`{commit} ${BISECT_BAD.replace('bad', 'packed')}`],
    origins: BOTH,
  },
  {
    given: 'a packed worktree ref pointing at zero',
    packed: [`${ZERO_OID} refs/worktree/zero`],
    origins: BOTH,
  },
  {
    given: "garbage in a linked worktree's heads namespace",
    files: { [`worktrees/${LINKED}/refs/heads/stray`]: GARBAGE },
    origins: BOTH,
  },
  {
    given: 'a bisect ref naming an absent object in a linked worktree',
    files: { [LINKED_BISECT_BAD]: `${ABSENT_OID}\n` },
    origins: BOTH,
  },
  {
    given: 'a bisect ref without a line feed in a linked worktree',
    files: { [LINKED_BISECT_BAD]: '{commit}' },
    origins: BOTH,
  },
  {
    given: 'a bisect ref holding an invalid referent in a linked worktree',
    files: { [LINKED_BISECT_BAD]: 'ref: foo\n' },
    origins: BOTH,
  },
  {
    given: 'garbage in the main store and two linked worktrees',
    worktrees: ['vt'],
    files: { [BISECT_BAD]: GARBAGE, ...bisectGarbage('vt'), ...bisectGarbage(LINKED) },
    origins: BOTH,
  },
  {
    given: 'garbage in the bisect refs of two linked worktrees',
    worktrees: ['vt'],
    files: { ...bisectGarbage('vt'), ...bisectGarbage(LINKED) },
    origins: FROM_LINKED,
  },
  {
    given: 'a linked worktree without a HEAD in its admin dir',
    removed: [`worktrees/${LINKED}/HEAD`],
    origins: FROM_MAIN,
  },
  {
    given: 'a linked worktree with an empty gitdir file and garbage in its bisect ref',
    worktrees: ['vt'],
    files: { 'worktrees/vt/gitdir': '', ...bisectGarbage('vt') },
    origins: FROM_MAIN,
  },
  {
    given: "the current worktree's gitdir file emptied beside garbage and a reflog entry",
    files: {
      [`worktrees/${LINKED}/gitdir`]: '',
      ...bisectGarbage(LINKED),
      [`worktrees/${LINKED}/logs/HEAD`]: `${ZERO_OID} ${ABSENT_OID} T <t@e> 0 +0000\tx\n`,
    },
    origins: FROM_LINKED,
  },
  {
    given: 'a bisect ref with an invalid name in a linked worktree',
    files: { [`worktrees/${LINKED}/refs/bisect/a..b`]: COMMIT_LINE },
    origins: BOTH,
  },
  {
    given: 'a head with an invalid name in the main store',
    files: { 'refs/heads/a..b': COMMIT_LINE },
    origins: FROM_MAIN,
  },
  {
    given: "a linked worktree's HEAD without a line feed",
    files: { [`worktrees/${LINKED}/HEAD`]: 'ref: refs/heads/side' },
    origins: BOTH,
  },
  {
    given: "a linked worktree's HEAD pointing at a tag",
    files: { [`worktrees/${LINKED}/HEAD`]: 'ref: refs/tags/x\n' },
    origins: BOTH,
  },
  {
    given: "the main store's HEAD pointing at a tag",
    files: { HEAD: 'ref: refs/tags/x\n' },
    origins: BOTH,
  },
  {
    given: "garbage in a lock file of a linked worktree's bisect namespace",
    files: { [`${LINKED_BISECT_BAD}.lock`]: GARBAGE },
    origins: BOTH,
  },
  {
    given: 'lock files among the main store heads',
    files: { 'refs/heads/x.lock': GARBAGE, 'refs/heads/y.lock': COMMIT_LINE },
    origins: FROM_MAIN,
  },
  {
    given: "a dot-led lock file and a lock file in a linked worktree's bisect namespace",
    files: {
      [`worktrees/${LINKED}/refs/bisect/.x.lock`]: GARBAGE,
      [`${LINKED_BISECT_BAD}.lock`]: COMMIT_LINE,
    },
    origins: BOTH,
  },
  {
    given: "a symbolic link out of the repository as a linked worktree's bisect ref",
    beside: { outside: COMMIT_LINE },
    links: { [LINKED_BISECT_BAD]: '{root}/outside' },
    origins: BOTH,
  },
  {
    given: "a symbolic link to a HEAD as a linked worktree's bisect ref",
    links: { [LINKED_BISECT_BAD]: '../../HEAD' },
    origins: BOTH,
  },
  {
    ...garbageAt('refs/bisect/bad'),
    ...NO_REFERENCES,
    given: 'garbage in a linked worktree with references unchecked',
    origins: FROM_MAIN,
  },
  {
    ...garbageAt('refs/bisect/bad'),
    given: 'garbage in a linked worktree with badRefContent graded as a warning',
    config: { 'fsck.badRefContent': 'warn' },
    origins: FROM_MAIN,
  },
];

const roots: string[] = [];
const refusedPaths: string[] = [];
const open = trackedRepositories();

afterEach(async () => {
  __resetConfigCacheForTests();
  await Promise.all(refusedPaths.splice(0).map((file) => chmod(file, RESTORED)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const git = (dir: string, ...args: ReadonlyArray<string>): string =>
  runGit(['-c', 'commit.gpgsign=false', '-c', 'gc.auto=0', '-C', dir, ...args]);

const writeUnder = async (base: string, relative: string, body: string): Promise<void> => {
  await mkdir(path.dirname(path.join(base, relative)), { recursive: true });
  await writeFile(path.join(base, relative), body);
};

const initWithCommit = (main: string): string => {
  runGit(['init', '-q', '-b', 'main', main]);
  const tree = git(main, 'hash-object', '-t', 'tree', '-w', '--stdin').trim();
  const commit = git(main, 'commit-tree', tree, '-m', 'c').trim();
  git(main, 'update-ref', 'refs/heads/main', commit);
  return commit;
};

const seedHandMade = async (
  root: string,
  gitDir: string,
  commit: string,
  handMade: Readonly<Record<string, HandMade>>,
): Promise<void> => {
  for (const [id, spec] of Object.entries(handMade)) {
    const admin = path.join(gitDir, 'worktrees', id);
    const workDir = path.join(root, MAIN, id);
    await writeUnder(admin, 'HEAD', `${commit}\n`);
    await writeUnder(admin, 'gitdir', spec.gitdir ?? `${path.join(workDir, '.git')}\n`);
    await writeUnder(admin, 'commondir', '../..\n');
    if (spec.refsFile === true) await writeUnder(admin, 'refs', '');
    if (spec.workDir === true) await writeUnder(workDir, '.git', `${GITFILE_PREFIX}${admin}\n`);
  }
};

const seedLinks = async (gitDir: string, links: Readonly<Record<string, string>>, fill: Fill) => {
  for (const [relative, target] of Object.entries(links)) {
    await mkdir(path.dirname(path.join(gitDir, relative)), { recursive: true });
    await rm(path.join(gitDir, relative), { force: true });
    await symlink(fill(target), path.join(gitDir, relative));
  }
};

const seedStores = async (arranged: Arranged, commit: string): Promise<void> => {
  const { root, shape, fill } = arranged;
  const main = path.join(root, MAIN);
  const gitDir = path.join(main, '.git');
  for (const id of shape.worktrees ?? []) git(main, 'worktree', 'add', '-q', '--detach', id);
  await seedHandMade(root, gitDir, commit, shape.handMade ?? {});
  for (const [relative, body] of Object.entries(shape.beside ?? {})) {
    await writeUnder(root, relative, fill(body));
  }
  for (const [relative, body] of Object.entries(shape.files ?? {})) {
    await writeUnder(gitDir, relative, fill(body));
  }
  for (const relative of shape.removed ?? []) await rm(path.join(gitDir, relative));
  await seedLinks(gitDir, shape.links ?? {}, fill);
  if (shape.packed !== undefined) {
    const lines = shape.packed.map((line) => `${fill(line)}\n`).join('');
    await writeFile(path.join(gitDir, 'packed-refs'), `${PACKED_HEADER}${lines}`);
  }
  for (const [key, value] of Object.entries(shape.config ?? {})) git(main, 'config', key, value);
  for (const [relative, mode] of Object.entries(shape.restricted ?? {})) {
    refusedPaths.unshift(path.join(gitDir, relative));
    await chmod(path.join(gitDir, relative), mode);
  }
};

const seed = async (shape: Shape, from: string): Promise<Arranged> => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-worktrees-')));
  roots.push(root);
  const main = path.join(root, MAIN);
  const commit = initWithCommit(main);
  git(main, 'worktree', 'add', '-q', LINKED, '-b', 'side');
  const fill: Fill = (text) => text.replaceAll('{commit}', commit).replaceAll('{root}', root);
  const cwd = from === MAIN ? main : path.join(main, from);
  const arranged: Arranged = { root, cwd, from, shape, fill };
  await seedStores(arranged, commit);
  return arranged;
};

const gitReportLines = (stderr: string): ReadonlyArray<string> =>
  stderr.split('\n').filter((line) => REPORT_LINE.test(line));

/** A linked store's root ref file: its parent directory is `<main>/.git/worktrees/<id>`. */
const isLinkedRootRefFile = (arranged: Arranged, file: string): boolean =>
  path.dirname(path.dirname(file)) === path.join(arranged.root, MAIN, '.git', 'worktrees');

/** git prints a path absolute from a linked cwd; from the main one it is relative, except a linked
 *  store's root ref file, built from the store's own spelling. */
const printedPath = (arranged: Arranged, file: string): string =>
  arranged.from !== MAIN || isLinkedRootRefFile(arranged, file)
    ? file
    : path.relative(path.join(arranged.root, MAIN), file);

const ENDED_TEXT = {
  FILE_NOT_FOUND: 'No such file or directory',
  NOT_A_DIRECTORY: 'Not a directory',
  PERMISSION_DENIED: 'Permission denied',
} as const;

const LINE_FEED_CODE = 0x0a;
const TAB_CODE = 0x09;
const FIRST_PRINTABLE_CODE = 0x20;
const DELETE_CODE = 0x7f;

/** git prints every control byte but LF and TAB as `?`. */
const displayed = (text: string): string =>
  [...text]
    .map((char) => {
      const code = char.charCodeAt(0);
      const control = code < FIRST_PRINTABLE_CODE || code === DELETE_CODE;
      return control && code !== LINE_FEED_CODE && code !== TAB_CODE ? '?' : char;
    })
    .join('');

const trailingDetail = (finding: BadRef): string =>
  finding.trailing === undefined
    ? 'has trailing whitespaces or newlines'
    : `has trailing garbage: '${displayed(finding.trailing)}'`;

/** The text after `<ref>: <msgId>: `; the seeded body stands for the content. */
const detailOf = (finding: BadRef, arranged: Arranged): string => {
  const referent = displayed(finding.referent ?? '');
  switch (finding.msgId) {
    case 'symlinkRef':
      return 'use deprecated symbolic link for symref';
    case 'refMissingNewline':
      return 'misses LF at the end';
    case 'badRefName':
      return 'invalid refname format';
    case 'badHeadTarget':
      return `HEAD points to non-branch '${referent}'`;
    case 'badReferentName':
      return `points to invalid refname '${referent}'`;
    case 'symrefTargetIsNotARef':
      return `points to non-ref target '${referent}'`;
    case 'trailingRefContent':
      return trailingDetail(finding);
    default: {
      const body = arranged.shape.files?.[finding.ref] ?? '';
      return displayed(arranged.fill(body).replace(TRAILING_BYTES, ''));
    }
  }
};

const badRefLines = (finding: BadRef, arranged: Arranged): ReadonlyArray<string> => {
  if (finding.msgId === 'badRefOid') {
    return [`error: ${finding.ref}: invalid sha1 pointer ${finding.target}`];
  }
  if (finding.msgId === 'cannotReadRef') {
    const shown = printedPath(arranged, finding.path ?? '');
    return [`error: cannot read ref file '${shown}': Permission denied`];
  }
  const label = finding.severity === 'error' ? 'error' : 'warning';
  return [`${label}: ${finding.ref}: ${finding.msgId}: ${detailOf(finding, arranged)}`];
};

const walkLines = (finding: FsckFinding, arranged: Arranged): ReadonlyArray<string> => {
  if (finding.type === 'unreadable-ref-path') {
    const shown = printedPath(arranged, finding.path);
    return finding.operation === 'open-directory'
      ? [`warning: error opening directory '${shown}${path.sep}': Permission denied`]
      : [`warning: failed to stat '${shown}': Permission denied`];
  }
  if (finding.type !== 'refs-walk-failed') return [];
  const shown = printedPath(arranged, finding.path);
  return finding.reason === 'NOT_A_DIRECTORY'
    ? [`error: cannot open directory ${shown}: Not a directory`]
    : [`error: failed to iterate over '${shown}'`];
};

const endedLine = (
  finding: Extract<FsckFinding, { readonly type: 'refs-verify-ended' }>,
  arranged: Arranged,
): string =>
  finding.reason === 'SYMLINK_LOOP'
    ? `fatal: More than ${HOP_CAP} nested symlinks on path '${printedPath(arranged, finding.path)}'`
    : `fatal: Invalid path '${finding.path}': ${ENDED_TEXT[finding.reason]}`;

/** git's report lines, rebuilt from tsgit's structured findings. */
const rebuiltLines = (result: FsckResult, arranged: Arranged): ReadonlyArray<string> =>
  result.findings.flatMap((finding) => {
    if (finding.type === 'bad-ref') return badRefLines(finding, arranged);
    if (finding.type === 'no-default-references') return ['notice: No default references'];
    if (finding.type === 'refs-verify-ended') return [endedLine(finding, arranged)];
    if (finding.type === 'invalid-reflog-entry') {
      return [`error: ${finding.ref}: invalid reflog entry ${finding.id}`];
    }
    return walkLines(finding, arranged);
  });

const pointersOf = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines.filter((line) => POINTER_LINE.test(line));

const othersSorted = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines.filter((line) => !POINTER_LINE.test(line)).sort();

const gitArgs = (arranged: Arranged): ReadonlyArray<string> => [
  '-c',
  'commit.gpgsign=false',
  '-c',
  'gc.auto=0',
  '-C',
  arranged.cwd,
  'fsck',
  ...(arranged.shape.flags ?? []),
];

const runTsgit = async (arranged: Arranged): Promise<FsckResult> => {
  const repo = await open({ cwd: arranged.cwd });
  return repo.fsck(arranged.shape.options);
};

const refusalCodeOf = async (arranged: Arranged): Promise<string | undefined> => {
  try {
    await runTsgit(arranged);
  } catch (error) {
    return error instanceof TsgitError ? error.data.code : String(error);
  }
  return undefined;
};

const originsOf = (row: Row): ReadonlyArray<{ readonly from: string; readonly label: string }> =>
  row.origins.map((from) => ({
    from,
    label: from === MAIN ? 'the main worktree' : `the linked worktree ${from}`,
  }));

describe.skipIf(!GIT_AVAILABLE)('Given a repository whose worktrees keep private refs', () => {
  describe.each(rows.filter((row) => row.fatal === undefined))('Given $given', (row) => {
    describe.each(originsOf(row))('When fsck runs from $label', ({ from }) => {
      it(
        'Then tsgit reports git’s lines and exit code',
        async () => {
          // Arrange
          const arranged = await seed(row, from);
          const expected = tryRunGitWithExit(gitArgs(arranged));
          const sut = runTsgit;

          // Act
          const result = await sut(arranged);

          // Assert
          const ours = rebuiltLines(result, arranged).flatMap((line) => line.split('\n'));
          const theirs = gitReportLines(expected.stderr);
          expect(result.exitCode).toBe(expected.exitCode);
          expect(pointersOf(ours)).toEqual(pointersOf(theirs));
          expect(othersSorted(ours)).toEqual(othersSorted(theirs));
        },
        SETUP_TIMEOUT,
      );
    });
  });

  describe.each(rows.filter((row) => row.fatal !== undefined))('Given $given', (row) => {
    describe.each(originsOf(row))('When fsck runs from $label', ({ from }) => {
      it(
        'Then both tools refuse the repository',
        async () => {
          // Arrange
          const arranged = await seed(row, from);
          const expected = tryRunGitWithExit(gitArgs(arranged));
          const sut = refusalCodeOf;

          // Act
          const code = await sut(arranged);

          // Assert
          expect(expected.exitCode).toBe(FATAL_EXIT);
          expect(code).toBe(row.fatal);
        },
        SETUP_TIMEOUT,
      );
    });
  });
});
