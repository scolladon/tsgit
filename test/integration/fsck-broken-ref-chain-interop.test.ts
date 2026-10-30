/**
 * Cross-tool interop — `fsck` over refs whose chain fails to resolve.
 *
 * Every ref a broken chain touches is reported by git with a zero pointer. Each row seeds
 * a repository, runs real `git fsck` and tsgit's `fsck` on it, rebuilds git's stderr lines
 * from tsgit's structured findings and compares: exit codes equal, pointer lines in
 * sequence, every other line as a sorted multiset.
 *
 * @proves
 *   surface:        fsck
 *   bucket:         cross-tool-interop
 *   unique:         tsgit reports a zero pointer on every ref of a broken chain, as git does
 *   interopSurface: fsck
 */
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { type FsckOptions, type FsckResult, fsck } from '../../src/application/commands/fsck.js';
import { __resetConfigCacheForTests } from '../../src/application/primitives/config-read.js';
import { openRepository } from '../../src/index.node.js';
import { GIT_AVAILABLE, runGit, tryRunGitWithExit } from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;
const ABSENT_OID = '1'.repeat(40);
const POINTER_LINE = /^error: .*: invalid sha1 pointer /;
const REPORT_LINE = /^(error|warning|notice): /;
const TRAILING_BYTES = /[ \t\r\n]+$/;
const POSIX = process.platform !== 'win32';
const UNPRIVILEGED = POSIX && process.getuid?.() !== 0;
const REFUSED = 0o000;
const RESTORED = 0o755;
const LINKED_ID = 'wt';

type Fill = (text: string) => string;

interface Row {
  readonly title: string;
  /** Loose ref files by name under `refs/heads/`; `{commit}` stands for a real commit id. */
  readonly refs: Readonly<Record<string, string>>;
  readonly packed?: Readonly<Record<string, string>>;
  readonly head?: string;
  /** Files directly under the gitdir, by name. */
  readonly root?: Readonly<Record<string, string>>;
  readonly config?: Readonly<Record<string, string>>;
  readonly flags?: ReadonlyArray<string>;
  readonly options?: FsckOptions;
  readonly commit?: boolean;
  /** Loose symbolic links by name under `refs/heads/`, to the link text. */
  readonly links?: Readonly<Record<string, string>>;
  /** Loose ref files by name under `refs/tags/`. */
  readonly tags?: Readonly<Record<string, string>>;
  /** Gitdir-relative paths whose mode is 000 once seeded. */
  readonly unreadable?: ReadonlyArray<string>;
  /** Files by gitdir-relative path, their directories created. */
  readonly files?: Readonly<Record<string, string>>;
  /** Gitdir-relative paths given a specific mode once seeded. */
  readonly restricted?: Readonly<Record<string, number>>;
  /** A linked worktree, its admin dir `worktrees/wt`. */
  readonly linked?: boolean;
  /** Where the command runs from: a sub-directory, or an explicit `--git-dir`. */
  readonly via?: 'sub' | 'gitdir';
}

const GARBAGE = 'garbage\n';
const toB = 'ref: refs/heads/b\n';

