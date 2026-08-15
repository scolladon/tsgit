/**
 * Cross-tool interop — the deep-tree faithfulness matrix for `walkTree`,
 * `archive` and `synthesizeTreeFromIndex`. Every deep fixture is built
 * path-as-data (`update-index --add --cacheinfo` then `write-tree`), never
 * materialised on disk: darwin's `PATH_MAX` (1024) kills a real checkout at
 * depth ~471, long before git's own 2048-deep default.
 *
 * Pins: the default-cap split at D=2048/2049 (`ls-tree -r` vs `walkTree`);
 * `archive`'s newly-restored depth refusal (the single most valuable
 * assertion here — it fails on `main`, where `archive` refuses at no input);
 * `fsck`'s deliberate absence of a depth check; the one residual divergence
 * this change keeps (`write-tree` never refuses on depth, `synthesizeTreeFromIndex`
 * does); the `core.maxTreeDepth` value grammar (unit suffixes, malformed values);
 * zero/negative caps as valid (not "disabled"); and the local-only config-scope
 * divergence tsgit publishes rather than hides.
 *
 * @proves
 *   surface:        walkTree, archive, fsck, synthesizeTreeFromIndex
 *   bucket:         cross-tool-interop
 *   unique:         core.maxTreeDepth's refusal boundary, value grammar, and
 *                    local-only scope match real git's read-tree/ls-tree/archive
 *                    behaviour; write-tree's absence of a depth policy is the
 *                    documented basis for tsgit's one residual divergence
 *   interopSurface: archive, fsck
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { archive } from '../../src/application/commands/archive.js';
import { fsck } from '../../src/application/commands/fsck.js';
import { invalidateConfigCache } from '../../src/application/primitives/config-read.js';
import { readIndex } from '../../src/application/primitives/read-index.js';
import { synthesizeTreeFromIndex } from '../../src/application/primitives/synthesize-tree-from-index.js';
import type { WalkTreeEntry } from '../../src/application/primitives/types.js';
import { walkTree } from '../../src/application/primitives/walk-tree.js';
import { TsgitError } from '../../src/domain/error.js';
import type { IndexEntry } from '../../src/domain/git-index/index.js';
import { isDirectory, type ObjectId } from '../../src/domain/objects/index.js';
import type { Context } from '../../src/ports/context.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  runGit,
  runGitEnv,
  tryRunGitWithExit,
} from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;

const datedEnv = (epoch: number): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'A U Thor',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_AUTHOR_DATE: `${epoch} +0000`,
  GIT_COMMITTER_NAME: 'A U Thor',
  GIT_COMMITTER_EMAIL: 'author@example.com',
  GIT_COMMITTER_DATE: `${epoch} +0000`,
});

// ---------------------------------------------------------------------------
// Deep-fixture builders — path-as-data, never materialised on disk.
// ---------------------------------------------------------------------------

/** A path with exactly `slashes` slashes: `d0/d1/…/d{slashes}`. */
const deepPath = (slashes: number): string =>
  Array.from({ length: slashes + 1 }, (_unused, i) => `d${i}`).join('/');

/**
 * Extracts the path column from `git ls-tree -r` stdout — one
 * `<mode> blob <oid>\t<path>` line per blob — so an at-cap row can compare
 * git's own enumeration against tsgit's, not merely count git's exit code.
 */
const parseLsTreePaths = (stdout: string): string[] =>
  stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.slice(line.indexOf('\t') + 1));

/**
 * Narrows `walkTree`'s pre-order output — every directory AND blob entry on
 * the path — down to blob paths only, the same scope `git ls-tree -r`
 * reports (trees are elided without `-t`), so tsgit's enumeration is
 * comparable to git's.
 */
const blobPathsOf = (entries: readonly WalkTreeEntry[]): string[] =>
  entries.filter((entry) => !isDirectory(entry.mode)).map((entry) => entry.path);

const resetIndex = (dir: string): void => {
  const indexFile = path.join(dir, '.git', 'index');
  if (existsSync(indexFile)) unlinkSync(indexFile);
};

interface DeepTreeBuild {
  readonly treeOid: string;
  readonly writeTreeExitCode: number;
}

/**
 * One index entry at depth `depth`, written via `update-index --add
 * --cacheinfo` (path as data, no filesystem write), then `write-tree`. The
 * shared repo's index is reset first so each depth's tree is built from
 * exactly one entry, not an accumulation of every depth built so far.
 */
