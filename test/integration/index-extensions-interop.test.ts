/**
 * Cross-tool interop — extension carry per writer. A git-built index holding
 * `TREE`, `REUC`, `UNTR` and an unknown optional `ZZZZ` is rewritten by one
 * tsgit writer and, on a twin repository built identically, by canonical git.
 * `ZZZZ` is dropped whenever git writes, `REUC` follows the writer class,
 * `UNTR` follows the tracked-set rule, and `TREE` is byte-equal to git's for
 * `add`, valid-node-equal for the other in-place writers, and carries only
 * oids git agrees with for the writers that rebuild the index.
 *
 * @proves
 *   surface:        index
 *   bucket:         cross-tool-interop
 *   unique:         index extension carry per writer class matches git's TREE, REUC, UNTR and ZZZZ handling
 *   interopSurface: index
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { add } from '../../src/application/commands/add.js';
import { checkout } from '../../src/application/commands/checkout.js';
import { cherryPickRun } from '../../src/application/commands/cherry-pick.js';
import { mergeRun } from '../../src/application/commands/merge.js';
import { mv } from '../../src/application/commands/mv.js';
import { reset } from '../../src/application/commands/reset.js';
import { rm } from '../../src/application/commands/rm.js';
import { sparseCheckoutSet } from '../../src/application/commands/sparse-checkout.js';
import { stashApply, stashPush } from '../../src/application/commands/stash.js';
import { readIndex } from '../../src/application/primitives/read-index.js';
import type { TsgitError } from '../../src/domain/error.js';
import type { CacheTreeEntry } from '../../src/domain/git-index/index-entry.js';
import { parseCacheTree } from '../../src/domain/git-index/index-parser.js';
import type { Context } from '../../src/ports/context.js';
import {
  GIT_AVAILABLE,
  git,
  makePeerPair,
  type PeerPair,
  runGit,
  tryRunGit,
  tryRunGitWithExit,
} from './interop-helpers.js';

type Format = 'sha1' | 'sha256';
type Carry = 'update' | 'replace';
type TreeCheck = 'bytes' | 'valid-nodes' | 'git-oids';
/** Where tsgit's decision to rewrite the index differs from git's: git writes and tsgit skips it, or the reverse. */
type WriteDivergence = 'tsgit-skips-write';

const DIGEST_LENGTH: Record<Format, 20 | 32> = { sha1: 20, sha256: 32 };
const FILES = ['a', 'b', 'd/c', 'd/e/f', 'x/y', 'm'] as const;
const PAST_SECONDS = 10;
const TOUCH_SECONDS = 5;
const ROW_TIMEOUT_MS = 180_000;
const ZZZZ_PAYLOAD = Uint8Array.of(0xde, 0xad, 0xbe, 0xef);

const secondsAgo = (seconds: number): Date => new Date(Date.now() - seconds * 1000);

const write = async (dir: string, file: string, body: string): Promise<void> =>
  writeFile(path.join(dir, file), body);

const commitAll = (dir: string, message: string): void => {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
};

const u32be = (value: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
};

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
};

const appendZzzz = async (dir: string, format: Format): Promise<void> => {
  const indexPath = path.join(dir, '.git', 'index');
  const bytes = new Uint8Array(await readFile(indexPath));
  const body = bytes.subarray(0, bytes.length - DIGEST_LENGTH[format]);
  const payload = concat(
    body,
    new TextEncoder().encode('ZZZZ'),
    u32be(ZZZZ_PAYLOAD.length),
    ZZZZ_PAYLOAD,
  );
  const algorithm = format === 'sha256' ? 'sha256' : 'sha1';
  const trailer = createHash(algorithm).update(payload).digest();
  await writeFile(indexPath, concat(payload, trailer));
};