const rows: ReadonlyArray<Row> = [
  { title: 'root ref BAR_HEAD holding garbage', refs: {}, root: { BAR_HEAD: GARBAGE } },
  {
    title: 'root-ref order, refs/ findings come before root refs',
    refs: { a: GARBAGE },
    root: { BAR_HEAD: GARBAGE },
  },
  {
    title: 'root ref ZED_HEAD, a root ref sorting last holding garbage',
    refs: { z: GARBAGE },
    root: { ZED_HEAD: GARBAGE },
  },
  {
    title: 'FETCH-PSEUDO, FETCH_HEAD is not a root ref',
    refs: {},
    root: { FETCH_HEAD: GARBAGE },
  },
  { title: 'A-garbage, symbolic ref first', refs: { a: toB, b: GARBAGE } },
  { title: 'A-garbage, symbolic ref last', refs: { z: toB, b: GARBAGE } },
  { title: 'A-abc, symbolic ref first', refs: { a: toB, b: 'abc\n' } },
  { title: 'A-abc, symbolic ref last', refs: { z: toB, b: 'abc\n' } },
  { title: 'A-empty, symbolic ref first', refs: { a: toB, b: '' } },
  { title: 'A-empty, symbolic ref last', refs: { z: toB, b: '' } },
  {
    title: 'CH3, chain first',
    refs: { a: toB, b: 'ref: refs/heads/c\n', c: GARBAGE },
  },
  {
    title: 'CH3, chain last',
    refs: { z: 'ref: refs/heads/y\n', y: 'ref: refs/heads/x\n', x: GARBAGE },
  },
  { title: 'ORDER, symbolic ref sorting after the garbage', refs: { z: toB, b: GARBAGE } },
  { title: 'ORDER, symbolic ref sorting before the garbage', refs: { a: toB, b: GARBAGE } },
  {
    title: 'HT, HEAD on the only ref',
    refs: { main: GARBAGE },
    head: 'ref: refs/heads/main\n',
  },
  {
    title: 'HC, HEAD through a ref sorting first',
    refs: { aa: toB, b: GARBAGE, keep: '{commit}\n' },
    head: 'ref: refs/heads/aa\n',
    commit: true,
  },
  {
    title: 'HC, HEAD through a ref sorting last',
    refs: { zz: toB, b: GARBAGE, keep: '{commit}\n' },
    head: 'ref: refs/heads/zz\n',
    commit: true,
  },
  {
    title: 'PK-ok, loose ref onto a packed one, first',
    refs: { a: 'ref: refs/heads/p\n' },
    packed: { p: '{commit}' },
    commit: true,
  },
  {
    title: 'PK-ok, loose ref onto a packed one, last',
    refs: { z: 'ref: refs/heads/p\n' },
    packed: { p: '{commit}' },
    commit: true,
  },
  {
    title: 'PK-abs, loose ref onto an absent packed one, first',
    refs: { a: toB },
    packed: { b: ABSENT_OID },
  },
  {
    title: 'PK-abs, loose ref onto an absent packed one, last',
    refs: { z: toB },
    packed: { b: ABSENT_OID },
  },
  { title: 'C-dangling, first', refs: { a: toB } },
  { title: 'C-dangling, last', refs: { z: toB } },
  {
    title: 'S1, badRefContent ignored, first',
    refs: { a: toB, b: GARBAGE },
    config: { 'fsck.badRefContent': 'ignore' },
  },
  {
    title: 'S1, badRefContent ignored, last',
    refs: { z: toB, b: GARBAGE },
    config: { 'fsck.badRefContent': 'ignore' },
  },
  {
    title: 'S2, badRefContent as a warning, first',
    refs: { a: toB, b: GARBAGE },
    config: { 'fsck.badRefContent': 'warn' },
  },
  {
    title: 'S2, badRefContent as a warning, last',
    refs: { z: toB, b: GARBAGE },
    config: { 'fsck.badRefContent': 'warn' },
  },
  {
    title: 'N, references not checked, first',
    refs: { a: toB, b: GARBAGE },
    flags: ['--no-references'],
    options: { checkReferences: false },
  },
  {
    title: 'N, references not checked, last',
    refs: { z: toB, b: GARBAGE },
    flags: ['--no-references'],
    options: { checkReferences: false },
  },
  {
    title: 'co, connectivity only, first',
    refs: { a: toB, b: GARBAGE },
    flags: ['--connectivity-only'],
    options: { connectivityOnly: true },
  },
  {
    title: 'co, connectivity only, last',
    refs: { z: toB, b: GARBAGE },
    flags: ['--connectivity-only'],
    options: { connectivityOnly: true },
  },
];

const SHA = '{commit}\n';
const HEAD_ON = (name: string): string => `ref: refs/heads/${name}\n`;
const heads = (name: string): string => `refs/heads/${name}`;
const NO_REFERENCES = { flags: ['--no-references'], options: { checkReferences: false } } as const;

/** Each shape twice: the seeded name sorting first, then last. */
const sortedBothEnds = (
  title: string,
  build: (name: string) => Omit<Row, 'title'>,
): ReadonlyArray<Row> =>
  (['a', 'z'] as const).map((name) => ({
    title: `${title}, name ${name === 'a' ? 'first' : 'last'}`,
    ...build(name),
  }));

