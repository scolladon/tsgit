/**
 * Cross-tool interop — the cache-tree a replace writer leaves in the index. A
 * twin pair is built identically by git, a row's preparation runs in git on
 * both, then one step runs in canonical git on the peer and in tsgit on ours.
 * The `TREE` payload bytes and the staged entries must agree, and `git fsck`
 * must pass on ours.
 *
 * @proves
 *   surface:        index
 *   bucket:         cross-tool-interop
 *   unique:         replace writers leave the same cache-tree bytes as git
 *   interopSurface: index
 */
import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { checkout } from '../../src/application/commands/checkout.js';
import { cherryPickRun } from '../../src/application/commands/cherry-pick.js';
import { mergeRun } from '../../src/application/commands/merge.js';
import { rebaseRun } from '../../src/application/commands/rebase.js';
import { reset } from '../../src/application/commands/reset.js';
import { revertRun } from '../../src/application/commands/revert.js';
import { stashApply, stashPop, stashPush } from '../../src/application/commands/stash.js';
import { worktreeAdd } from '../../src/application/commands/worktree.js';
import type { TsgitError } from '../../src/domain/error.js';
import { parseIndex } from '../../src/domain/git-index/index-parser.js';
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

const DIGEST_LENGTH: Record<Format, 20 | 32> = { sha1: 20, sha256: 32 };
const PAST_SECONDS = 10;
const TOUCH_SECONDS = 5;
const LINKED_WORKTREE = 'wt';
const ROW_TIMEOUT_MS = 180_000;

const secondsAgo = (seconds: number): Date => new Date(Date.now() - seconds * 1000);

const write = async (dir: string, file: string, body: string): Promise<void> => {
  await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await writeFile(path.join(dir, file), body);
};

const commitAll = (dir: string, message: string): void => {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
};

const contextFor = (dir: string, format: Format): Context =>
  createNodeContext({ workDir: dir, ...(format === 'sha256' ? { algorithm: 'sha256' } : {}) });

const treeBytesOf = async (indexFile: string, format: Format): Promise<Uint8Array | undefined> => {
  const index = parseIndex(new Uint8Array(await readFile(indexFile)), DIGEST_LENGTH[format]);
  return index.extensions.find((extension) => extension.signature === 'TREE')?.data;
};

/** Re-stamps every tracked file into the past and refreshes the index: a quiet, non-racy start. */
const settle = async (dir: string): Promise<void> => {
  const past = secondsAgo(PAST_SECONDS);
  for (const file of git(dir, 'ls-files').split('\n').filter(Boolean)) {
    await utimes(path.join(dir, file), past, past);
  }
  git(dir, 'update-index', '--refresh');
};

const touchForward = async (dir: string, file: string): Promise<void> => {
  const when = secondsAgo(TOUCH_SECONDS);
  await utimes(path.join(dir, file), when, when);
};

/** Root and `c` invalid, everything else valid: the start state of every unpack row. */
const fresh = async (dir: string): Promise<void> => {
  git(dir, 'checkout', '-q', '-f', 'main');
  git(dir, 'reset', '-q', '--hard', 'main-tip');
  git(dir, 'stash', 'clear');
  await settle(dir);
  await touchForward(dir, 'c/f');
  git(dir, 'add', 'c/f');
};

const buildUnpackBase = async (dir: string, format: Format): Promise<void> => {
  runGit(['init', '-q', '-b', 'main', `--object-format=${format}`, dir]);
  git(dir, 'config', 'user.name', 'Ada');
  git(dir, 'config', 'user.email', 'ada@example.com');
  git(dir, 'config', 'gc.auto', '0');
  git(dir, 'config', 'maintenance.auto', 'false');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'merge.conflictStyle', 'merge');
  await write(dir, 'a/x/f', '1\n');
  await write(dir, 'b/f', '2\n');
  await write(dir, 'c/f', '3\n');
  await write(dir, 'top', '4\n');
  commitAll(dir, 'base');
  git(dir, 'checkout', '-q', '-b', 'other');
  await write(dir, 'b/f', 'other\n');
  await write(dir, 'z/f', 'z\n');
  commitAll(dir, 'other');
  git(dir, 'checkout', '-q', 'main');
  await write(dir, 'a/x/f', 'main\n');
  git(dir, 'commit', '-q', '-am', 'main');
  git(dir, 'tag', 'main-tip');
  await fresh(dir);
};