/** Built IN PLACE: the `UNTR` ident embeds the worktree path, so a copy would reset it. */
const buildBase = async (dir: string, format: Format): Promise<void> => {
  runGit(['init', '-q', '-b', 'main', `--object-format=${format}`, dir]);
  git(dir, 'config', 'user.name', 'Ada');
  git(dir, 'config', 'user.email', 'ada@example.com');
  git(dir, 'config', 'gc.auto', '0');
  git(dir, 'config', 'merge.conflictStyle', 'merge');
  for (const file of FILES) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await write(dir, file, `${file} body\n`);
  }
  commitAll(dir, 'one');
  for (const [branch, file] of [
    ['clean', 'n'],
    ['clash', 'x/y'],
  ] as const) {
    git(dir, 'checkout', '-q', '-b', branch);
    await write(dir, file, `${branch}\n`);
    commitAll(dir, branch);
    git(dir, 'checkout', '-q', 'main');
  }
  git(dir, 'checkout', '-q', '-b', 'other');
  await write(dir, 'm', 'other\n');
  await write(dir, 'z', 'z body\n');
  commitAll(dir, 'other');
  git(dir, 'checkout', '-q', 'main');
  await write(dir, 'm', 'main\n');
  commitAll(dir, 'two');
  tryRunGit(['-C', dir, 'merge', '--no-edit', 'other']);
  await write(dir, 'm', 'resolved\n');
  git(dir, 'add', 'm');
  git(dir, 'commit', '-q', '-m', 'merge');
  await write(dir, 'x/y', 'main xy\n');
  commitAll(dir, 'three');
  await write(dir, 'd/untracked', 'untracked\n');
  const past = secondsAgo(PAST_SECONDS);
  for (const file of [...git(dir, 'ls-files').split('\n').filter(Boolean), 'd/untracked']) {
    await utimes(path.join(dir, file), past, past);
  }
  git(dir, 'update-index', '--refresh');
  for (let pass = 0; pass < 2; pass++) git(dir, '-c', 'core.untrackedCache=true', 'status');
  await appendZzzz(dir, format);
};

const contextFor = (dir: string, format: Format): Context =>
  createNodeContext({ workDir: dir, ...(format === 'sha256' ? { algorithm: 'sha256' } : {}) });

const extensionsOf = async (
  dir: string,
  format: Format,
): Promise<ReadonlyMap<string, Uint8Array>> => {
  const index = await readIndex(contextFor(dir, format));
  return new Map(index.extensions.map((extension) => [extension.signature, extension.data]));
};

const validNodes = (
  node: CacheTreeEntry,
  prefix = '',
): ReadonlyArray<readonly [string, string]> => {
  const own: ReadonlyArray<readonly [string, string]> =
    node.entryCount >= 0 && node.id !== undefined ? [[prefix, node.id]] : [];
  const nested = node.children.flatMap((child) =>
    validNodes(child, prefix === '' ? child.path : `${prefix}/${child.path}`),
  );
  return [...own, ...nested].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
};

const treeNodes = (
  extensions: ReadonlyMap<string, Uint8Array>,
  format: Format,
): ReadonlyArray<readonly [string, string]> => {
  const data = extensions.get('TREE');
  return data === undefined ? [] : validNodes(parseCacheTree(data, DIGEST_LENGTH[format]));
};

const trackedPaths = (dir: string): string =>
  [...new Set(git(dir, 'ls-files').split('\n'))].sort().join('\n');

const gitOid = (dir: string, directory: string): string =>
  git(dir, 'rev-parse', directory === '' ? 'HEAD^{tree}' : `HEAD:${directory}`).trim();

interface Row {
  readonly title: string;
  readonly carry: Carry;
  readonly tree: TreeCheck;
  readonly divergence?: WriteDivergence;
  readonly prepare?: (dir: string) => Promise<void>;
  readonly git: (dir: string) => void;
  readonly tsgit: (ctx: Context) => Promise<unknown>;
}

const ok =
  (...args: ReadonlyArray<string>) =>
  (dir: string): void => {
    git(dir, ...args);
  };

const lenient =
  (...args: ReadonlyArray<string>) =>
  (dir: string): void => {
    tryRunGit(['-C', dir, ...args]);
  };

const touchForward = async (dir: string, file: string): Promise<void> => {
  const when = secondsAgo(TOUCH_SECONDS);
  await utimes(path.join(dir, file), when, when);
};

const dirtyDC = (dir: string): Promise<void> => write(dir, 'd/c', 'dirty\n');

const stashedDC = async (dir: string): Promise<void> => {
  await dirtyDC(dir);
  const stash = git(dir, 'stash', 'create').trim();
  git(dir, 'stash', 'store', '-m', 'wip', stash);
  await write(dir, 'd/c', 'd/c body\n');
};