const refusedRows: ReadonlyArray<Row> = [
  ...sortedBothEnds('B-with-a, the link and its unreadable target', (name) => ({
    refs: { [name]: HEAD_ON('b'), b: SHA },
    unreadable: [heads('b')],
    commit: true,
  })),
  ...sortedBothEnds('B-alone, one unreadable ref', (name) => ({
    refs: { [name]: SHA },
    unreadable: [heads(name)],
    commit: true,
  })),
  ...sortedBothEnds('B-alone-nr, references not checked', (name) => ({
    refs: { [name]: SHA },
    unreadable: [heads(name)],
    commit: true,
    ...NO_REFERENCES,
  })),
  ...sortedBothEnds('B-alone-co, connectivity only', (name) => ({
    refs: { [name]: SHA },
    unreadable: [heads(name)],
    commit: true,
    flags: ['--connectivity-only'],
    options: { connectivityOnly: true },
  })),
  ...sortedBothEnds('B-with-a-nr, references not checked', (name) => ({
    refs: { [name]: HEAD_ON('b'), b: SHA },
    unreadable: [heads('b')],
    commit: true,
    ...NO_REFERENCES,
  })),
  {
    title: 'ORD-U, a link sorting after the unreadable target and a healthy ref',
    refs: { z: HEAD_ON('b'), b: SHA, c: SHA },
    unreadable: [heads('b')],
    commit: true,
  },
  ...sortedBothEnds('TAG, an unreadable tag', (name) => ({
    refs: {},
    tags: { [name]: SHA },
    unreadable: [`refs/tags/${name}`],
    commit: true,
  })),
  ...sortedBothEnds('U-sym, an unreadable symbolic ref', (name) => ({
    refs: { [name]: HEAD_ON('main') },
    unreadable: [heads(name)],
  })),
  ...sortedBothEnds('U-shadow, an unreadable loose ref shadowing a packed one', (name) => ({
    refs: { [name]: SHA },
    packed: { [name]: '{commit}' },
    unreadable: [heads(name)],
    commit: true,
  })),
  ...sortedBothEnds('U-sev, neighbouring ids ignored', (name) => ({
    refs: { [name]: SHA },
    unreadable: [heads(name)],
    commit: true,
    config: { 'fsck.badRefContent': 'ignore', 'fsck.badRefOid': 'ignore' },
  })),
  ...sortedBothEnds('U-strict, strict mode', (name) => ({
    refs: { [name]: SHA },
    unreadable: [heads(name)],
    commit: true,
    flags: ['--strict'],
    options: { strict: true },
  })),
  ...sortedBothEnds('U-sub, run from a sub-directory', (name) => ({
    refs: { [name]: SHA },
    unreadable: [heads(name)],
    commit: true,
    via: 'sub' as const,
  })),
  ...sortedBothEnds('U-gd, run with an explicit git dir', (name) => ({
    refs: { [name]: SHA },
    unreadable: [heads(name)],
    commit: true,
    via: 'gitdir' as const,
  })),
  {
    title: 'ORD, unreadable z, garbage a and an unreadable linked HEAD',
    refs: { z: SHA, a: GARBAGE },
    unreadable: [heads('z'), `worktrees/${LINKED_ID}/HEAD`],
    commit: true,
    linked: true,
  },
  ...sortedBothEnds('L-U000, a link onto an unreadable file', (name) => ({
    refs: { m: SHA },
    links: { [name]: 'm' },
    unreadable: [heads('m')],
    commit: true,
  })),
  ...sortedBothEnds(
    'L-U000-nr, a link onto an unreadable file, references not checked',
    (name) => ({
      refs: { m: SHA },
      links: { [name]: 'm' },
      unreadable: [heads('m')],
      commit: true,
      ...NO_REFERENCES,
    }),
  ),
  {
    title: 'ROOT-U, an unreadable root ref listed before one holding garbage',
    refs: {},
    root: { AAA_HEAD: SHA, ZED_HEAD: GARBAGE },
    unreadable: ['AAA_HEAD'],
    commit: true,
  },
  {
    title: 'ROOT-U, a root ref holding garbage listed before an unreadable one',
    refs: {},
    root: { AAA_HEAD: GARBAGE, ZED_HEAD: SHA },
    unreadable: ['ZED_HEAD'],
    commit: true,
  },
  {
    title: 'U-only, the only ref is unreadable',
    refs: { main: SHA },
    unreadable: [heads('main')],
    commit: true,
  },
  {
    title: 'HU, HEAD on an unreadable branch beside a healthy one',
    refs: { main: SHA, keep: SHA },
    head: HEAD_ON('main'),
    unreadable: [heads('main')],
    commit: true,
  },
  {
    title: 'HU-nr, HEAD on an unreadable branch, references not checked',
    refs: { main: SHA, keep: SHA },
    head: HEAD_ON('main'),
    unreadable: [heads('main')],
    commit: true,
    ...NO_REFERENCES,
  },
  {
    title: 'W, a linked worktree HEAD is unreadable',
    refs: { main: SHA },
    unreadable: [`worktrees/${LINKED_ID}/HEAD`],
    commit: true,
    linked: true,
  },
  {
    title: 'W-nr, a linked worktree HEAD is unreadable, references not checked',
    refs: { main: SHA },
    unreadable: [`worktrees/${LINKED_ID}/HEAD`],
    commit: true,
    linked: true,
    ...NO_REFERENCES,
  },
];

