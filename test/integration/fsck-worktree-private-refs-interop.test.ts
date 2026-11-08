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
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FsckFinding, FsckOptions, FsckResult } from '../../src/application/commands/fsck.js';
import { __resetConfigCacheForTests } from '../../src/application/primitives/config-read.js';
import { getRefStore } from '../../src/application/primitives/ref-store.js';
import { TsgitError } from '../../src/domain/index.js';
import { GIT_AVAILABLE, revParseStdout, runGit, tryRunGitWithExit } from './interop-helpers.js';
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
const NO_ACCESS = 0o000;
const READ_ONLY = 0o444;
const SEARCH_ONLY = 0o300;
const ORDER_RUNS = 3;
const UNPRIVILEGED = process.platform !== 'win32' && process.getuid?.() !== 0;
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
  /** Gitdir-relative paths renamed (source to destination) once seeded, before links are made. */
  readonly moved?: Readonly<Record<string, string>>;
  /** Gitdir-relative paths made into named pipes. */
  readonly fifos?: ReadonlyArray<string>;
  /** Linked worktree ids renamed to a new id once seeded, their work tree's `.git` file following. */
  readonly renamedAdmins?: Readonly<Record<string, string>>;
  /** Gitdir-relative paths written empty once the moves are done. */
  readonly blanks?: ReadonlyArray<string>;
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
  /** Fresh throwaways the shape is run on; an order that comes from the file system needs several. */
  readonly runs?: number;
  /** The non-pointer lines are compared in sequence instead of as a multiset. */
  readonly sequence?: true;
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
const deadLinkAt = (id: string): Record<string, string> => ({
  [`worktrees/${id}/refs/bisect/dead`]: 'nope/x',
});
const reflogEntryAt = (id: string): Record<string, string> => ({
  [`worktrees/${id}/logs/HEAD`]: `${ZERO_OID} ${ABSENT_OID} T <t@e> 0 +0000\tx\n`,
});
const unreadableAt = (given: string, relative: string, mode: number): Shape => ({
  given,
  files: { [relative]: COMMIT_LINE },
  restricted: { [relative]: mode },
});
const NO_ADMIN_ACCESS = `worktrees/${LINKED}`;