const ADD_MODIFIED: Row = {
  title: 'add d/c (modified)',
  carry: 'update',
  tree: 'bytes',
  prepare: dirtyDC,
  git: ok('add', 'd/c'),
  tsgit: (ctx) => add(ctx, ['d/c']),
};

const ADD_ROWS: ReadonlyArray<Row> = [
  ADD_MODIFIED,
  {
    title: 'add d/e/n (new)',
    carry: 'update',
    tree: 'bytes',
    prepare: (dir) => write(dir, 'd/e/n', 'new\n'),
    git: ok('add', 'd/e/n'),
    tsgit: (ctx) => add(ctx, ['d/e/n']),
  },
  {
    title: 'add -A (adds d/untracked)',
    carry: 'update',
    tree: 'bytes',
    git: ok('add', '-A'),
    tsgit: (ctx) => add(ctx, [], { all: true }),
  },
  {
    title: 'touch b; add b (stat moved, same oid)',
    carry: 'update',
    tree: 'bytes',
    prepare: (dir) => touchForward(dir, 'b'),
    git: ok('add', 'b'),
    tsgit: (ctx) => add(ctx, ['b']),
  },
  {
    title: 'add b (stat unchanged; git does not write)',
    carry: 'update',
    tree: 'bytes',
    git: ok('add', 'b'),
    tsgit: (ctx) => add(ctx, ['b']),
  },
  {
    title: 'add --renormalize . (no content change)',
    carry: 'update',
    tree: 'bytes',
    git: ok('add', '--renormalize', '.'),
    tsgit: (ctx) => add(ctx, ['.'], { renormalize: true }),
  },
];

const UPDATE_ROWS: ReadonlyArray<Row> = [
  {
    title: 'rm d/c',
    carry: 'update',
    tree: 'valid-nodes',
    git: ok('rm', '-q', 'd/c'),
    tsgit: (ctx) => rm(ctx, ['d/c']),
  },
  {
    title: 'rm --cached x/y',
    carry: 'update',
    tree: 'valid-nodes',
    git: ok('rm', '-q', '--cached', 'x/y'),
    tsgit: (ctx) => rm(ctx, ['x/y'], { cached: true }),
  },
  {
    title: 'mv b d/b2',
    carry: 'update',
    tree: 'valid-nodes',
    git: ok('mv', 'b', 'd/b2'),
    tsgit: (ctx) => mv(ctx, ['b'], 'd/b2'),
  },
  {
    title: 'reset (mixed, same HEAD)',
    carry: 'update',
    tree: 'valid-nodes',
    git: ok('reset', '-q'),
    tsgit: (ctx) => reset(ctx, { mode: 'mixed', rev: 'HEAD' }),
  },
  {
    title: 'reset HEAD~1 (mixed)',
    carry: 'update',
    tree: 'valid-nodes',
    git: ok('reset', '-q', 'HEAD~1'),
    tsgit: (ctx) => reset(ctx, { mode: 'mixed', rev: 'HEAD~1' }),
  },
  {
    title: 'checkout -- x/y',
    carry: 'update',
    tree: 'valid-nodes',
    git: ok('checkout', '--', 'x/y'),
    tsgit: (ctx) => checkout(ctx, { paths: ['x/y'] }),
  },
  {
    title: 'checkout other -- x/y',
    carry: 'update',
    tree: 'valid-nodes',
    git: ok('checkout', 'other', '--', 'x/y'),
    tsgit: (ctx) => checkout(ctx, { paths: ['x/y'], source: 'other' }),
  },
  {
    title: 'sparse-checkout set d',
    carry: 'update',
    tree: 'valid-nodes',
    git: ok('sparse-checkout', 'set', 'd'),
    tsgit: (ctx) => sparseCheckoutSet(ctx, { patterns: ['d'] }),
  },
];