const DIR_MODE_LISTABLE_ONLY = 0o400;
const DIR_MODE_SEARCHABLE_ONLY = 0o300;
const STRICT = { flags: ['--strict'], options: { strict: true } } as const;
const CONNECTIVITY = {
  flags: ['--connectivity-only'],
  options: { connectivityOnly: true },
} as const;

/** A refused directory holding refs, beside a healthy `main`. */
const refusedDir = (
  name: string,
  extra: Omit<Row, 'title' | 'refs'> = {},
  refs = {},
): Omit<Row, 'title'> => ({
  refs: { main: SHA, [`${name}/x`]: SHA, ...refs },
  restricted: { [heads(name)]: REFUSED },
  commit: true,
  ...extra,
});

const dirRows: ReadonlyArray<Row> = [
  ...sortedBothEnds('DIR, an unreadable directory', (name) => refusedDir(name)),
  ...sortedBothEnds('DIR-strict, strict mode', (name) => refusedDir(name, STRICT)),
  ...sortedBothEnds('DIR-co, connectivity only', (name) => refusedDir(name, CONNECTIVITY)),
  ...sortedBothEnds('DIR-nr, references not checked', (name) => refusedDir(name, NO_REFERENCES)),
  {
    title: 'DIR-AZ, two unreadable directories',
    ...refusedDir('a', {}, { 'z/x': SHA }),
    restricted: { [heads('a')]: REFUSED, [heads('z')]: REFUSED },
  },
  ...sortedBothEnds('DIR-N, a nested unreadable directory', (name) => ({
    refs: { main: SHA, [`${name}/y`]: SHA, [`${name}/e/x`]: SHA },
    restricted: { [heads(`${name}/e`)]: REFUSED },
    commit: true,
  })),
  {
    title: 'DIR-T, unreadable tag and remote directories',
    refs: { main: SHA },
    files: { 'refs/tags/td/x': SHA, 'refs/remotes/o/x': SHA },
    restricted: { 'refs/tags/td': REFUSED, 'refs/remotes/o': REFUSED },
    commit: true,
  },
  ...sortedBothEnds('DIR-ONLY, the only ref sits in an unreadable directory', (name) => ({
    refs: { [`${name}/x`]: SHA },
    restricted: { [heads(name)]: REFUSED },
    commit: true,
  })),
  ...sortedBothEnds('DIR-ONLY-nr, references not checked', (name) => ({
    refs: { [`${name}/x`]: SHA },
    restricted: { [heads(name)]: REFUSED },
    commit: true,
    ...NO_REFERENCES,
  })),
  {
    title: 'DIR-HEADS, refs/heads itself is unreadable, HEAD detached',
    refs: { main: SHA },
    head: SHA,
    restricted: { 'refs/heads': REFUSED },
    commit: true,
  },
  {
    title: 'DIR-HEADS-nr, refs/heads itself is unreadable, HEAD detached, references not checked',
    refs: { main: SHA },
    head: SHA,
    restricted: { 'refs/heads': REFUSED },
    commit: true,
    ...NO_REFERENCES,
  },
  {
    title: 'DIR-HEADS, refs/heads itself is unreadable, HEAD symbolic',
    refs: { main: SHA },
    head: HEAD_ON('main'),
    restricted: { 'refs/heads': REFUSED },
    commit: true,
  },
  {
    title: 'DIR-HEADS-nr, refs/heads itself is unreadable, HEAD symbolic, references not checked',
    refs: { main: SHA },
    head: HEAD_ON('main'),
    restricted: { 'refs/heads': REFUSED },
    commit: true,
    ...NO_REFERENCES,
  },
  ...sortedBothEnds('DIR-PK, a packed ref under an unreadable loose directory', (name) => ({
    refs: { main: SHA, [`${name}/y`]: SHA },
    packed: { [`${name}/x`]: '{commit}' },
    restricted: { [heads(name)]: REFUSED },
    commit: true,
  })),
  ...sortedBothEnds('DIR-CH, a link onto a ref in an unreadable directory', (name) => ({
    refs: { main: SHA, [name]: HEAD_ON('d/x'), 'd/x': SHA },
    restricted: { [heads('d')]: REFUSED },
    commit: true,
  })),
  ...sortedBothEnds('DIR-CH-nr, references not checked', (name) => ({
    refs: { main: SHA, [name]: HEAD_ON('d/x'), 'd/x': SHA },
    restricted: { [heads('d')]: REFUSED },
    commit: true,
    ...NO_REFERENCES,
  })),
  ...sortedBothEnds('DIR-SEARCH, a listable directory that cannot be searched', (name) => ({
    refs: { main: SHA, [`${name}/x`]: SHA },
    restricted: { [heads(name)]: DIR_MODE_LISTABLE_ONLY },
    commit: true,
  })),
  ...sortedBothEnds('DIR-SEARCH-nr, references not checked', (name) => ({
    refs: { main: SHA, [`${name}/x`]: SHA },
    restricted: { [heads(name)]: DIR_MODE_LISTABLE_ONLY },
    commit: true,
    ...NO_REFERENCES,
  })),
  ...sortedBothEnds('DIR-300, a searchable directory that cannot be listed', (name) =>
    refusedDir(name, { restricted: { [heads(name)]: DIR_MODE_SEARCHABLE_ONLY } }),
  ),
  ...sortedBothEnds('DIR-LINK-in, a link beside an unreadable directory', (name) => ({
    refs: { main: SHA, 'real/x': SHA },
    links: { [name]: 'real' },
    restricted: { [heads('real')]: REFUSED },
    commit: true,
  })),
];

