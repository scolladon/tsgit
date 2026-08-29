import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { joinPathSegment } from '../../../../src/application/primitives/internal/join-path-segment.js';
import { joinPath } from '../../../../src/application/primitives/internal/join-working-tree-path.js';
import type {
  WalkIgnorePredicate,
  WalkWorkingTreeEntry,
} from '../../../../src/application/primitives/types.js';
import { walkWorkingTree } from '../../../../src/application/primitives/walk-working-tree.js';
import { operationAborted } from '../../../../src/domain/error.js';
import { treeDepthExceeded, treeEntryLimitExceeded } from '../../../../src/domain/objects/error.js';
import type { FilePath } from '../../../../src/domain/objects/object-id.js';
import { isDotGitWalkEntry } from '../../../../src/domain/path/verify-path.js';
import { validateWalkedEntryPath } from '../../../../src/domain/working-tree-path.js';
import type { Context } from '../../../../src/ports/context.js';
import type { DirEntry, FileStat } from '../../../../src/ports/file-system.js';
import {
  type WorkingTreeIgnoreProfile,
  type WorkingTreeShape,
  type WorkingTreeShapeEntry,
  workingTreeIgnoreProfileArb,
  workingTreeShapeArb,
} from './arbitraries.js';

// ---------------------------------------------------------------------------
// Pre-rewrite recursive oracle for `walkWorkingTree`, copied verbatim from
// the implementation before this change's explicit-stack rewrite landed —
// never re-implemented, never paraphrased, and never the production code
// under test. `maxDepth`/`maxEntries` default to `Number.MAX_SAFE_INTEGER`
// rather than the production default (now a resolved `core.maxTreeDepth`):
// every call in this file supplies both explicitly, so neither default is
// ever exercised.
// ---------------------------------------------------------------------------

/**
 * Every fixture in this file comes from `createMemoryContext()`, which always
 * yields a work tree — the oracle mirrors production's `ctx.layout.workDir`
 * reads without re-deriving the walk algorithm itself.
 */
const workDirOf = (ctx: Context): string => ctx.layout.workDir as string;

interface WalkConfigOracle {
  readonly ctx: Context;
  readonly maxDepth: number;
  readonly maxEntries: number;
  readonly ignore: WalkIgnorePredicate | undefined;
}

interface CounterOracle {
  value: number;
}

interface WalkWorkingTreeOracleOptions {
  readonly maxDepth?: number;
  readonly maxEntries?: number;
  readonly ignore?: WalkIgnorePredicate;
}

async function* walkWorkingTreeOracle(
  ctx: Context,
  options?: WalkWorkingTreeOracleOptions,
): AsyncIterable<WalkWorkingTreeEntry> {
  const config: WalkConfigOracle = {
    ctx,
    maxDepth: options?.maxDepth ?? Number.MAX_SAFE_INTEGER,
    maxEntries: options?.maxEntries ?? Number.MAX_SAFE_INTEGER,
    ignore: options?.ignore,
  };
  const counter: CounterOracle = { value: 0 };
  yield* walkInternalOracle(config, counter, '', 0, /* isRoot */ true);
}

async function* walkInternalOracle(
  config: WalkConfigOracle,
  counter: CounterOracle,
  prefix: string,
  depth: number,
  isRoot: boolean,
): AsyncIterable<WalkWorkingTreeEntry> {
  if (depth > config.maxDepth) throw treeDepthExceeded(depth);
  const entries = await config.ctx.fs.readdir(directoryPathOracle(config, prefix));
  if (!isRoot && entries.some(isEmbeddedGitMarkerOracle)) return;
  for (const entry of entries) {
    if (config.ctx.signal?.aborted) throw operationAborted();
    if (isDotGitWalkEntry(entry.name)) continue;
    yield* visitEntryOracle(config, counter, prefix, depth, entry);
  }
}

async function* visitEntryOracle(
  config: WalkConfigOracle,
  counter: CounterOracle,
  prefix: string,
  depth: number,
  entry: DirEntry,
): AsyncIterable<WalkWorkingTreeEntry> {
  const path = joinPathSegment(prefix, entry.name) as FilePath;
  validateWalkedEntryPath(path);
  if (entry.isDirectory && !entry.isSymbolicLink) {
    if (config.ignore !== undefined && (await config.ignore(path, true))) return;
    yield* walkInternalOracle(config, counter, path, depth + 1, /* isRoot */ false);
    return;
  }
  if (!entry.isFile && !entry.isSymbolicLink) return;
  if (config.ignore !== undefined && (await config.ignore(path, false))) return;
  counter.value += 1;
  if (counter.value > config.maxEntries) {
    throw treeEntryLimitExceeded(counter.value, config.maxEntries);
  }
  yield {
    path,
    isFile: entry.isFile,
    isDirectory: entry.isDirectory,
    isSymbolicLink: entry.isSymbolicLink,
    stat: lazyStatOracle(config, path),
  };
}

const lazyStatOracle = (config: WalkConfigOracle, path: FilePath): (() => Promise<FileStat>) => {
  let memo: Promise<FileStat> | undefined;
  return () => {
    memo ??= config.ctx.fs.lstat(joinPath(workDirOf(config.ctx), path));
    return memo;
  };
};

const directoryPathOracle = (config: WalkConfigOracle, prefix: string): string => {
  const workDir = workDirOf(config.ctx);
  return prefix === '' ? workDir : joinPath(workDir, prefix);
};

const isEmbeddedGitMarkerOracle = (entry: DirEntry): boolean => {
  if (!isDotGitWalkEntry(entry.name)) return false;
  return entry.isDirectory || (entry.isFile && !entry.isSymbolicLink);
};

