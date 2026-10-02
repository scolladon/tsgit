/**
 * Cross-tool interop — `fsck --connectivity-only` typing order.
 *
 * Under `--connectivity-only` git types an object by the first parse linking to
 * it — a ref tip's at snapshot, an index entry's lookup, then each object its
 * LIFO walk pops — and walks a typed object through whatever its copy serves,
 * never re-hashing it. Each row plants a copy holding another object's bytes,
 * runs real `git fsck --connectivity-only` and tsgit's fsck on the same state,
 * and rebuilds git's `Unknown object type for` / `Object <id> not a <type>`
 * lines and its dangling lines from tsgit's structured findings.
 *
 * @proves
 *   surface:        fsck
 *   bucket:         cross-tool-interop
 *   unique:         tsgit fsck connectivity-only types and walks mis-hashed copies in git's pop order
 *   interopSurface: fsck
 */
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FsckFinding } from '../../src/application/commands/fsck.js';
import { openRepository } from '../../src/index.node.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  runGit,
  tryRunGitWithExit,
} from './interop-helpers.js';

const ROW_TIMEOUT = 30_000;
const ZERO = '0'.repeat(40);
const TYPE_LINE = /^error: (Unknown object type for [0-9a-f]{40}|Object [0-9a-f]{40} not a \w+)$/;
const DANGLING_LINE = /^dangling \w+ [0-9a-f]{40}$/;

let root: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tsgit-interop-fsck-typing-')));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const git = (dir: string, ...args: ReadonlyArray<string>): string =>
  runGit(['-C', dir, ...args]).trim();

/** A repository with `count` commits over `f`, oldest first. */
const chainRepo = (slug: string, count: number): { dir: string; commits: string[] } => {
  const dir = path.join(root, slug);
  runGit(['init', '-q', '-b', 'main', dir]);
  for (const [key, value] of [
    ['user.name', 'Ada'],
    ['user.email', 'ada@example.com'],
    ['commit.gpgSign', 'false'],
  ] as const) {
    git(dir, 'config', key, value);
  }
  disableAutoMaintenance(dir);
  const commits: string[] = [];
  for (let n = 1; n <= count; n++) {
    writeFileSync(path.join(dir, 'f'), `v${n}\n`);
    git(dir, 'add', 'f');
    git(dir, 'commit', '-q', '-m', `c${n}`);
    commits.push(git(dir, 'rev-parse', 'HEAD'));
  }
  return { dir, commits };
};

const looseFile = (dir: string, oid: string): string =>
  path.join(dir, '.git', 'objects', oid.slice(0, 2), oid.slice(2));

/** Overwrite `target`'s loose copy with `source`'s loose bytes. */
const serveBytesOf = (dir: string, target: string, source: string): void => {
  chmodSync(looseFile(dir, target), 0o644);
  writeFileSync(looseFile(dir, target), readFileSync(looseFile(dir, source)));
};

const blobOf = (dir: string, text: string): string =>
  runGit(['-C', dir, 'hash-object', '-w', '--stdin'], { input: text }).trim();

/** HEAD's and main's reflogs, rewritten to log `moves` in order. */
const rewriteReflogs = (dir: string, moves: ReadonlyArray<readonly [string, string]>): void => {
  const log = moves.map(
    ([from, to]) => `${from} ${to} Ada <ada@example.com> 1700000000 +0000\tx\n`,
  );
  writeFileSync(path.join(dir, '.git', 'logs', 'HEAD'), log.join(''));
  writeFileSync(path.join(dir, '.git', 'logs', 'refs', 'heads', 'main'), log.join(''));
};

const u32 = (value: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};

/** An index with no entry whose resolve-undo records `oid` as a regular file. */
const writeResolveUndoIndex = (dir: string, oid: string): void => {
  const body = Buffer.concat([
    Buffer.from('p\u0000100644\u00000\u00000\u0000'),
    Buffer.from(oid, 'hex'),
  ]);
  const head = Buffer.concat([
    Buffer.from('DIRC'),
    u32(2),
    u32(0),
    Buffer.from('REUC'),
    u32(body.length),
    body,
  ]);
  writeFileSync(
    path.join(dir, '.git', 'index'),
    Buffer.concat([head, createHash('sha1').update(head).digest()]),
  );
};