const DOTS = 'ref: x..y\n';
const BAD_REFERENT = 'fsck.badReferentName';
const NOT_A_REF = 'fsck.symrefTargetIsNotARef';
const WARN_BAD_REFERENT = { config: { [BAD_REFERENT]: 'warn' } } as const;

/** Each referent git judges, the body `ref: <referent>\n` seeded alone. */
const REFERENTS: ReadonlyArray<string> = [
  'foo',
  'main',
  'refs',
  'refs/foo',
  'refs/heads/@',
  'HEAD',
  'FETCH_HEAD',
  'MERGE_HEAD',
  'ORIG_HEAD',
  'FOO_HEAD',
  'A_HEAD',
  '_HEAD',
  'FO-O_HEAD',
  'BISECT_HEAD',
  'FOO1_HEAD',
  'Foo_HEAD',
  'AUTO_MERGE',
  'BISECT_EXPECTED_REV',
  'MERGE_AUTOSTASH',
  'NOTES_MERGE_PARTIAL',
  'NOTES_MERGE_REF',
  'refs/heads/x.lock',
  'refs/heads/',
  'refs/heads/.x',
  'refs/heads/a b',
  'refs/heads/ma*n',
  '@',
  'refs/heads/x..y',
  'x..y',
  'foo/bar',
];