// ---------------------------------------------------------------------------
// Materialise a generated `WorkingTreeShape` into the memory adapter. Files,
// directories and symlink-to-directory leaves are written through the real
// `ctx.fs`; `.git` markers are plain files/directories named `.git`.
// `phantom` leaves (a non-file/dir/symlink entry — e.g. a socket or FIFO)
// cannot be produced by the memory adapter at all, so their sites are
// recorded and injected afterwards via a `readdir`-wrapping context shared
// by both the production walk and the oracle.
// ---------------------------------------------------------------------------

interface PhantomSite {
  readonly dirPath: string;
  readonly name: string;
}

async function materializeWorkingTreeEntries(
  ctx: Context,
  entries: ReadonlyArray<WorkingTreeShapeEntry>,
  dirPath: string,
  phantoms: PhantomSite[],
): Promise<void> {
  for (const entry of entries) {
    if (entry.kind === 'phantom') {
      phantoms.push({ dirPath, name: entry.name });
      continue;
    }
    const path = joinPathSegment(dirPath, entry.name);
    const absPath = `${ctx.layout.workDir}/${path}`;
    if (entry.kind === 'file') {
      await ctx.fs.writeUtf8(absPath, entry.content);
      continue;
    }
    if (entry.kind === 'symlinkToDir') {
      await ctx.fs.symlink('some-target', absPath);
      continue;
    }
    await ctx.fs.mkdir(absPath);
    await writeDotGitMarker(ctx, absPath, entry.dotGit);
    await materializeWorkingTreeEntries(ctx, entry.children, path, phantoms);
  }
}

async function writeDotGitMarker(
  ctx: Context,
  absDirPath: string,
  marker: 'none' | 'directory' | 'file',
): Promise<void> {
  if (marker === 'none') return;
  if (marker === 'directory') {
    await ctx.fs.writeUtf8(`${absDirPath}/.git/HEAD`, 'ref: refs/heads/main\n');
    return;
  }
  await ctx.fs.writeUtf8(`${absDirPath}/.git`, 'gitdir: /elsewhere\n');
}

function groupPhantomsByAbsoluteDir(
  workDir: string,
  phantoms: ReadonlyArray<PhantomSite>,
): ReadonlyMap<string, ReadonlyArray<string>> {
  const map = new Map<string, string[]>();
  for (const { dirPath, name } of phantoms) {
    const absDir = dirPath === '' ? workDir : `${workDir}/${dirPath}`;
    const list = map.get(absDir);
    if (list === undefined) {
      map.set(absDir, [name]);
      continue;
    }
    list.push(name);
  }
  return map;
}

/**
 * Materialise `shape` and return a context whose `readdir` also injects the
 * shape's `phantom` entries at their recorded directory — the SAME context
 * feeds both the production walk and the oracle, so both observe the
 * identical hostile listing.
 */
async function buildWorkingTreeShapeContext(shape: WorkingTreeShape): Promise<Context> {
  const ctx = createMemoryContext();
  await writeDotGitMarker(ctx, workDirOf(ctx), shape.rootDotGit);
  const phantoms: PhantomSite[] = [];
  await materializeWorkingTreeEntries(ctx, shape.entries, '', phantoms);
  const phantomsByDir = groupPhantomsByAbsoluteDir(workDirOf(ctx), phantoms);
  if (phantomsByDir.size === 0) return ctx;

  const baseReaddir = ctx.fs.readdir;
  return {
    ...ctx,
    fs: {
      ...ctx.fs,
      readdir: async (path: string): Promise<ReadonlyArray<DirEntry>> => {
        const real = await baseReaddir(path);
        const extra = phantomsByDir.get(path);
        if (extra === undefined) return real;
        return [
          ...real,
          ...extra.map(
            (name): DirEntry => ({
              name,
              isFile: false,
              isDirectory: false,
              isSymbolicLink: false,
            }),
          ),
        ];
      },
    },
  };
}

const buildIgnorePredicate = (profile: WorkingTreeIgnoreProfile): WalkIgnorePredicate => {
  return (path, isDirectory) => {
    const base = path.split('/').pop() ?? path;
    return isDirectory ? profile.ignoredDirNames.has(base) : profile.ignoredFileNames.has(base);
  };
};

type ComparableEntry = Pick<
  WalkWorkingTreeEntry,
  'path' | 'isFile' | 'isDirectory' | 'isSymbolicLink'
>;

// `stat` is a fresh per-walk closure on both sides — never structurally
// comparable — so only the fields identifying WHICH entry was yielded, and
// in what order, are collected. `stat`'s own correctness (memoisation, the
// shared-map short-circuit) is covered by the example tests.
const collect = async (iter: AsyncIterable<WalkWorkingTreeEntry>): Promise<ComparableEntry[]> => {
  const out: ComparableEntry[] = [];
  for await (const { path, isFile, isDirectory, isSymbolicLink } of iter) {
    out.push({ path, isFile, isDirectory, isSymbolicLink });
  }
  return out;
};

describe('walkWorkingTree properties', () => {
  describe('Given an arbitrary working-tree shape and ignore profile', () => {
    describe('When walked by the production (iterative) implementation', () => {
      it('Then it yields exactly the sequence the pre-rewrite recursive oracle yields', async () => {
        // Arrange + Act + Assert
        await fc.assert(
          fc.asyncProperty(
            workingTreeShapeArb(),
            workingTreeIgnoreProfileArb(),
            async (shape, ignoreProfile) => {
              const ctx = await buildWorkingTreeShapeContext(shape);
              const ignore = buildIgnorePredicate(ignoreProfile);
              const options = { maxDepth: 1000, maxEntries: 1_000_000, ignore };

              const iterative = await collect(walkWorkingTree(ctx, options));
              const recursive = await collect(walkWorkingTreeOracle(ctx, options));

              expect(iterative).toEqual(recursive);
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });
});
