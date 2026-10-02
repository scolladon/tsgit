/**
 * Cross-tool interop — full `fsck` object-table typing.
 *
 * git's fsck keeps one in-memory table of objects: the first lookup of an
 * object fixes its type — a ref tip's parse at snapshot, then every copy in
 * read order, loose by fanout directory, then each pack — and a lookup asking
 * another type fails. Each row plants objects whose links disagree with what
 * they name, in a chosen read order, runs real `git fsck` and tsgit's fsck on
 * the same state, and rebuilds git's conflict, parse, pointer and link lines
 * from tsgit's structured findings.
 *
 * @proves
 *   surface:        fsck
 *   bucket:         cross-tool-interop
 *   unique:         tsgit fsck types objects by first lookup in git's read order and reports each conflict as git does
 *   interopSurface: fsck
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FsckFinding } from '../../src/application/commands/fsck.js';
import { openRepository } from '../../src/index.node.js';
import { GIT_AVAILABLE, runGit, tryRunGitWithExit } from './interop-helpers.js';

const ROW_TIMEOUT = 30_000;
const SEARCH_LIMIT = 4096;
const IDENT = 'Ada <ada@example.com> 1700000000 +0000';
const ERROR_LINE =
  /^error( in \w+ [0-9a-f]{40}: broken links|: object [0-9a-f]{40} is a |: [0-9a-f]{40}: object (could not be parsed|corrupt or missing)|: bad (tree pointer|parent|tag pointer) )/;
const REPORT_LINE = /^(broken link from|missing|dangling) /;

let root: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tsgit-interop-fsck-table-')));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const emptyRepo = (slug: string): string => {
  const dir = path.join(root, slug);
  runGit(['init', '-q', '-b', 'main', dir]);
  return dir;
};

const objectId = (type: string, body: Buffer): string =>
  createHash('sha1')
    .update(Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]))
    .digest('hex');

const writeLiteral = (dir: string, type: string, body: Buffer): string =>
  runGit(['-C', dir, 'hash-object', '-t', type, '-w', '--literally', '--stdin'], {
    input: body,
  }).trim();

/** Whether fsck's loose read meets `first` before `second`: an earlier fanout directory. */
const readBefore = (first: string, second: string): boolean =>
  first.slice(0, 2) < second.slice(0, 2);

/** Writes the first `build(n)` whose id satisfies `accept`. */
const writeFirst = (
  dir: string,
  type: string,
  build: (n: number) => Buffer,
  accept: (id: string) => boolean,
): string => {
  for (let n = 0; n < SEARCH_LIMIT; n++) {
    const body = build(n);
    if (accept(objectId(type, body))) return writeLiteral(dir, type, body);
  }
  throw new Error('no object satisfies the read order');
};

const blob = (dir: string, text: string): string => writeLiteral(dir, 'blob', Buffer.from(text));

const commitBody = (tree: string, parents: ReadonlyArray<string>, n: number): Buffer =>
  Buffer.from(
    `tree ${tree}\n${parents.map((p) => `parent ${p}\n`).join('')}author ${IDENT}\ncommitter ${IDENT}\n\nm${n}\n`,
  );

const tagBody = (object: string, type: string, n: number): Buffer =>
  Buffer.from(`object ${object}\ntype ${type}\ntag v\ntagger ${IDENT}\n\nm${n}\n`);

const treeBody = (mode: string, name: string, id: string): Buffer =>
  Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(id, 'hex')]);

const always = (): boolean => true;

const pointMain = (dir: string, commit: string): void => {
  runGit(['-C', dir, 'update-ref', 'refs/heads/main', commit]);
};

/** Moves `ids` into one pack and drops their loose copies. */
const packOnly = (dir: string, ids: ReadonlyArray<string>): void => {
  runGit(['-C', dir, 'pack-objects', '-q', '.git/objects/pack/pack'], {
    input: `${ids.join('\n')}\n`,
  });
  runGit(['-C', dir, 'prune-packed']);
};