const referentRows: ReadonlyArray<Row> = [
  ...sortedBothEnds('dots referent behind a symbolic ref', (name) => ({
    refs: { [name]: toB, b: DOTS },
  })),
  ...sortedBothEnds('dots referent behind a chain of three', (name) => ({
    refs: { [name]: toB, b: 'ref: refs/heads/c\n', c: DOTS },
  })),
  ...sortedBothEnds('dots referent with no symbolic ref pointing at it', (name) => ({
    refs: { [name]: DOTS },
  })),
  { title: 'dots referent on HEAD', refs: {}, head: 'ref: refs/heads/x..y\n' },
  ...sortedBothEnds('badReferentName as a warning', (name) => ({
    refs: { [name]: toB, b: DOTS },
    ...WARN_BAD_REFERENT,
  })),
  ...sortedBothEnds('badReferentName ignored', (name) => ({
    refs: { [name]: toB, b: DOTS },
    config: { [BAD_REFERENT]: 'ignore' },
  })),
  ...sortedBothEnds('badReferentName warned and symrefTargetIsNotARef ignored', (name) => ({
    refs: { [name]: DOTS },
    config: { [BAD_REFERENT]: 'warn', [NOT_A_REF]: 'ignore' },
  })),
  ...sortedBothEnds('badReferentName warned under strict', (name) => ({
    refs: { [name]: DOTS },
    ...WARN_BAD_REFERENT,
    ...STRICT,
  })),
  {
    title: 'badReferentName warned on HEAD',
    refs: {},
    head: 'ref: refs/heads/x..y\n',
    ...WARN_BAD_REFERENT,
  },
  ...sortedBothEnds('symrefTargetIsNotARef as an error', (name) => ({
    refs: { [name]: 'ref: foo/bar\n' },
    config: { [NOT_A_REF]: 'error' },
  })),
  ...sortedBothEnds('symrefTargetIsNotARef as an error, references not checked', (name) => ({
    refs: { [name]: 'ref: foo/bar\n' },
    config: { [NOT_A_REF]: 'error' },
    ...NO_REFERENCES,
  })),
  ...sortedBothEnds('symrefTargetIsNotARef under strict', (name) => ({
    refs: { [name]: 'ref: foo/bar\n' },
    ...STRICT,
  })),
  ...sortedBothEnds('badReferentName warned on a pseudo ref referent', (name) => ({
    refs: { [name]: 'ref: FETCH_HEAD\n' },
    ...WARN_BAD_REFERENT,
  })),
  ...sortedBothEnds('dots referent, references not checked', (name) => ({
    refs: { [name]: toB, b: DOTS },
    ...NO_REFERENCES,
  })),
  ...sortedBothEnds('dots referent, connectivity only', (name) => ({
    refs: { [name]: toB, b: DOTS },
    ...CONNECTIVITY,
  })),
  ...REFERENTS.flatMap((referent) =>
    sortedBothEnds(`referent grammar, ${JSON.stringify(referent)}`, (name) => ({
      refs: { [name]: `ref: ${referent}\n` },
    })),
  ),
  ...sortedBothEnds('symref with no space after the keyword', (name) => ({
    refs: { main: SHA, [name]: 'ref:refs/heads/main\n' },
    commit: true,
  })),
  ...sortedBothEnds('symref with two spaces after the keyword', (name) => ({
    refs: { main: SHA, [name]: 'ref:  refs/heads/main\n' },
    commit: true,
  })),
  ...sortedBothEnds('symref with a tab after the keyword', (name) => ({
    refs: { main: SHA, [name]: 'ref:\trefs/heads/main\n' },
    commit: true,
  })),
  ...sortedBothEnds('symref with a vertical tab after the keyword', (name) => ({
    refs: { main: SHA, [name]: 'ref:\vrefs/heads/main\n' },
    commit: true,
  })),
  ...sortedBothEnds('symref with a form feed after the keyword', (name) => ({
    refs: { main: SHA, [name]: 'ref:\frefs/heads/main\n' },
    commit: true,
  })),
  ...sortedBothEnds('symref with a vertical tab before the line feed', (name) => ({
    refs: { main: SHA, [name]: 'ref: refs/heads/main\v\n' },
    commit: true,
  })),
  ...sortedBothEnds('symref followed by a second line', (name) => ({
    refs: { main: SHA, [name]: 'ref: refs/heads/main\nextra\n' },
    commit: true,
  })),
  ...sortedBothEnds('symref followed by garbage on its line', (name) => ({
    refs: { main: SHA, [name]: 'ref: refs/heads/main garbage\n' },
    commit: true,
  })),
  ...sortedBothEnds('upper case object name', (name) => ({
    refs: { [name]: '{COMMIT}\n' },
    commit: true,
  })),
  ...sortedBothEnds('half upper case object name', (name) => ({
    refs: { [name]: '{MIXED}\n' },
    commit: true,
  })),
  ...sortedBothEnds('object name with garbage glued on', (name) => ({
    refs: { [name]: '{commit}garbage\n' },
    commit: true,
  })),
  ...sortedBothEnds('object name one digit short', (name) => ({
    refs: { [name]: '{SHORT}\n' },
    commit: true,
  })),
  ...sortedBothEnds('object name one digit long', (name) => ({
    refs: { [name]: '{commit}0\n' },
    commit: true,
  })),
  ...sortedBothEnds('sixty-four digit object name in a sha1 repository', (name) => ({
    refs: { [name]: `${'a'.repeat(64)}\n` },
  })),
  ...sortedBothEnds('object name then a vertical tab', (name) => ({
    refs: { [name]: '{commit}\v\n' },
    commit: true,
  })),
  ...sortedBothEnds('empty ref file', (name) => ({ refs: { [name]: '' } })),
];

const roots: string[] = [];
const refusedPaths: string[] = [];