/** Each row builds its repository and returns it. */
const ROWS: ReadonlyArray<{ readonly name: string; readonly build: (slug: string) => string }> = [
  {
    name: 'main at c3, c2 holding c1',
    build: (slug) => {
      const { dir, commits } = chainRepo(slug, 3);
      serveBytesOf(dir, commits[1] as string, commits[0] as string);
      return dir;
    },
  },
  {
    name: 'main reset to c1, c2 holding c1',
    build: (slug) => {
      const { dir, commits } = chainRepo(slug, 3);
      git(dir, 'reset', '-q', '--hard', commits[0] as string);
      serveBytesOf(dir, commits[1] as string, commits[0] as string);
      return dir;
    },
  },
  {
    name: 'main reset to c1, c2 holding a blob',
    build: (slug) => {
      const { dir, commits } = chainRepo(slug, 3);
      git(dir, 'reset', '-q', '--hard', commits[0] as string);
      serveBytesOf(dir, commits[1] as string, blobOf(dir, 'zz\n'));
      return dir;
    },
  },
  {
    name: 'main reset to c1, c2 holding a dangling commit',
    build: (slug) => {
      const { dir, commits } = chainRepo(slug, 3);
      const tree = runGit(['-C', dir, 'mktree'], {
        input: `100644 blob ${blobOf(dir, 'dd\n')}\td\n`,
      }).trim();
      const served = git(dir, 'commit-tree', tree, '-m', 'd');
      git(dir, 'reset', '-q', '--hard', commits[0] as string);
      serveBytesOf(dir, commits[1] as string, served);
      return dir;
    },
  },
  {
    name: 'reflog roots c3, c2, c4 with c2 holding c1',
    build: (slug) => {
      const { dir, commits } = chainRepo(slug, 4);
      const [c1, c2, c3, c4] = commits as [string, string, string, string];
      git(dir, 'reset', '-q', '--hard', c1);
      rewriteReflogs(dir, [
        [ZERO, c3],
        [c3, c2],
        [c2, c4],
        [c4, c1],
      ]);
      serveBytesOf(dir, c2, c1);
      return dir;
    },
  },
  {
    name: 'reflog roots c3 then c2, c2 holding c1, a resolve-undo naming c3',
    build: (slug) => {
      const { dir, commits } = chainRepo(slug, 3);
      const [c1, c2, c3] = commits as [string, string, string];
      git(dir, 'reset', '-q', '--hard', c1);
      rewriteReflogs(dir, [
        [ZERO, c3],
        [c3, c2],
        [c2, c1],
      ]);
      serveBytesOf(dir, c2, c1);
      writeResolveUndoIndex(dir, c3);
      return dir;
    },
  },
  {
    name: 'an index entry naming an unreferenced commit',
    build: (slug) => {
      const { dir } = chainRepo(slug, 1);
      const tree = runGit(['-C', dir, 'mktree'], {
        input: `100644 blob ${blobOf(dir, 'dd\n')}\td\n`,
      }).trim();
      const commit = git(dir, 'commit-tree', tree, '-m', 'x');
      git(dir, 'update-index', '--add', '--cacheinfo', `100644,${commit},g`);
      return dir;
    },
  },
  {
    name: 'a tag naming an unreferenced c2 holding a blob',
    build: (slug) => {
      const { dir, commits } = chainRepo(slug, 2);
      git(dir, 'reset', '-q', '--hard', commits[0] as string);
      git(dir, 'tag', '-a', '-m', 't', 't', commits[1] as string);
      git(dir, 'reflog', 'expire', '--expire=now', '--all');
      serveBytesOf(dir, commits[1] as string, blobOf(dir, 'zz\n'));
      return dir;
    },
  },
  {
    name: "main at c2, c2's tree holding a blob",
    build: (slug) => {
      const { dir } = chainRepo(slug, 2);
      serveBytesOf(dir, git(dir, 'rev-parse', 'HEAD^{tree}'), blobOf(dir, 'zz\n'));
      return dir;
    },
  },
];

const typeLines = (findings: ReadonlyArray<FsckFinding>): ReadonlyArray<string> =>
  findings.flatMap((f) => {
    if (f.type === 'unknown-object-type') return [`error: Unknown object type for ${f.id}`];
    if (f.type === 'unexpected-object-type')
      return [`error: Object ${f.id} not a ${f.expectedType}`];
    return [];
  });

const danglingLines = (findings: ReadonlyArray<FsckFinding>): ReadonlyArray<string> =>
  findings
    .flatMap((f) => (f.type === 'dangling' ? [`dangling ${f.objectType} ${f.id}`] : []))
    .sort();

const gitLines = (output: string, line: RegExp): ReadonlyArray<string> =>
  output.split('\n').filter((text) => line.test(text));

describe.skipIf(!GIT_AVAILABLE)('fsck interop — connectivity-only typing order', () => {
  describe.each(ROWS.map((row, index) => ({ ...row, slug: `row-${index}` })))(
    'Given $name',
    ({ build, slug }) => {
      describe('When git fsck --connectivity-only and tsgit fsck run', () => {
        it(
          'Then both report the same typing errors, dangling objects and exit code',
          async () => {
            // Arrange
            const dir = build(slug);
            const expected = tryRunGitWithExit(['-C', dir, 'fsck', '--connectivity-only']);
            const repo = await openRepository({ cwd: dir });
            const sut = repo.fsck;

            // Act
            const result = await sut({ connectivityOnly: true }).finally(() => repo.dispose());

            // Assert
            expect(result.exitCode).toBe(expected.exitCode);
            expect(typeLines(result.findings)).toEqual(gitLines(expected.stderr, TYPE_LINE));
            expect(danglingLines(result.findings)).toEqual(
              [...gitLines(expected.stdout, DANGLING_LINE)].sort(),
            );
          },
          ROW_TIMEOUT,
        );
      });
    },
  );
});

describe.skipIf(!GIT_AVAILABLE)('fsck interop — connectivity-only walk over a commit-graph', () => {
  describe('Given a commit-graph holding c1..c3 and c2 holding c1', () => {
    describe('When git fsck --connectivity-only and tsgit fsck run', () => {
      it(
        "Then both walk c2 through the graph: no typing error and c2's tree not dangling",
        async () => {
          // Arrange — git's own `commit-graph verify` pass reports the
          // graph/object mismatch and sets its exit bit; only the walk is compared.
          const { dir, commits } = chainRepo('graph-held', 3);
          git(dir, 'commit-graph', 'write', '--reachable');
          serveBytesOf(dir, commits[1] as string, commits[0] as string);
          const expected = tryRunGitWithExit(['-C', dir, 'fsck', '--connectivity-only']);
          const repo = await openRepository({ cwd: dir });
          const sut = repo.fsck;

          // Act
          const result = await sut({ connectivityOnly: true }).finally(() => repo.dispose());

          // Assert
          expect(typeLines(result.findings)).toEqual(gitLines(expected.stderr, TYPE_LINE));
          expect(danglingLines(result.findings)).toEqual(
            [...gitLines(expected.stdout, DANGLING_LINE)].sort(),
          );
        },
        ROW_TIMEOUT,
      );
    });
  });
});