/** Each row builds its repository and returns it. */
const ROWS: ReadonlyArray<{ readonly name: string; readonly build: (slug: string) => string }> = [
  {
    name: 'main at a commit whose tree is a blob',
    build: (slug) => {
      const dir = emptyRepo(slug);
      const leaf = blob(dir, 'leaf\n');
      pointMain(
        dir,
        writeFirst(dir, 'commit', (n) => commitBody(leaf, [], n), always),
      );
      return dir;
    },
  },
  {
    name: 'a tag ref declaring a commit over a blob',
    build: (slug) => {
      const dir = emptyRepo(slug);
      const leaf = blob(dir, 'leaf\n');
      const tag = writeFirst(dir, 'tag', (n) => tagBody(leaf, 'commit', n), always);
      runGit(['-C', dir, 'update-ref', 'refs/tags/v', tag]);
      return dir;
    },
  },
  {
    name: 'an unreferenced commit whose parent is a tree read before it',
    build: (slug) => {
      const dir = emptyRepo(slug);
      const tree = writeLiteral(dir, 'tree', treeBody('100644', 'f', blob(dir, 'leaf\n')));
      writeFirst(
        dir,
        'commit',
        (n) => commitBody(tree, [tree], n),
        (id) => readBefore(tree, id),
      );
      return dir;
    },
  },
  {
    name: 'an unreferenced commit whose tree is a blob read before it',
    build: (slug) => {
      const dir = emptyRepo(slug);
      const leaf = blob(dir, 'leaf\n');
      writeFirst(
        dir,
        'commit',
        (n) => commitBody(leaf, [], n),
        (id) => readBefore(leaf, id),
      );
      return dir;
    },
  },
  {
    name: 'an unreferenced tag declaring a tree over a blob read before it',
    build: (slug) => {
      const dir = emptyRepo(slug);
      const leaf = blob(dir, 'leaf\n');
      writeFirst(
        dir,
        'tag',
        (n) => tagBody(leaf, 'tree', n),
        (id) => readBefore(leaf, id),
      );
      return dir;
    },
  },
  {
    name: 'main over a tree whose directory entry names a blob read before it',
    build: (slug) => {
      const dir = emptyRepo(slug);
      const leaf = blob(dir, 'leaf\n');
      const tree = writeFirst(
        dir,
        'tree',
        (n) => treeBody('40000', `d${n}`, leaf),
        (id) => readBefore(leaf, id),
      );
      pointMain(
        dir,
        writeFirst(dir, 'commit', (n) => commitBody(tree, [], n), always),
      );
      return dir;
    },
  },
  {
    name: 'main over a tree whose directory and file entries both name a blob read before it',
    build: (slug) => {
      const dir = emptyRepo(slug);
      const leaf = blob(dir, 'leaf\n');
      const tree = writeFirst(
        dir,
        'tree',
        (n) => Buffer.concat([treeBody('40000', `d${n}`, leaf), treeBody('100644', `f${n}`, leaf)]),
        (id) => readBefore(leaf, id),
      );
      pointMain(
        dir,
        writeFirst(dir, 'commit', (n) => commitBody(tree, [], n), always),
      );
      return dir;
    },
  },
  {
    name: 'main over a tree whose file entry names a tree read after it',
    build: (slug) => {
      const dir = emptyRepo(slug);
      const inner = writeLiteral(dir, 'tree', treeBody('100644', 'f', blob(dir, 'leaf\n')));
      const outer = writeFirst(
        dir,
        'tree',
        (n) => treeBody('100644', `f${n}`, inner),
        (id) => readBefore(id, inner),
      );
      pointMain(
        dir,
        writeFirst(dir, 'commit', (n) => commitBody(outer, [], n), always),
      );
      return dir;
    },
  },
  {
    name: 'main at a packed commit whose packed tree is a blob',
    build: (slug) => {
      const dir = emptyRepo(slug);
      const leaf = blob(dir, 'leaf\n');
      const commit = writeFirst(dir, 'commit', (n) => commitBody(leaf, [], n), always);
      pointMain(dir, commit);
      packOnly(dir, [commit, leaf]);
      return dir;
    },
  },
  {
    name: 'an unreferenced packed commit whose tree is a loose blob',
    build: (slug) => {
      const dir = emptyRepo(slug);
      const leaf = blob(dir, 'leaf\n');
      packOnly(dir, [writeFirst(dir, 'commit', (n) => commitBody(leaf, [], n), always)]);
      return dir;
    },
  },
];

const looseRelativePath = (id: string): string => `.git/objects/${id.slice(0, 2)}/${id.slice(2)}`;

const POINTER_LINES = {
  tree: (target: string, id: string) => `error: bad tree pointer ${target} in commit ${id}`,
  parent: (target: string, id: string) => `error: bad parent ${target} in commit ${id}`,
  tag: (target: string, id: string) => `error: bad tag pointer to ${target} in ${id}`,
} as const;

/** git's stderr lines for each object-table finding, in finding order. */
const errorLines = (findings: ReadonlyArray<FsckFinding>): ReadonlyArray<string> =>
  findings.flatMap((f) => {
    if (f.type === 'type-conflict')
      return [`error: object ${f.id} is a ${f.objectType}, not a ${f.expectedType}`];
    if (f.type === 'unparseable-object') {
      return f.pack === undefined
        ? [`error: ${f.id}: object could not be parsed: ${looseRelativePath(f.id)}`]
        : [`error: ${f.id}: object corrupt or missing`];
    }
    if (f.type === 'bad-pointer') return [POINTER_LINES[f.link](f.target, f.id)];
    if (f.type === 'broken-links') return [`error in ${f.objectType} ${f.id}: broken links`];
    return [];
  });

/** git's stdout lines for every unresolved link, missing and dangling object. */
const reportLines = (findings: ReadonlyArray<FsckFinding>): ReadonlyArray<string> =>
  findings
    .flatMap((f) => {
      if (f.type === 'unresolved-link') {
        return [
          `broken link from ${f.fromType.padStart(7)} ${f.fromId}`,
          `broken link from ${f.toType.padStart(7)} unknown`,
        ];
      }
      if (f.type === 'missing' || f.type === 'dangling')
        return [`${f.type} ${f.objectType} ${f.id}`];
      return [];
    })
    .sort();

const gitLines = (output: string, line: RegExp): ReadonlyArray<string> =>
  output.split('\n').filter((text) => line.test(text));

describe.skipIf(!GIT_AVAILABLE)('fsck interop — object-table typing', () => {
  describe.each(ROWS.map((row, index) => ({ ...row, slug: `row-${index}` })))(
    'Given $name',
    ({ build, slug }) => {
      describe('When git fsck and tsgit fsck run', () => {
        it(
          'Then both report the same conflicts, unresolved links, missing and dangling objects and exit code',
          async () => {
            // Arrange
            const dir = build(slug);
            const expected = tryRunGitWithExit(['-C', dir, 'fsck']);
            const repo = await openRepository({ cwd: dir });
            const sut = repo.fsck;

            // Act
            const result = await sut().finally(() => repo.dispose());

            // Assert
            expect(result.exitCode).toBe(expected.exitCode);
            expect(errorLines(result.findings)).toEqual(gitLines(expected.stderr, ERROR_LINE));
            expect(reportLines(result.findings)).toEqual(
              [...gitLines(expected.stdout, REPORT_LINE)].sort(),
            );
          },
          ROW_TIMEOUT,
        );
      });
    },
  );
});