const buildDeepTree = (dir: string, blobOid: string, depth: number): DeepTreeBuild => {
  resetIndex(dir);
  runGit([
    '-C',
    dir,
    'update-index',
    '--add',
    '--cacheinfo',
    `100644,${blobOid},${deepPath(depth)}`,
  ]);
  const result = tryRunGitWithExit(['-C', dir, 'write-tree']);
  return { treeOid: result.stdout.trim(), writeTreeExitCode: result.exitCode };
};

/** Read the index's entries right after a `buildDeepTree` call, before the
 * next call resets it — via a disposable Context so the shared `ctx` built
 * at the end of `beforeAll` never needs re-reading mid-setup. */
const readDeepIndexEntries = async (dir: string): Promise<ReadonlyArray<IndexEntry>> => {
  const disposableCtx = createNodeContext({ workDir: dir });
  const index = await readIndex(disposableCtx);
  return index.entries;
};

const drain = async <T>(iter: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
};

interface DepthErrorData {
  readonly code: string;
  readonly depth?: number;
}

const expectTreeDepthExceeded = async (
  op: () => Promise<unknown>,
  depth: number,
): Promise<void> => {
  let caught: unknown;
  try {
    await op();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(TsgitError);
  const data = (caught as TsgitError).data as DepthErrorData;
  expect(data.code).toBe('TREE_DEPTH_EXCEEDED');
  expect(data.depth).toBe(depth);
};

const expectConfigBadNumericValue = async (op: () => Promise<unknown>): Promise<void> => {
  let caught: unknown;
  try {
    await op();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(TsgitError);
  const data = (caught as TsgitError).data as DepthErrorData;
  expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
};

describe.skipIf(!GIT_AVAILABLE)('core.maxTreeDepth — deep-tree cross-tool interop', () => {
  let dir = '';
  let configPath = '';
  let baseConfigText = '';
  let ctx: Context;

  let tree2048 = '';
  let tree2049 = '';
  let tree4097 = '';
  let tree1024 = '';
  let tree1025 = '';
  let tree0 = '';
  let tree1 = '';
  let tree6 = '';

  let write2049ExitCode = -1;
  let write8000ExitCode = -1;
  let index2049Entries: ReadonlyArray<IndexEntry> = [];
  let index8000Entries: ReadonlyArray<IndexEntry> = [];

  const setLocalMaxTreeDepth = (value: string): void => {
    writeFileSync(configPath, `[core]\n\tmaxTreeDepth = ${value}\n`);
    invalidateConfigCache(ctx);
  };

  const clearLocalMaxTreeDepth = (): void => {
    writeFileSync(configPath, baseConfigText);
    invalidateConfigCache(ctx);
  };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-tree-depth-'));
    configPath = path.join(dir, '.git', 'config');

    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'A U Thor');
    git(dir, 'config', 'user.email', 'author@example.com');
    git(dir, 'config', 'commit.gpgsign', 'false');
    disableAutoMaintenance(dir);

    writeFileSync(path.join(dir, 'file.txt'), 'hello\n');
    git(dir, 'add', '-A');
    runGit(['-C', dir, 'commit', '-q', '--no-gpg-sign', '-m', 'c0'], {
      env: datedEnv(1_700_000_000),
    });

    baseConfigText = readFileSync(configPath, 'utf8');

    const blobOid = runGit(['-C', dir, 'hash-object', '-w', '--stdin'], { input: 'leaf\n' }).trim();

    tree2048 = buildDeepTree(dir, blobOid, 2048).treeOid;
    tree2049 = buildDeepTree(dir, blobOid, 2049).treeOid;
    index2049Entries = await readDeepIndexEntries(dir);

    tree4097 = buildDeepTree(dir, blobOid, 4097).treeOid;
    tree1024 = buildDeepTree(dir, blobOid, 1024).treeOid;
    tree1025 = buildDeepTree(dir, blobOid, 1025).treeOid;
    tree0 = buildDeepTree(dir, blobOid, 0).treeOid;
    tree1 = buildDeepTree(dir, blobOid, 1).treeOid;
    tree6 = buildDeepTree(dir, blobOid, 6).treeOid;

    const build2049Again = buildDeepTree(dir, blobOid, 2049);
    write2049ExitCode = build2049Again.writeTreeExitCode;
    const build8000 = buildDeepTree(dir, blobOid, 8000);
    write8000ExitCode = build8000.writeTreeExitCode;
    index8000Entries = await readDeepIndexEntries(dir);

    // Built AFTER every git write above — the per-Context loose-object fanout
    // cache is invalidated only by tsgit's own writeObject.
    ctx = createNodeContext({ workDir: dir });
  }, SETUP_TIMEOUT);

  afterAll(async () => rm(dir, { recursive: true, force: true }));

  // ─────────────────────────────────────────────────────────────────────
  // Pin 2 / R4–R5 — the default-cap split at D=2048/2049.
  // ─────────────────────────────────────────────────────────────────────

  describe('Given config unset (default cap 2048) and trees at D=2048 and D=2049', () => {
    describe('When ls-tree -r / walkTree are driven at D=2048 (at cap)', () => {
      it('Then git ls-tree -r and walkTree both enumerate exactly the one deep blob, at the same path', async () => {
        // Arrange + Act
        const g = tryRunGitWithExit(['-C', dir, 'ls-tree', '-r', tree2048]);
        const entries = await drain<WalkTreeEntry>(walkTree(ctx, tree2048 as ObjectId));

        // Assert — the fixture's single index entry means exactly one blob
        // exists at any depth; comparing the path (not just a nonzero count)
        // against git's own stdout proves the walk reached the real leaf
        // rather than yielding a wrong node early. walkTree's pre-order
        // output also carries every intermediate directory, so it is
        // narrowed to blob paths before the cross-tool comparison.
        expect(g.exitCode).toBe(0);
        const gitPaths = parseLsTreePaths(g.stdout);
        expect(gitPaths).toEqual([deepPath(2048)]);
        expect(blobPathsOf(entries)).toEqual(gitPaths);
      });
    });

    describe('When ls-tree -r / walkTree are driven at D=2049 (one past cap)', () => {
      it('Then git ls-tree -r exits 1 and walkTree throws TREE_DEPTH_EXCEEDED with depth 2049', async () => {
        // Arrange + Act
        const g = tryRunGitWithExit(['-C', dir, 'ls-tree', '-r', tree2049]);

        // Assert
        expect(g.exitCode).toBe(1);
        await expectTreeDepthExceeded(() => drain(walkTree(ctx, tree2049 as ObjectId)), 2049);
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // R9 — archive's restored depth refusal. Fails on `main`: today archive
  // refuses at no input at all.
  // ─────────────────────────────────────────────────────────────────────

  describe('Given the D=2049 tree', () => {
    describe('When archive --format=tar is driven', () => {
      it('Then git exits 128 and tsgit archive throws TREE_DEPTH_EXCEEDED with depth 2049', async () => {
        // Arrange + Act
        const g = tryRunGitWithExit(['-C', dir, 'archive', '--format=tar', tree2049]);

        // Assert
        expect(g.exitCode).toBe(128);
        await expectTreeDepthExceeded(async () => {
          const result = await archive(ctx, { treeish: tree2049 });
          await drain(result.entries);
        }, 2049);
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // R13 — fsck does NOT check depth. Negative assertion.
  // ─────────────────────────────────────────────────────────────────────

  describe('Given a repo containing the D=2049 tree', () => {
    describe('When fsck --strict is driven', () => {
      it('Then git exits 0 and tsgit fsck does not throw', async () => {
        // Arrange + Act
        const g = tryRunGitWithExit(['-C', dir, 'fsck', '--strict']);
        const result = await fsck(ctx);

        // Assert — reaching this line without throwing is the proof that
        // fsck grew no depth check; the checks below merely give this
        // block a positive statement to make.
        expect(g.exitCode).toBe(0);
        expect(result).toBeDefined();
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // W2 / W4 — the one residual divergence: write-tree never refuses on
  // depth; synthesizeTreeFromIndex does, at the default cap.
  // ─────────────────────────────────────────────────────────────────────

  describe('Given an index entry at D=2049', () => {
    describe('When write-tree / synthesizeTreeFromIndex are driven', () => {
      it('Then git write-tree exits 0 but tsgit synthesis throws TREE_DEPTH_EXCEEDED', async () => {
        // Arrange + Act + Assert
        expect(write2049ExitCode).toBe(0);
        await expectTreeDepthExceeded(() => synthesizeTreeFromIndex(ctx, index2049Entries), 2049);
      });
    });
  });

  describe('Given an index entry at D=8000 (far deeper than any configured cap)', () => {
    describe('When write-tree / synthesizeTreeFromIndex are driven', () => {
      it('Then git write-tree exits 0 but tsgit synthesis throws TREE_DEPTH_EXCEEDED', async () => {
        // Arrange + Act + Assert
        expect(write8000ExitCode).toBe(0);
        await expectTreeDepthExceeded(() => synthesizeTreeFromIndex(ctx, index8000Entries), 8000);
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // C1 / C2 / C3 — the configured cap moves the boundary, in both tools,
  // including a cap two orders of magnitude above the default.
  // ─────────────────────────────────────────────────────────────────────

  describe('Given the D=4097 tree', () => {
    describe('When core.maxTreeDepth = 4096', () => {
      it('Then git ls-tree -r exits 1 and walkTree throws TREE_DEPTH_EXCEEDED with depth 4097', async () => {
        // Arrange
        setLocalMaxTreeDepth('4096');

        // Act
        const g = tryRunGitWithExit([
          '-C',
          dir,
          '-c',
          'core.maxTreeDepth=4096',
          'ls-tree',
          '-r',
          tree4097,
        ]);

        // Assert
        expect(g.exitCode).toBe(1);
        await expectTreeDepthExceeded(() => drain(walkTree(ctx, tree4097 as ObjectId)), 4097);
      });
    });

    describe('When core.maxTreeDepth = 4097 (exactly at cap)', () => {
      it('Then git ls-tree -r and walkTree both enumerate exactly the one deep blob, at the same path', async () => {
        // Arrange
        setLocalMaxTreeDepth('4097');

        // Act
        const g = tryRunGitWithExit([
          '-C',
          dir,
          '-c',
          'core.maxTreeDepth=4097',
          'ls-tree',
          '-r',
          tree4097,
        ]);
        const entries = await drain(walkTree(ctx, tree4097 as ObjectId));

        // Assert
        expect(g.exitCode).toBe(0);
        const gitPaths = parseLsTreePaths(g.stdout);
        expect(gitPaths).toEqual([deepPath(4097)]);
        expect(blobPathsOf(entries)).toEqual(gitPaths);
      });
    });

    describe('When core.maxTreeDepth = 100000 (two orders of magnitude above default)', () => {
      it('Then git ls-tree -r and walkTree both enumerate exactly the one deep blob, at the same path', async () => {
        // Arrange
        setLocalMaxTreeDepth('100000');

        // Act
        const g = tryRunGitWithExit([
          '-C',
          dir,
          '-c',
          'core.maxTreeDepth=100000',
          'ls-tree',
          '-r',
          tree4097,
        ]);
        const entries = await drain(walkTree(ctx, tree4097 as ObjectId));

        // Assert
        expect(g.exitCode).toBe(0);
        const gitPaths = parseLsTreePaths(g.stdout);
        expect(gitPaths).toEqual([deepPath(4097)]);
        expect(blobPathsOf(entries)).toEqual(gitPaths);
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Pin 4 — the value grammar: a malformed value refuses in both tools;
  // a unit-suffixed value ("1k") parses identically and moves the boundary
  // to D=1024/1025 in both.
  // ─────────────────────────────────────────────────────────────────────

  describe('Given core.maxTreeDepth = "2.5" (malformed)', () => {
    describe('When ls-tree -r / walkTree are driven', () => {
      it('Then git exits 128 and tsgit walkTree throws CONFIG_BAD_NUMERIC_VALUE', async () => {
        // Arrange
        setLocalMaxTreeDepth('2.5');

        // Act
        const g = tryRunGitWithExit([
          '-C',
          dir,
          '-c',
          'core.maxTreeDepth=2.5',
          'ls-tree',
          '-r',
          tree6,
        ]);

        // Assert — tsgit matches the refusal CONDITION, never git's stderr
        // bytes nor the all-lowercase key spelling git quotes back.
        expect(g.exitCode).toBe(128);
        await expectConfigBadNumericValue(() => drain(walkTree(ctx, tree6 as ObjectId)));
      });
    });
  });

  describe('Given core.maxTreeDepth = "1k" (unit-suffixed, parses as 1024)', () => {
    describe('When driven at D=1024 (at cap)', () => {
      it('Then git ls-tree -r and walkTree both enumerate exactly the one deep blob, at the same path', async () => {
        // Arrange
        setLocalMaxTreeDepth('1k');

        // Act
        const g = tryRunGitWithExit([
          '-C',
          dir,
          '-c',
          'core.maxTreeDepth=1k',
          'ls-tree',
          '-r',
          tree1024,
        ]);
        const entries = await drain(walkTree(ctx, tree1024 as ObjectId));

        // Assert
        expect(g.exitCode).toBe(0);
        const gitPaths = parseLsTreePaths(g.stdout);
        expect(gitPaths).toEqual([deepPath(1024)]);
        expect(blobPathsOf(entries)).toEqual(gitPaths);
      });
    });

    describe('When driven at D=1025 (one past cap)', () => {
      it('Then git ls-tree -r exits 1 and walkTree throws TREE_DEPTH_EXCEEDED with depth 1025', async () => {
        // Arrange
        setLocalMaxTreeDepth('1k');

        // Act
        const g = tryRunGitWithExit([
          '-C',
          dir,
          '-c',
          'core.maxTreeDepth=1k',
          'ls-tree',
          '-r',
          tree1025,
        ]);

        // Assert
        expect(g.exitCode).toBe(1);
        await expectTreeDepthExceeded(() => drain(walkTree(ctx, tree1025 as ObjectId)), 1025);
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Pin 5 — zero is a valid cap, not "disabled": a depth-0 tree is accepted,
  // a depth-1 tree is refused. Two isolated tests, one per condition.
  // ─────────────────────────────────────────────────────────────────────

  describe('Given core.maxTreeDepth = 0 and a depth-0 tree', () => {
    describe('When ls-tree -r / walkTree are driven', () => {
      it('Then git and walkTree both enumerate exactly the one blob, at the same path (0 > 0 is false)', async () => {
        // Arrange
        setLocalMaxTreeDepth('0');

        // Act
        const g = tryRunGitWithExit([
          '-C',
          dir,
          '-c',
          'core.maxTreeDepth=0',
          'ls-tree',
          '-r',
          tree0,
        ]);
        const entries = await drain(walkTree(ctx, tree0 as ObjectId));

        // Assert
        expect(g.exitCode).toBe(0);
        const gitPaths = parseLsTreePaths(g.stdout);
        expect(gitPaths).toEqual([deepPath(0)]);
        expect(blobPathsOf(entries)).toEqual(gitPaths);
      });
    });
  });

  describe('Given core.maxTreeDepth = 0 and a depth-1 tree', () => {
    describe('When ls-tree -r / walkTree are driven', () => {
      it('Then git exits 1 and walkTree throws TREE_DEPTH_EXCEEDED with depth 1', async () => {
        // Arrange
        setLocalMaxTreeDepth('0');

        // Act
        const g = tryRunGitWithExit([
          '-C',
          dir,
          '-c',
          'core.maxTreeDepth=0',
          'ls-tree',
          '-r',
          tree1,
        ]);

        // Assert
        expect(g.exitCode).toBe(1);
        await expectTreeDepthExceeded(() => drain(walkTree(ctx, tree1 as ObjectId)), 1);
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Pin 6 / P-7 — the published divergence: the same value in a throwaway
  // GIT_CONFIG_GLOBAL moves git's boundary; tsgit's stays unmoved, because
  // it reads local scope only. Runs last — it needs the local config clean.
  // ─────────────────────────────────────────────────────────────────────

  describe('Given core.maxTreeDepth = 3 in a global-only scope, no local override, and a D=6 tree', () => {
    describe('When ls-tree -r / walkTree are driven', () => {
      it('Then git exits 1 (global scope wins) but walkTree enumerates exactly the one deep blob (tsgit ignores global scope)', async () => {
        // Arrange
        clearLocalMaxTreeDepth();
        const globalConfigPath = path.join(dir, 'throwaway-global-config');
        writeFileSync(globalConfigPath, '[core]\n\tmaxTreeDepth = 3\n');
        const envWithGlobal: NodeJS.ProcessEnv = {
          ...runGitEnv(),
          GIT_CONFIG_GLOBAL: globalConfigPath,
        };

        // Act
        const g = tryRunGitWithExit(['-C', dir, 'ls-tree', '-r', tree6], { env: envWithGlobal });
        const entries = await drain(walkTree(ctx, tree6 as ObjectId));

        // Assert — git refuses here (exit 1), so there is no successful
        // stdout to cross-check; the exact blob path still pins that
        // walkTree reached the real leaf rather than yielding a wrong node
        // early.
        expect(g.exitCode).toBe(1);
        expect(blobPathsOf(entries)).toEqual([deepPath(6)]);
      });
    });
  });
});