const FIFO_BAD = `worktrees/${LINKED}/${BISECT_BAD}`;
const FIFO_TARGET = 'fifo-target';
const WINDOWS = process.platform === 'win32';
const RENAMED_ADMIN = 'w:t';

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
  {
    given: "a linked worktree's refs directory without any access",
    restricted: { [`worktrees/${LINKED}/refs`]: NO_ACCESS },
    origins: BOTH,
  },
  {
    given: "a linked worktree's admin dir without any access",
    restricted: { [NO_ADMIN_ACCESS]: NO_ACCESS },
    origins: FROM_MAIN,
  },
  {
    ...unreadableAt(
      "a linked worktree's bisect directory without any access",
      `worktrees/${LINKED}/refs/bisect/bad`,
      NO_ACCESS,
    ),
    restricted: { [`worktrees/${LINKED}/refs/bisect`]: NO_ACCESS },
    origins: BOTH,
  },
  {
    ...unreadableAt("an unreadable linked worktree's HEAD", `worktrees/${LINKED}/HEAD`, NO_ACCESS),
    origins: FROM_MAIN,
  },
  {
    ...unreadableAt("an unreadable main store's HEAD", 'HEAD', NO_ACCESS),
    origins: FROM_LINKED,
  },
  {
    given: "unreadable main store's head and ORIG_HEAD",
    files: { 'refs/heads/u': COMMIT_LINE, ORIG_HEAD: COMMIT_LINE },
    restricted: { 'refs/heads/u': NO_ACCESS, ORIG_HEAD: NO_ACCESS },
    origins: BOTH,
  },
  {
    ...unreadableAt(
      "an unreadable linked worktree's bisect ref",
      `worktrees/${LINKED}/refs/bisect/bad`,
      NO_ACCESS,
    ),
    origins: BOTH,
  },
  {
    given: 'a hand-made worktree admin dir whose refs is a file',
    handMade: { vt: { workDir: true, refsFile: true } },
    origins: [MAIN, 'vt'],
  },
  {
    given: "a linked worktree's refs directory replaced by a symbolic link",
    files: { [LINKED_BISECT_BAD]: GARBAGE },
    moved: { [`worktrees/${LINKED}/refs`]: `worktrees/${LINKED}/refs.real` },
    links: { [`worktrees/${LINKED}/refs`]: 'refs.real' },
    origins: BOTH,
  },
  {
    given: "the main store's refs directory replaced by a symbolic link",
    moved: { refs: 'refs.real' },
    links: { refs: 'refs.real' },
    origins: BOTH,
  },
  {
    given: 'garbage in root refs of the main store and of a linked worktree',
    runs: ORDER_RUNS,
    files: {
      ORIG_HEAD: GARBAGE,
      [`worktrees/${LINKED}/ORIG_HEAD`]: GARBAGE,
      [`worktrees/${LINKED}/CHERRY_PICK_HEAD`]: 'garbage2\n',
    },
    origins: BOTH,
  },
  {
    given: 'several broken root refs in a linked worktree',
    runs: ORDER_RUNS,
    files: {
      [`worktrees/${LINKED}/AUTO_MERGE`]: '{commit}',
      [`worktrees/${LINKED}/REBASE_HEAD`]: GARBAGE,
      [`worktrees/${LINKED}/ORIG_HEAD`]: 'ref: refs/heads/main\n',
    },
    origins: FROM_MAIN,
  },
  {
    given: "a linked worktree's admin dir that can be searched but not read, beside garbage",
    files: { [LINKED_BISECT_BAD]: GARBAGE },
    restricted: { [NO_ADMIN_ACCESS]: SEARCH_ONLY },
    origins: FROM_MAIN,
  },
  {
    given: "a linked worktree's admin dir that can be searched but not read",
    restricted: { [NO_ADMIN_ACCESS]: SEARCH_ONLY },
    origins: FROM_MAIN,
  },
  {
    given: "a dying symbolic link in the main store and garbage in a linked worktree's bisect ref",
    links: { 'refs/heads/dead': 'nope/x' },
    files: bisectGarbage(LINKED),
    origins: BOTH,
  },
  {
    given: 'garbage in the main store and a dying symbolic link in a linked worktree',
    files: { 'refs/heads/g': GARBAGE },
    links: deadLinkAt(LINKED),
    origins: BOTH,
  },
  {
    given: 'garbage in the bisect refs of three linked worktrees',
    worktrees: ['zz', 'aa', 'mm'],
    files: { ...bisectGarbage('zz'), ...bisectGarbage('aa'), ...bisectGarbage('mm') },
    origins: FROM_MAIN,
    runs: ORDER_RUNS,
    sequence: true,
  },
  {
    given: 'a dying symbolic link in the bisect namespace of two linked worktrees',
    worktrees: ['zz', 'aa'],
    links: { ...deadLinkAt('zz'), ...deadLinkAt('aa') },
    origins: FROM_MAIN,
    runs: ORDER_RUNS,
  },
  {
    given: 'a reflog entry naming an absent object in two linked worktrees',
    worktrees: ['zz', 'aa'],
    files: { ...reflogEntryAt('zz'), ...reflogEntryAt('aa') },
    origins: FROM_MAIN,
    runs: ORDER_RUNS,
    sequence: true,
  },
  ...[
    'ref: main-worktree/HEAD\n',
    'ref: worktrees/wt/HEAD\n',
    'ref: worktrees/wt/refs/bisect/bad\n',
  ].map((body) => ({
    given: `a head that is a symbolic ref holding '${body.trim()}'`,
    files: { 'refs/heads/x': body, [BISECT_BAD]: COMMIT_LINE },
    origins: BOTH,
  })),
  {
    given: 'a head that is a symbolic ref to the main bisect ref through the main-worktree name',
    files: { 'refs/heads/x': 'ref: main-worktree/refs/bisect/bad\n', [BISECT_BAD]: COMMIT_LINE },
    origins: BOTH,
  },
  {
    given: "a named pipe as a linked worktree's bisect ref",
    fifos: [FIFO_BAD],
    origins: BOTH,
  },
  {
    given: "a named pipe as the main store's bisect ref",
    fifos: [BISECT_BAD],
    origins: FROM_MAIN,
  },
  {
    given: 'a named pipe as the root ref of the main store and of a linked worktree',
    fifos: ['BISECT_HEAD', `worktrees/${LINKED}/BISECT_HEAD`],
    origins: BOTH,
  },
  {
    given: 'a symbolic link to a named pipe as the main store root ref',
    fifos: [FIFO_TARGET],
    links: { BISECT_HEAD: FIFO_TARGET },
    origins: FROM_MAIN,
  },
  {
    given: "a symbolic link to a named pipe as a linked worktree's bisect ref",
    fifos: [FIFO_TARGET],
    links: { [FIFO_BAD]: `../../../../${FIFO_TARGET}` },
    origins: BOTH,
  },
  {
    given: `a linked worktree renamed to ${RENAMED_ADMIN} holding refs and root refs`,
    files: {
      [`worktrees/${LINKED}/${BISECT_BAD.replace('bad', 'good')}`]: COMMIT_LINE,
      [`worktrees/${LINKED}/ORIG_HEAD`]: COMMIT_LINE,
      [`worktrees/${LINKED}/BISECT_HEAD`]: COMMIT_LINE,
    },
    renamedAdmins: { [LINKED]: RENAMED_ADMIN },
    runs: ORDER_RUNS,
    origins: BOTH,
  },
  {
    given: 'a lock file whose directory can be listed but not searched',
    files: { 'refs/heads/sub/x.lock': COMMIT_LINE },
    restricted: { 'refs/heads/sub': READ_ONLY },
    origins: FROM_MAIN,
  },
  {
    given: 'a worktrees path that is a regular file',
    moved: { worktrees: 'worktrees.real' },
    blanks: ['worktrees'],
    origins: FROM_MAIN,
  },
  {
    given: 'a worktrees directory without any access',
    restricted: { worktrees: NO_ACCESS },
    origins: FROM_MAIN,
  },
];