afterEach(async () => {
  __resetConfigCacheForTests();
  await Promise.all(refusedPaths.splice(0).map((file) => chmod(file, RESTORED)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const git = (dir: string, ...args: ReadonlyArray<string>): string => runGit(['-C', dir, ...args]);

const commitOf = (dir: string): string => {
  const tree = git(dir, 'hash-object', '-t', 'tree', '-w', '--stdin').trim();
  return git(dir, 'commit-tree', tree, '-m', 'c').trim();
};

const seedExtras = async (dir: string, row: Row, fill: Fill): Promise<void> => {
  const gitDir = path.join(dir, '.git');
  for (const [name, target] of Object.entries(row.links ?? {})) {
    await symlink(target, path.join(gitDir, 'refs', 'heads', name));
  }
  await mkdir(path.join(gitDir, 'refs', 'tags'), { recursive: true });
  for (const [name, body] of Object.entries(row.tags ?? {})) {
    await writeFile(path.join(gitDir, 'refs', 'tags', name), fill(body));
  }
  await mkdir(path.join(dir, 'sub'), { recursive: true });
  if (row.linked === true)
    git(dir, 'worktree', 'add', '-q', '--detach', path.join(dir, LINKED_ID), fill('{commit}'));
  for (const [relative, body] of Object.entries(row.files ?? {})) {
    await mkdir(path.dirname(path.join(gitDir, relative)), { recursive: true });
    await writeFile(path.join(gitDir, relative), fill(body));
  }
  const modes = [
    ...(row.unreadable ?? []).map((relative): [string, number] => [relative, REFUSED]),
    ...Object.entries(row.restricted ?? {}),
  ];
  for (const [relative, mode] of modes) {
    const file = path.join(gitDir, relative);
    refusedPaths.unshift(file);
    await chmod(file, mode);
  }
};

const MIXED_CASE_DIGITS = 20;
const SHORT_DIGITS = 39;

const seed = async (row: Row): Promise<{ readonly dir: string; readonly fill: Fill }> => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-chain-')));
  roots.push(dir);
  runGit(['init', '-q', '-b', 'main', dir]);
  const commit = row.commit === true ? commitOf(dir) : '';
  const fill: Fill = (text) =>
    text
      .replaceAll('{commit}', commit)
      .replaceAll('{COMMIT}', commit.toUpperCase())
      .replaceAll(
        '{MIXED}',
        commit.slice(0, MIXED_CASE_DIGITS).toUpperCase() + commit.slice(MIXED_CASE_DIGITS),
      )
      .replaceAll('{SHORT}', commit.slice(0, SHORT_DIGITS));
  const heads = path.join(dir, '.git', 'refs', 'heads');
  await mkdir(heads, { recursive: true });
  for (const [name, body] of Object.entries(row.refs)) {
    await mkdir(path.dirname(path.join(heads, name)), { recursive: true });
    await writeFile(path.join(heads, name), fill(body));
  }
  if (row.packed !== undefined) {
    const lines = Object.entries(row.packed).map(([n, id]) => `${fill(id)} refs/heads/${n}\n`);
    await writeFile(
      path.join(dir, '.git', 'packed-refs'),
      `# pack-refs with: peeled sorted \n${lines.join('')}`,
    );
  }
  for (const [name, body] of Object.entries(row.root ?? {})) {
    await writeFile(path.join(dir, '.git', name), fill(body));
  }
  if (row.head !== undefined) await writeFile(path.join(dir, '.git', 'HEAD'), fill(row.head));
  for (const [key, value] of Object.entries(row.config ?? {})) git(dir, 'config', key, value);
  await seedExtras(dir, row, fill);
  return { dir, fill };
};

/** git's report lines (`error:`, `warning:`, `notice:`) from its stderr. */
const gitReportLines = (stderr: string): ReadonlyArray<string> =>
  stderr.split('\n').filter((line) => REPORT_LINE.test(line));

const LINKED_ADMIN = `${path.sep}.git${path.sep}worktrees${path.sep}`;

/** git prints a path from the top level, but a linked worktree's admin dir and an explicit
 *  `--git-dir` stay absolute. */
const printedPath = (dir: string, file: string, row: Row): string =>
  row.via === 'gitdir' || file.includes(LINKED_ADMIN) ? file : path.relative(dir, file);

/** The same lines rebuilt from tsgit's findings; the seeded bodies stand for the content. */
const rebuiltLines = (
  result: FsckResult,
  row: Row,
  dir: string,
  fill: Fill,
): ReadonlyArray<string> =>
  result.findings.flatMap((finding) => {
    if (finding.type === 'no-default-references') return ['notice: No default references'];
    if (finding.type === 'unreadable-ref-path') {
      const shown = printedPath(dir, finding.path, row);
      return finding.operation === 'open-directory'
        ? [`warning: error opening directory '${shown}${path.sep}': Permission denied`]
        : [`warning: failed to stat '${shown}': Permission denied`];
    }
    if (finding.type !== 'bad-ref') return [];
    const label = finding.severity === 'error' ? 'error' : 'warning';
    if (finding.msgId === 'badRefOid') {
      return [`error: ${finding.ref}: invalid sha1 pointer ${finding.target}`];
    }
    if (finding.msgId === 'cannotReadRef') {
      const shown = printedPath(dir, finding.path ?? '', row);
      return [`error: cannot read ref file '${shown}': Permission denied`];
    }
    if (finding.msgId === 'symlinkRef') {
      return [`${label}: ${finding.ref}: symlinkRef: use deprecated symbolic link for symref`];
    }
    if (finding.msgId === 'badReferentName') {
      return [
        `${label}: ${finding.ref}: badReferentName: points to invalid refname '${displayed(finding.referent ?? '')}'`,
      ];
    }
    if (finding.msgId === 'symrefTargetIsNotARef') {
      return [
        `${label}: ${finding.ref}: symrefTargetIsNotARef: points to non-ref target '${displayed(finding.referent ?? '')}'`,
      ];
    }
    const body = row.root?.[finding.ref] ?? row.refs[finding.ref.replace('refs/heads/', '')] ?? '';
    return [
      `${label}: ${finding.ref}: ${finding.msgId}: ${displayed(fill(body).replace(TRAILING_BYTES, ''))}`,
    ];
  });

const LINE_FEED_CODE = 0x0a;
const FIRST_PRINTABLE_CODE = 0x20;
const DELETE_CODE = 0x7f;

/** git prints every control byte but LF as `?`. */
const displayed = (text: string): string =>
  [...text]
    .map((char) => {
      const code = char.charCodeAt(0);
      const control = code < FIRST_PRINTABLE_CODE || code === DELETE_CODE;
      return control && code !== LINE_FEED_CODE ? '?' : char;
    })
    .join('');

const pointersOf = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines.filter((line) => POINTER_LINE.test(line));
const othersOf = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines.filter((line) => !POINTER_LINE.test(line)).sort();

const gitArgs = (dir: string, row: Row): ReadonlyArray<string> => {
  const flags = row.flags ?? [];
  if (row.via === 'gitdir') return [`--git-dir=${path.join(dir, '.git')}`, 'fsck', ...flags];
  const cwd = row.via === 'sub' ? path.join(dir, 'sub') : dir;
  return ['-C', cwd, 'fsck', ...flags];
};

const runTsgit = async (dir: string, row: Row): Promise<FsckResult> => {
  if (row.via !== 'sub') return fsck(createNodeContext({ workDir: dir }), row.options);
  const repo = await openRepository({ cwd: path.join(dir, 'sub') });
  return repo.fsck(row.options);
};

const expectGitsLines = async (row: Row): Promise<void> => {
  // Arrange
  const { dir, fill } = await seed(row);
  const expected = tryRunGitWithExit(gitArgs(dir, row));
  const sut = runTsgit;

  // Act
  const result = await sut(dir, row);

  // Assert
  const gitLines = gitReportLines(expected.stderr);
  const ourLines = rebuiltLines(result, row, dir, fill)
    .flatMap((line) => line.split('\n'))
    .filter((line) => REPORT_LINE.test(line));
  expect(result.exitCode).toBe(expected.exitCode);
  expect(pointersOf(ourLines)).toEqual(pointersOf(gitLines));
  expect(othersOf(ourLines)).toEqual(othersOf(gitLines));
};

describe.skipIf(!GIT_AVAILABLE)('Given a repository with a broken ref chain', () => {
  describe.each(rows)('$title', (row) => {
    describe('When fsck runs', () => {
      it(
        'Then tsgit reports git’s lines and exit code',
        async () => expectGitsLines(row),
        SETUP_TIMEOUT,
      );
    });
  });
});

describe.skipIf(!GIT_AVAILABLE || !UNPRIVILEGED)(
  'Given a repository with a ref file the permissions refuse',
  () => {
    describe.each(refusedRows)('$title', (row) => {
      describe('When fsck runs', () => {
        it(
          'Then tsgit reports git’s lines and exit code',
          async () => expectGitsLines(row),
          SETUP_TIMEOUT,
        );
      });
    });
  },
);

describe.skipIf(!GIT_AVAILABLE || !UNPRIVILEGED)(
  'Given a repository with a ref directory the permissions refuse',
  () => {
    describe.each(dirRows)('$title', (row) => {
      describe('When fsck runs', () => {
        it(
          'Then tsgit reports git’s lines and exit code',
          async () => expectGitsLines(row),
          SETUP_TIMEOUT,
        );
      });
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)(
  'Given a repository with a loose ref git judges by its body',
  () => {
    describe.each(referentRows)('$title', (row) => {
      describe('When fsck runs', () => {
        it(
          'Then tsgit reports git’s lines and exit code',
          async () => expectGitsLines(row),
          SETUP_TIMEOUT,
        );
      });
    });
  },
);