const REPLACE_ROWS: ReadonlyArray<Row> = [
  {
    title: 'reset --soft HEAD~1',
    carry: 'update',
    tree: 'valid-nodes',
    git: ok('reset', '-q', '--soft', 'HEAD~1'),
    tsgit: (ctx) => reset(ctx, { mode: 'soft', rev: 'HEAD~1' }),
  },
  {
    title: 'reset --hard',
    carry: 'replace',
    tree: 'git-oids',
    git: ok('reset', '-q', '--hard'),
    tsgit: (ctx) => reset(ctx, { mode: 'hard', rev: 'HEAD' }),
  },
  {
    title: 'reset --hard HEAD~1',
    carry: 'replace',
    tree: 'git-oids',
    git: ok('reset', '-q', '--hard', 'HEAD~1'),
    tsgit: (ctx) => reset(ctx, { mode: 'hard', rev: 'HEAD~1' }),
  },
  {
    title: 'checkout other',
    carry: 'replace',
    tree: 'git-oids',
    git: ok('checkout', '-q', 'other'),
    tsgit: (ctx) => checkout(ctx, { rev: 'other' }),
  },
  {
    title: 'merge clean (clean)',
    carry: 'replace',
    tree: 'git-oids',
    git: ok('merge', '--no-edit', '-q', 'clean'),
    tsgit: (ctx) => mergeRun(ctx, { rev: 'clean' }),
  },
  {
    title: 'merge clash (conflicted)',
    carry: 'replace',
    tree: 'git-oids',
    git: lenient('merge', '--no-edit', 'clash'),
    tsgit: (ctx) => mergeRun(ctx, { rev: 'clash' }),
  },
  {
    title: 'cherry-pick clean',
    carry: 'replace',
    tree: 'git-oids',
    git: ok('cherry-pick', 'clean'),
    tsgit: (ctx) => cherryPickRun(ctx, { commits: ['clean'] }),
  },
  {
    title: 'stash push',
    carry: 'replace',
    tree: 'git-oids',
    prepare: dirtyDC,
    git: ok('stash', 'push', '-q'),
    tsgit: (ctx) => stashPush(ctx, {}),
  },
  {
    title: 'stash apply (git writes the index, tsgit does not)',
    carry: 'replace',
    tree: 'git-oids',
    divergence: 'tsgit-skips-write',
    prepare: stashedDC,
    git: ok('stash', 'apply', '-q'),
    tsgit: (ctx) => stashApply(ctx, {}),
  },
];

interface Outcome {
  readonly before: ReadonlyMap<string, Uint8Array>;
  readonly ours: ReadonlyMap<string, Uint8Array>;
  readonly peer: ReadonlyMap<string, Uint8Array>;
  readonly trackedSetChanged: boolean;
  readonly oursDir: string;
  readonly peerDir: string;
  readonly format: Format;
}

const play = async (pair: PeerPair, row: Row, format: Format): Promise<Outcome> => {
  for (const dir of [pair.peer, pair.ours]) {
    await buildBase(dir, format);
    await row.prepare?.(dir);
  }
  const before = await extensionsOf(pair.ours, format);
  const trackedBefore = trackedPaths(pair.peer);
  row.git(pair.peer);
  await row.tsgit(contextFor(pair.ours, format));
  return {
    before,
    ours: await extensionsOf(pair.ours, format),
    peer: await extensionsOf(pair.peer, format),
    trackedSetChanged: trackedPaths(pair.peer) !== trackedBefore,
    oursDir: pair.ours,
    peerDir: pair.peer,
    format,
  };
};

const expectZzzz = (row: Row, outcome: Outcome): void => {
  const expected = {
    'tsgit-skips-write': outcome.before.has('ZZZZ'),
    undefined: outcome.peer.has('ZZZZ'),
  }[row.divergence ?? 'undefined'];
  expect(outcome.ours.has('ZZZZ')).toBe(expected);
};

const expectCarried = (outcome: Outcome, signature: string, carried: boolean): void => {
  if (!carried) {
    expect(outcome.ours.has(signature)).toBe(false);
    return;
  }
  expect(outcome.before.has(signature)).toBe(true);
  expect(outcome.ours.get(signature)).toEqual(outcome.before.get(signature));
};

const expectTree = (row: Row, outcome: Outcome): void => {
  if (row.tree === 'bytes') {
    expect(outcome.peer.has('TREE')).toBe(true);
    expect(outcome.ours.get('TREE')).toEqual(outcome.peer.get('TREE'));
    return;
  }
  if (row.tree === 'valid-nodes') {
    expect(treeNodes(outcome.ours, outcome.format)).toEqual(
      treeNodes(outcome.peer, outcome.format),
    );
    return;
  }
  for (const [directory, oid] of treeNodes(outcome.ours, outcome.format)) {
    expect([directory, oid]).toEqual([directory, gitOid(outcome.oursDir, directory)]);
  }
};