const SEPARATE_BISECT_NAMES = [
  'main-worktree/HEAD',
  'worktrees/wt/HEAD',
  'worktrees/wt/refs/bisect/bad',
  'main-worktree/refs/heads/main',
  'worktrees/wt/refs/heads/side',
  'worktrees/nope/HEAD',
] as const;

const PACKED_PAIR_NAMES = [
  'main-worktree/refs/bisect/bad',
  'main-worktree/refs/bisect/packed',
  'main-worktree/refs/bisect/fullname',
  'main-worktree/ORIG_HEAD',
  'worktrees/wt',
] as const;

interface NameRow {
  readonly given: string;
  readonly shape: Shape;
  readonly names: ReadonlyArray<string>;
}

const nameRows: ReadonlyArray<NameRow> = [
  {
    given: 'a bisect ref in the admin dir of a linked worktree',
    shape: { given: 'x', files: { [LINKED_BISECT_BAD]: COMMIT_LINE } },
    names: SEPARATE_BISECT_NAMES,
  },
  {
    given: 'loose and packed bisect refs in the main store',
    shape: {
      given: 'x',
      files: { [BISECT_BAD]: COMMIT_LINE, ORIG_HEAD: COMMIT_LINE },
      packed: [
        `{commit} ${BISECT_BAD.replace('bad', 'packed')}`,
        '{commit} main-worktree/refs/bisect/fullname',
      ],
    },
    names: PACKED_PAIR_NAMES,
  },
];

interface ListingRow {
  readonly given: string;
  readonly shape: Shape;
  readonly origins: ReadonlyArray<string>;
}