const buildMixedBase = async (dir: string, format: Format): Promise<void> => {
  runGit(['init', '-q', '-b', 'main', `--object-format=${format}`, dir]);
  git(dir, 'config', 'user.name', 'Ada');
  git(dir, 'config', 'user.email', 'ada@example.com');
  git(dir, 'config', 'gc.auto', '0');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'merge.conflictStyle', 'merge');
  await write(dir, 'b/f', 'b\n');
  await write(dir, 'd/1', 'one\n');
  await write(dir, 'd/2', 'two\n');
  commitAll(dir, 'base');
  git(dir, 'checkout', '-q', '-b', 'side');
  await write(dir, 'b/f', 'side\n');
  await write(dir, 'd/1', 'side1\n');
  git(dir, 'commit', '-q', '-am', 'side');
  git(dir, 'checkout', '-q', 'main');
  await write(dir, 'b/f', 'main\n');
  await write(dir, 'd/2', 'main2\n');
  git(dir, 'commit', '-q', '-am', 'main');
  await settle(dir);
};

type AbcLayout = 'plain' | 'withD' | 'withOld' | 'nested';

const buildAbcBase = async (dir: string, format: Format, layout: AbcLayout): Promise<void> => {
  runGit(['init', '-q', '-b', 'main', `--object-format=${format}`, dir]);
  git(dir, 'config', 'user.name', 'Ada');
  git(dir, 'config', 'user.email', 'ada@example.com');
  git(dir, 'config', 'gc.auto', '0');
  git(dir, 'config', 'commit.gpgsign', 'false');
  await write(dir, layout === 'nested' ? 'a/s/x' : 'a/x', 'x\n');
  await write(dir, 'b/f', 'b\n');
  await write(dir, 'c/f', 'c\n');
  if (layout === 'withD') await write(dir, 'd/f', 'd\n');
  if (layout === 'withOld') await write(dir, 'a/old/f', 'o\n');
  commitAll(dir, 'base');
  git(dir, 'checkout', '-q', '-b', 'other');
  await write(dir, 'b/f', 'other\n');
  if (layout === 'withD') git(dir, 'rm', '-q', 'd/f');
  if (layout === 'withOld') git(dir, 'rm', '-q', 'a/old/f');
  commitAll(dir, 'other');
  git(dir, 'checkout', '-q', 'main');
  await settle(dir);
};

