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
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { type FsckOptions, type FsckResult, fsck } from '../../src/application/commands/fsck.js';
import { __resetConfigCacheForTests } from '../../src/application/primitives/config-read.js';
import { GIT_AVAILABLE, runGit, tryRunGitWithExit } from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;
const ABSENT_OID = '1'.repeat(40);
const POINTER_LINE = /^error: .*: invalid sha1 pointer /;
const REPORT_LINE = /^(error|warning|notice): /;
const TRAILING_BYTES = /[ \t\r\n]+$/;

interface Row {
  readonly title: string;
  /** Loose ref files by name under `refs/heads/`; `{commit}` stands for a real commit id. */
  readonly refs: Readonly<Record<string, string>>;
  readonly packed?: Readonly<Record<string, string>>;
  readonly head?: string;
  readonly config?: Readonly<Record<string, string>>;
  readonly flags?: ReadonlyArray<string>;
  readonly options?: FsckOptions;
  readonly commit?: boolean;
}

const GARBAGE = 'garbage\n';
const toB = 'ref: refs/heads/b\n';

const rows: ReadonlyArray<Row> = [
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

const roots: string[] = [];

afterEach(async () => {
  __resetConfigCacheForTests();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const git = (dir: string, ...args: ReadonlyArray<string>): string => runGit(['-C', dir, ...args]);

const commitOf = (dir: string): string => {
  const tree = git(dir, 'hash-object', '-t', 'tree', '-w', '--stdin').trim();
  return git(dir, 'commit-tree', tree, '-m', 'c').trim();
};

const seed = async (row: Row): Promise<string> => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-chain-')));
  roots.push(dir);
  runGit(['init', '-q', '-b', 'main', dir]);
  const commit = row.commit === true ? commitOf(dir) : '';
  const fill = (text: string): string => text.replaceAll('{commit}', commit);
  const heads = path.join(dir, '.git', 'refs', 'heads');
  await mkdir(heads, { recursive: true });
  for (const [name, body] of Object.entries(row.refs)) {
    await writeFile(path.join(heads, name), fill(body));
  }
  if (row.packed !== undefined) {
    const lines = Object.entries(row.packed).map(([n, id]) => `${fill(id)} refs/heads/${n}\n`);
    await writeFile(
      path.join(dir, '.git', 'packed-refs'),
      `# pack-refs with: peeled sorted \n${lines.join('')}`,
    );
  }
  if (row.head !== undefined) await writeFile(path.join(dir, '.git', 'HEAD'), row.head);
  for (const [key, value] of Object.entries(row.config ?? {})) git(dir, 'config', key, value);
  return dir;
};

/** git's report lines (`error:`, `warning:`, `notice:`) from its stderr. */
const gitReportLines = (stderr: string): ReadonlyArray<string> =>
  stderr.split('\n').filter((line) => REPORT_LINE.test(line));

/** The same lines rebuilt from tsgit's findings; the seeded bodies stand for the content. */
const rebuiltLines = (result: FsckResult, row: Row): ReadonlyArray<string> =>
  result.findings.flatMap((finding) => {
    if (finding.type === 'no-default-references') return ['notice: No default references'];
    if (finding.type !== 'bad-ref') return [];
    const label = finding.severity === 'error' ? 'error' : 'warning';
    if (finding.msgId === 'badRefOid') {
      return [`error: ${finding.ref}: invalid sha1 pointer ${finding.target}`];
    }
    const body = row.refs[finding.ref.replace('refs/heads/', '')] ?? '';
    return [`${label}: ${finding.ref}: ${finding.msgId}: ${body.replace(TRAILING_BYTES, '')}`];
  });

const pointersOf = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines.filter((line) => POINTER_LINE.test(line));
const othersOf = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines.filter((line) => !POINTER_LINE.test(line)).sort();

describe.skipIf(!GIT_AVAILABLE)('Given a repository with a broken ref chain', () => {
  describe.each(rows)('$title', (row) => {
    describe('When fsck runs', () => {
      it(
        'Then tsgit reports git’s lines and exit code',
        async () => {
          // Arrange
          const dir = await seed(row);
          const expected = tryRunGitWithExit(['-C', dir, 'fsck', ...(row.flags ?? [])]);
          const sut = fsck;

          // Act
          const result = await sut(createNodeContext({ workDir: dir }), row.options);

          // Assert
          const gitLines = gitReportLines(expected.stderr);
          const ourLines = rebuiltLines(result, row);
          expect(result.exitCode).toBe(expected.exitCode);
          expect(pointersOf(ourLines)).toEqual(pointersOf(gitLines));
          expect(othersOf(ourLines)).toEqual(othersOf(gitLines));
        },
        SETUP_TIMEOUT,
      );
    });
  });
});