const describeRow = (row: Row, format: Format = 'sha1'): void => {
  describe(`Given a git-built index with TREE, REUC, UNTR and ZZZZ (${format})`, () => {
    describe(`When ${row.title} runs in tsgit and in git on a twin`, () => {
      let pair: PeerPair;
      let outcome: Outcome;

      beforeAll(async () => {
        pair = await makePeerPair('index-ext');
        outcome = await play(pair, row, format);
      }, ROW_TIMEOUT_MS);

      afterAll(async () => {
        await pair.dispose();
      });

      it('Then ZZZZ survives exactly where git keeps it', () => {
        // Assert
        expectZzzz(row, outcome);
      });

      it('Then REUC follows the writer class', () => {
        // Assert
        expectCarried(
          outcome,
          'REUC',
          row.carry === 'update' || row.divergence === 'tsgit-skips-write',
        );
      });

      it('Then UNTR follows the tracked-set rule', () => {
        // Assert
        expectCarried(
          outcome,
          'UNTR',
          !outcome.trackedSetChanged || row.divergence === 'tsgit-skips-write',
        );
      });

      it('Then TREE agrees with git', () => {
        // Assert
        expectTree(row, outcome);
      });

      it('Then git fsck exits 0', () => {
        // Assert
        expect(tryRunGitWithExit(['-C', outcome.oursDir, 'fsck']).exitCode).toBe(0);
      });
    });
  });
};

describe.skipIf(!GIT_AVAILABLE)('index extension carry interop', () => {
  describe('Given the base index built by git', () => {
    describe('When canonical git reads it', () => {
      let pair: PeerPair;

      beforeAll(async () => {
        pair = await makePeerPair('index-ext-base');
        await buildBase(pair.ours, 'sha1');
      }, ROW_TIMEOUT_MS);

      afterAll(async () => {
        await pair.dispose();
      });

      it('Then it carries TREE, REUC, UNTR and ZZZZ', async () => {
        // Act
        const sut = await extensionsOf(pair.ours, 'sha1');

        // Assert
        expect([...sut.keys()].sort()).toEqual(['REUC', 'TREE', 'UNTR', 'ZZZZ']);
      });

      it('Then git warns it ignores the ZZZZ extension', () => {
        // Act
        const sut = tryRunGitWithExit(['-C', pair.ours, 'ls-files']);

        // Assert
        expect(sut.stderr).toContain('ignoring ZZZZ extension');
      });
    });
  });

  describe('Given an index lock held on a twin pair', () => {
    describe('When checkout -- x/y runs in git and in tsgit', () => {
      let pair: PeerPair;
      let peer: ReturnType<typeof tryRunGitWithExit>;
      let failure: TsgitError | undefined;

      beforeAll(async () => {
        pair = await makePeerPair('index-ext-lock');
        for (const dir of [pair.peer, pair.ours]) {
          await buildBase(dir, 'sha1');
          await writeFile(path.join(dir, '.git', 'index.lock'), '');
        }
        peer = tryRunGitWithExit(['-C', pair.peer, 'checkout', '--', 'x/y']);
        failure = await checkout(contextFor(pair.ours, 'sha1'), { paths: ['x/y'] }).then(
          () => undefined,
          (err: unknown) => err as TsgitError,
        );
      }, ROW_TIMEOUT_MS);

      afterAll(async () => {
        await pair.dispose();
      });

      it('Then git refuses with exit 128 on the index lock', () => {
        // Assert
        expect(peer.exitCode).toBe(128);
        expect(peer.stderr).toContain("index.lock': File exists.");
      });

      it('Then tsgit refuses with RESOURCE_LOCKED on the same lock path', () => {
        // Assert
        expect(failure?.data).toEqual({
          code: 'RESOURCE_LOCKED',
          resource: 'index',
          path: path.join(pair.ours, '.git', 'index.lock'),
          mtimeMs: expect.any(Number),
        });
      });
    });
  });

  for (const row of [...ADD_ROWS, ...UPDATE_ROWS, ...REPLACE_ROWS]) describeRow(row);

  describeRow(ADD_MODIFIED, 'sha256');
});