interface Row {
  readonly title: string;
  readonly base?: 'unpack' | 'mixed' | 'abc' | 'abcd' | 'oldDir' | 'nested';
  readonly prepare?: (dir: string) => Promise<void>;
  readonly git: (dir: string) => void;
  readonly tsgit: (ctx: Context) => Promise<unknown>;
  /** The prepared history names an object that was never stored, so fsck cannot pass in either repository. */
  readonly danglingByDesign?: boolean;
  /** The index compared is the linked worktree's own, not the repository's. */
  readonly linked?: boolean;
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

const restage = async (dir: string, file: string, body: string): Promise<void> => {
  await write(dir, file, body);
  git(dir, 'add', file);
};

const dirtyCacheTreeOfC = async (dir: string): Promise<void> => {
  await settle(dir);
  await touchForward(dir, 'c/f');
  git(dir, 'add', 'c/f');
};

const stagedBThenStashed = async (dir: string): Promise<void> => {
  await restage(dir, 'b/f', 'staged\n');
  await write(dir, 'top', 'wt\n');
  git(dir, 'stash', 'push', '-q');
  await dirtyCacheTreeOfC(dir);
};

/** Stages new content under a/s, stores its trees, then loses the objects of a/s and a. */
const stagedThenTreesLost = async (dir: string): Promise<void> => {
  await restage(dir, 'a/s/x', 'y\n');
  const root = git(dir, 'write-tree').trim();
  for (const spec of [`${root}:a/s`, `${root}:a`]) {
    const id = git(dir, 'rev-parse', spec).trim();
    await rm(path.join(dir, '.git', 'objects', id.slice(0, 2), id.slice(2)));
  }
};

const GUARDS: ReadonlyArray<Row> = [
  {
    title: 'checkout other',
    git: ok('checkout', '-q', 'other'),
    tsgit: (c) => checkout(c, { rev: 'other' }),
  },
  {
    title: 'checkout other with a staged c/f',
    prepare: (dir) => restage(dir, 'c/f', 'staged\n'),
    git: ok('checkout', '-q', 'other'),
    tsgit: (c) => checkout(c, { rev: 'other' }),
  },
  {
    title: 'checkout -b same (same tree)',
    git: ok('checkout', '-q', '-b', 'same'),
    tsgit: (c) => checkout(c, { rev: 'HEAD', createBranch: { name: 'same' } }),
  },
  {
    title: 'reset --hard',
    git: ok('reset', '-q', '--hard'),
    tsgit: (c) => reset(c, { mode: 'hard', rev: 'HEAD' }),
  },
  {
    title: 'reset --hard HEAD~1',
    git: ok('reset', '-q', '--hard', 'HEAD~1'),
    tsgit: (c) => reset(c, { mode: 'hard', rev: 'HEAD~1' }),
  },
  {
    title: 'reset (mixed, same HEAD)',
    git: ok('reset', '-q'),
    tsgit: (c) => reset(c, { mode: 'mixed', rev: 'HEAD' }),
  },
  {
    title: 'reset HEAD~1 (mixed)',
    git: ok('reset', '-q', 'HEAD~1'),
    tsgit: (c) => reset(c, { mode: 'mixed', rev: 'HEAD~1' }),
  },
  {
    title: 'merge other (clean, non-ff)',
    git: ok('merge', '-q', '--no-edit', 'other'),
    tsgit: (c) => mergeRun(c, { rev: 'other' }),
  },
  {
    title: 'merge --ff-only',
    prepare: async (dir) => {
      git(dir, 'checkout', '-q', '-b', 'ff', 'main-tip~1');
      await dirtyCacheTreeOfC(dir);
    },
    git: ok('merge', '-q', '--ff-only', 'main-tip'),
    tsgit: (c) => mergeRun(c, { rev: 'main-tip', fastForward: 'only' }),
  },
  {
    title: 'merge other (conflict on b/f)',
    prepare: async (dir) => {
      await write(dir, 'b/f', 'mine\n');
      git(dir, 'commit', '-q', '-am', 'mine');
      await dirtyCacheTreeOfC(dir);
    },
    git: lenient('merge', '--no-edit', 'other'),
    tsgit: (c) => mergeRun(c, { rev: 'other' }),
  },
  {
    title: 'cherry-pick other',
    git: ok('cherry-pick', 'other'),
    tsgit: (c) => cherryPickRun(c, { commits: ['other'] }),
  },
  {
    title: 'revert HEAD',
    git: ok('revert', '--no-edit', 'HEAD'),
    tsgit: (c) => revertRun(c, { commits: ['HEAD'] }),
  },
  {
    title: 'rebase onto main',
    prepare: async (dir) => {
      git(dir, 'checkout', '-q', '-b', 'rb', 'other');
      await dirtyCacheTreeOfC(dir);
    },
    git: ok('rebase', '-q', 'main-tip'),
    tsgit: (c) => rebaseRun(c, { upstream: 'main-tip' }),
  },
  {
    title: 'stash push',
    prepare: (dir) => write(dir, 'top', 'dirty\n'),
    git: ok('stash', 'push', '-q'),
    tsgit: (c) => stashPush(c, {}),
  },
  {
    title: 'stash pop --index (staged b/f)',
    prepare: stagedBThenStashed,
    git: ok('stash', 'pop', '-q', '--index'),
    tsgit: (c) => stashPop(c, { restoreIndex: true }),
  },
  {
    title: 'stash apply (staged b/f, no --index)',
    prepare: async (dir) => {
      await restage(dir, 'b/f', 'staged2\n');
      git(dir, 'stash', 'push', '-q');
      await dirtyCacheTreeOfC(dir);
    },
    git: ok('stash', 'apply', '-q'),
    tsgit: (c) => stashApply(c, {}),
  },
  {
    title: 'checkout other -- z/f',
    git: ok('checkout', '-q', 'other', '--', 'z/f'),
    tsgit: (c) => checkout(c, { paths: ['z/f'], source: 'other' }),
  },
  {
    title: 'checkout -- c/f',
    git: ok('checkout', '-q', '--', 'c/f'),
    tsgit: (c) => checkout(c, { paths: ['c/f'] }),
  },
  {
    title: 'stash apply of a worktree-only change of c/f',
    prepare: async (dir) => {
      await write(dir, 'c/f', 'wt-only\n');
      git(dir, 'stash', 'push', '-q');
    },
    git: ok('stash', 'apply', '-q'),
    tsgit: (c) => stashApply(c, {}),
  },
  {
    title: 'stash apply, the stash had a staged new n/f',
    prepare: async (dir) => {
      await restage(dir, 'n/f', 'new\n');
      git(dir, 'stash', 'push', '-q');
    },
    git: ok('stash', 'apply', '-q'),
    tsgit: (c) => stashApply(c, {}),
  },
  {
    title: 'stash apply --index (new n/f and staged c/f)',
    prepare: async (dir) => {
      await restage(dir, 'n/f', 'new\n');
      await restage(dir, 'c/f', 'staged-c\n');
      git(dir, 'stash', 'push', '-q');
    },
    git: ok('stash', 'apply', '-q', '--index'),
    tsgit: (c) => stashApply(c, { restoreIndex: true }),
  },
  {
    title: 'stash apply onto a dirty b/f',
    prepare: async (dir) => {
      await write(dir, 'c/f', 'wt\n');
      git(dir, 'stash', 'push', '-q');
      await write(dir, 'b/f', 'wtb\n');
    },
    git: ok('stash', 'apply', '-q'),
    tsgit: (c) => stashApply(c, {}),
  },
  {
    title: 'stash push --keep-index (staged b/f, worktree c/f, stat-only a/x/f)',
    prepare: async (dir) => {
      await restage(dir, 'b/f', 'staged\n');
      await write(dir, 'c/f', 'wt\n');
      await touchForward(dir, 'a/x/f');
      git(dir, 'add', 'a/x/f');
    },
    git: ok('stash', 'push', '-q', '--keep-index'),
    tsgit: (c) => stashPush(c, { keepIndex: true }),
  },
  {
    title: 'worktree add (other)',
    linked: true,
    git: ok('worktree', 'add', '-q', LINKED_WORKTREE, 'other'),
    tsgit: (c) => worktreeAdd(c, { path: LINKED_WORKTREE, commitish: 'other' }),
  },
  {
    title: 'merge with a conflicted b/f beside a cleanly merged d/',
    base: 'mixed',
    git: lenient('merge', 'side'),
    tsgit: (c) => mergeRun(c, { rev: 'side' }),
  },
  {
    title: 'checkout a commit of the empty tree that was never stored',
    base: 'abc',
    danglingByDesign: true,
    prepare: async (dir) => {
      const empty = git(dir, 'hash-object', '-t', 'tree', '/dev/null').trim();
      const commit = git(dir, 'commit-tree', empty, '-m', 'empty').trim();
      git(dir, 'tag', 'empty', commit);
    },
    git: ok('checkout', '-q', 'empty'),
    tsgit: (c) => checkout(c, { rev: 'empty' }),
  },
  {
    title: 'checkout other above a staged new directory a/new that has no tree',
    base: 'abc',
    prepare: (dir) => restage(dir, 'a/new/f', 'n\n'),
    git: ok('checkout', '-q', 'other'),
    tsgit: (c) => checkout(c, { rev: 'other' }),
  },
  {
    title: 'checkout other above a staged a/new, with d deleted by the target',
    base: 'abcd',
    prepare: (dir) => restage(dir, 'a/new/f', 'n\n'),
    git: ok('checkout', '-q', 'other'),
    tsgit: (c) => checkout(c, { rev: 'other' }),
  },
  {
    title: 'checkout other above a staged a/new, with the carried a/old gone from the index',
    base: 'oldDir',
    prepare: (dir) => restage(dir, 'a/new/f', 'n\n'),
    git: ok('checkout', '-q', 'other'),
    tsgit: (c) => checkout(c, { rev: 'other' }),
  },
  {
    title: 'checkout other with the stored trees of a staged a/s and a lost',
    base: 'nested',
    danglingByDesign: true,
    prepare: stagedThenTreesLost,
    git: ok('checkout', '-q', 'other'),
    tsgit: (c) => checkout(c, { rev: 'other' }),
  },
];

const buildBase = (row: Row, dir: string, format: Format): Promise<void> => {
  if (row.base === 'mixed') return buildMixedBase(dir, format);
  if (row.base === 'abc') return buildAbcBase(dir, format, 'plain');
  if (row.base === 'abcd') return buildAbcBase(dir, format, 'withD');
  if (row.base === 'nested') return buildAbcBase(dir, format, 'nested');
  if (row.base === 'oldDir') return buildAbcBase(dir, format, 'withOld');
  return buildUnpackBase(dir, format);
};

const indexTreeOf = (row: Row, dir: string, format: Format): Promise<Uint8Array | undefined> =>
  treeBytesOf(
    row.linked === true
      ? path.join(dir, '.git', 'worktrees', LINKED_WORKTREE, 'index')
      : path.join(dir, '.git', 'index'),
    format,
  );

const describeRow = (row: Row, format: Format = 'sha1'): void => {
  describe(`Given a git-built index with an invalid root and c (${format})`, () => {
    describe(`When ${row.title} runs in tsgit and in git on a twin`, () => {
      let pair: PeerPair;
      let ours: Uint8Array | undefined;
      let peer: Uint8Array | undefined;

      beforeAll(async () => {
        pair = await makePeerPair('cache-tree-repair');
        for (const dir of [pair.peer, pair.ours]) {
          await buildBase(row, dir, format);
          await row.prepare?.(dir);
        }
        row.git(pair.peer);
        await row.tsgit(contextFor(pair.ours, format));
        ours = await indexTreeOf(row, pair.ours, format);
        peer = await indexTreeOf(row, pair.peer, format);
      }, ROW_TIMEOUT_MS);

      afterAll(async () => {
        await pair.dispose();
      });

      it('Then TREE is byte-equal to git', () => {
        // Arrange + Assert
        expect(peer).toBeDefined();
        expect(ours).toEqual(peer);
      });

      it.skipIf(row.danglingByDesign === true)('Then git fsck exits 0', () => {
        // Arrange + Assert
        expect(tryRunGitWithExit(['-C', pair.ours, 'fsck']).exitCode).toBe(0);
      });
    });
  });
};

interface SwitchRow {
  readonly title: string;
  readonly prepare: (dir: string) => Promise<void>;
  readonly refuses: boolean;
  readonly probe: string;
}

const SWITCH_ROWS: ReadonlyArray<SwitchRow> = [
  {
    title: 'c/f edited and staged',
    prepare: (dir) => restage(dir, 'c/f', 'staged\n'),
    refuses: false,
    probe: 'c/f',
  },
  {
    title: 'b/f edited and staged',
    prepare: (dir) => restage(dir, 'b/f', 'staged\n'),
    refuses: true,
    probe: 'b/f',
  },
  {
    title: 'b/f staged, then the work file rewritten to the target content',
    prepare: async (dir) => {
      await restage(dir, 'b/f', 'staged\n');
      await write(dir, 'b/f', 'other\n');
    },
    refuses: true,
    probe: 'b/f',
  },
  {
    title: 'b/f staged with the target content',
    prepare: (dir) => restage(dir, 'b/f', 'other\n'),
    refuses: false,
    probe: 'b/f',
  },
  {
    title: 'a new n/f staged',
    prepare: (dir) => restage(dir, 'n/f', 'new\n'),
    refuses: false,
    probe: 'n/f',
  },
  {
    title: 'c/f removed with git rm',
    prepare: async (dir) => {
      git(dir, 'rm', '-q', 'c/f');
    },
    refuses: false,
    probe: 'c/f',
  },
  {
    title: 'a new z/f staged where the target adds z/f',
    prepare: (dir) => restage(dir, 'z/f', 'staged\n'),
    refuses: true,
    probe: 'z/f',
  },
  {
    title: 'c/f edited and unstaged',
    prepare: (dir) => write(dir, 'c/f', 'wt\n'),
    refuses: false,
    probe: 'c/f',
  },
  {
    title: 'an out-of-pattern c/f deleted from the index under a cone on b',
    prepare: async (dir) => {
      await coneOnB(dir);
      git(dir, 'rm', '-q', '--cached', '--sparse', 'c/f');
    },
    refuses: false,
    probe: 'c/f',
  },
  {
    title: 'an out-of-pattern n/f staged under a cone on b',
    prepare: async (dir) => {
      await coneOnB(dir);
      await write(dir, 'n/f', 'new\n');
      const blob = git(dir, 'hash-object', '-w', 'n/f').trim();
      await rm(path.join(dir, 'n'), { recursive: true });
      git(dir, 'update-index', '--add', '--cacheinfo', `100644,${blob},n/f`);
    },
    refuses: false,
    probe: 'n/f',
  },
];

/** The sparse patterns land in the shared config, where tsgit reads them. */
const coneOnB = async (dir: string): Promise<void> => {
  git(dir, 'sparse-checkout', 'set', '--cone', 'b');
  for (const key of ['core.sparseCheckout', 'core.sparseCheckoutCone']) {
    git(dir, 'config', '--worktree', '--unset', key);
    git(dir, 'config', key, 'true');
  }
  git(dir, 'config', '--unset', 'extensions.worktreeConfig');
};

const tsgitRefusalOf = async (ctx: Context): Promise<string | undefined> => {
  try {
    await checkout(ctx, { rev: 'other' });
  } catch (e) {
    return (e as TsgitError).data.code;
  }
  return undefined;
};

const workFileOf = (dir: string, file: string): Promise<string | undefined> =>
  readFile(path.join(dir, file), 'utf8').catch(() => undefined);

const describeSwitchRow = (row: SwitchRow): void => {
  describe(`Given a git-built repository with ${row.title}`, () => {
    describe('When checkout other runs in tsgit and in git on a twin', () => {
      let pair: PeerPair;
      let peerExit: number;
      let ourCode: string | undefined;

      beforeAll(async () => {
        pair = await makePeerPair('cache-tree-repair');
        for (const dir of [pair.peer, pair.ours]) {
          await buildUnpackBase(dir, 'sha1');
          await row.prepare(dir);
        }
        peerExit = tryRunGitWithExit(['-C', pair.peer, 'checkout', '-q', 'other']).exitCode;
        ourCode = await tsgitRefusalOf(contextFor(pair.ours, 'sha1'));
      }, ROW_TIMEOUT_MS);

      afterAll(async () => {
        await pair.dispose();
      });

      it('Then both refuse or both switch', () => {
        // Arrange + Assert
        expect(peerExit !== 0).toBe(row.refuses);
        expect(ourCode).toBe(row.refuses ? 'CHECKOUT_OVERWRITE_DIRTY' : undefined);
      });

      it('Then the staged entries and the status equal git', () => {
        // Arrange + Assert
        for (const args of [
          ['ls-files', '-s', '-t'],
          ['status', '--porcelain'],
        ]) {
          expect(git(pair.ours, ...args)).toBe(git(pair.peer, ...args));
        }
      });

      it('Then the probed work file equals git', async () => {
        // Arrange + Assert
        expect(await workFileOf(pair.ours, row.probe)).toBe(await workFileOf(pair.peer, row.probe));
      });

      it('Then git fsck exits 0', () => {
        // Arrange + Assert
        expect(tryRunGitWithExit(['-C', pair.ours, 'fsck']).exitCode).toBe(0);
      });
    });
  });
};

describe.skipIf(!GIT_AVAILABLE)('cache-tree repair interop', () => {
  for (const row of GUARDS) describeRow(row);
  describeRow(GUARDS[0] as Row, 'sha256');
  for (const row of SWITCH_ROWS) describeSwitchRow(row);
});