const VT = 'vt';
const listingRows: ReadonlyArray<ListingRow> = [
  {
    given: 'lock files among the main store heads, one holding garbage and one a valid id',
    shape: {
      given: 'x',
      files: { 'refs/heads/x.lock': GARBAGE, 'refs/heads/y.lock': COMMIT_LINE },
    },
    origins: FROM_MAIN,
  },
  {
    given: "a dot-led lock file in a linked worktree's bisect namespace",
    shape: { given: 'x', files: { [`worktrees/${LINKED}/refs/bisect/.x.lock`]: GARBAGE } },
    origins: FROM_LINKED,
  },
  {
    given: 'a hand-made worktree admin dir whose refs is a file',
    shape: { given: 'x', handMade: { [VT]: { workDir: true, refsFile: true } } },
    origins: [VT],
  },
  {
    given: 'a symbolic link to a named pipe among the main store heads',
    shape: {
      given: 'x',
      fifos: [FIFO_TARGET],
      links: { 'refs/heads/pipe': `../../${FIFO_TARGET}` },
    },
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

const seedMoves = async (gitDir: string, moved: Readonly<Record<string, string>>) => {
  for (const [from, to] of Object.entries(moved)) {
    await rename(path.join(gitDir, from), path.join(gitDir, to));
  }
};

const seedFifos = async (gitDir: string, fifos: ReadonlyArray<string>) => {
  for (const relative of fifos) {
    await mkdir(path.dirname(path.join(gitDir, relative)), { recursive: true });
    execFileSync('mkfifo', [path.join(gitDir, relative)]);
  }
};

const seedAdminRenames = async (
  root: string,
  gitDir: string,
  renamed: Readonly<Record<string, string>>,
) => {
  for (const [id, newId] of Object.entries(renamed)) {
    const admin = path.join(gitDir, 'worktrees', newId);
    await rename(path.join(gitDir, 'worktrees', id), admin);
    await writeFile(path.join(root, MAIN, id, '.git'), `${GITFILE_PREFIX}${admin}\n`);
  }
};

const seedModes = async (gitDir: string, restricted: Readonly<Record<string, number>>) => {
  for (const [relative, mode] of Object.entries(restricted)) {
    refusedPaths.unshift(path.join(gitDir, relative));
    await chmod(path.join(gitDir, relative), mode);
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
  await seedFifos(gitDir, shape.fifos ?? []);
  for (const relative of shape.removed ?? []) await rm(path.join(gitDir, relative));
  await seedAdminRenames(root, gitDir, shape.renamedAdmins ?? {});
  await seedMoves(gitDir, shape.moved ?? {});
  for (const relative of shape.blanks ?? []) await writeUnder(gitDir, relative, '');
  await seedLinks(gitDir, shape.links ?? {}, fill);
  if (shape.packed !== undefined) {
    const lines = shape.packed.map((line) => `${fill(line)}\n`).join('');
    await writeFile(path.join(gitDir, 'packed-refs'), `${PACKED_HEADER}${lines}`);
  }
  for (const [key, value] of Object.entries(shape.config ?? {})) git(main, 'config', key, value);
  await seedModes(gitDir, shape.restricted ?? {});
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

/** A linked store's root ref file: its parent directory is `<main>/.git/worktrees/<id>`; the
 *  store's own `refs` directory sits there too, but it is a walk path, which git prints relative. */
const isLinkedRootRefFile = (arranged: Arranged, file: string): boolean =>
  path.basename(file) !== 'refs' &&
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
    case 'badRefFiletype':
      return 'unexpected file type';
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

const othersOf = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines.filter((line) => !POINTER_LINE.test(line));

const othersFor = (row: Row, lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  row.sequence === true ? othersOf(lines) : [...othersOf(lines)].sort();

const attemptsOf = (row: Row): ReadonlyArray<number> =>
  Array.from({ length: row.runs ?? 1 }, (_, index) => index + 1);

const needsPrivilege = (row: Row): boolean => row.restricted !== undefined && !UNPRIVILEGED;

const needsPosix = (row: Row): boolean =>
  WINDOWS && (row.fifos !== undefined || row.renamedAdmins !== undefined);

const unrunnable = (row: Row): boolean => needsPrivilege(row) || needsPosix(row);

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

const lastLineOf = (text: string): string => text.trim().split('\n').at(-1) ?? '';

const linesOf = (text: string): ReadonlyArray<string> =>
  text
    .split('\n')
    .filter((line) => line !== '')
    .sort();

const namesUnderRefs = (names: ReadonlyArray<string>): ReadonlyArray<string> =>
  names.filter((name) => name.startsWith('refs/')).sort();

interface Resolution {
  readonly exitCode: number;
  readonly line: string;
}

/** git's `rev-parse --verify` outcome, rebuilt from the structured entries or the refusal code. */
const resolution = async (
  repo: Awaited<ReturnType<typeof open>>,
  name: string,
): Promise<Resolution> => {
  try {
    return { exitCode: 0, line: revParseStdout(await repo.revParse(name)) };
  } catch (error) {
    if (error instanceof TsgitError && error.data.code === 'OBJECT_NOT_FOUND') {
      return { exitCode: FATAL_EXIT, line: 'fatal: Needed a single revision' };
    }
    throw error;
  }
};

describe.skipIf(!GIT_AVAILABLE)('fsck worktree private refs interop', () => {
  describe.each(rows.filter((row) => row.fatal === undefined))('Given $given', (row) => {
    describe.each(originsOf(row))('When fsck runs from $label', ({ from }) => {
      it.skipIf(unrunnable(row)).each(attemptsOf(row))(
        'Then tsgit reports git’s lines and exit code (throwaway %i)',
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
          expect(othersFor(row, ours)).toEqual(othersFor(row, theirs));
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

  describe.each(nameRows)('Given $given', ({ shape, names }) => {
    describe.each([MAIN, LINKED])('When rev-parse runs from %s', (from) => {
      it.each(names)(
        'Then tsgit resolves %s as git does',
        async (name) => {
          // Arrange
          const arranged = await seed(shape, from);
          const expected = tryRunGitWithExit(['-C', arranged.cwd, 'rev-parse', '--verify', name]);
          const sut = await open({ cwd: arranged.cwd });

          // Act
          const outcome = await resolution(sut, name);

          // Assert
          expect(outcome.exitCode).toBe(expected.exitCode);
          expect(outcome.line).toBe(
            lastLineOf(expected.exitCode === 0 ? expected.stdout : expected.stderr),
          );
        },
        SETUP_TIMEOUT,
      );
    });
  });

  describe.each(listingRows)('Given $given', ({ shape, origins }) => {
    describe.each(origins)('When refs are listed from %s', (from) => {
      it(
        'Then tsgit lists the names git lists',
        async () => {
          // Arrange
          const arranged = await seed(shape, from);
          const expected = tryRunGitWithExit([
            '-C',
            arranged.cwd,
            'for-each-ref',
            '--format=%(refname)',
          ]);
          const sut = getRefStore((await open({ cwd: arranged.cwd })).ctx);

          // Act
          const names = await sut.listRefNames();

          // Assert
          expect(expected.exitCode).toBe(0);
          expect(namesUnderRefs(names)).toEqual(linesOf(expected.stdout));
        },
        SETUP_TIMEOUT,
      );
    });
  });
});
