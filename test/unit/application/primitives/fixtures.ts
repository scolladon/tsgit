/**
 * Shared test fixtures for primitives —.
 */
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { invalidateConfigCache } from '../../../../src/application/primitives/config-read.js';
import {
  commitGraphChainPath,
  commitGraphPath,
} from '../../../../src/application/primitives/path-layout.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import type { GitIndex } from '../../../../src/domain/git-index/index-entry.js';
import { serializeIndex } from '../../../../src/domain/git-index/index-writer.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import { serializeObject } from '../../../../src/domain/objects/git-object.js';
import type {
  Commit,
  FileMode,
  FilePath,
  GitObject,
  ObjectId,
  ObjectType,
  RefName,
} from '../../../../src/domain/objects/index.js';
import { serializeHeader } from '../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
import { type PackedRefEntry, serializePackedRefs } from '../../../../src/domain/refs/index.js';
import { computeLooseObjectPath } from '../../../../src/domain/storage/loose-path.js';
import type { Context } from '../../../../src/ports/context.js';
import type { DirEntry, FileStat, FileSystem } from '../../../../src/ports/file-system.js';
import {
  buildCommitGraphBytes,
  type CommitGraphCommitModel,
  type CommitGraphLayerModel,
} from '../../domain/commit/arbitraries.js';

/**
 * Write `core.maxTreeDepth = <value>` to `ctx`'s `.git/config` and invalidate
 * the per-`Context` config cache so a subsequent read observes it. `value` is
 * the raw config string (not a number) so callers can seed malformed grammar
 * (`'2.5'`, `''`, etc.) alongside valid values.
 */
export const seedMaxTreeDepth = async (ctx: Context, value: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, `[core]\n\tmaxTreeDepth = ${value}\n`);
  invalidateConfigCache(ctx);
};

/** A path with exactly `slashes` slashes: `d0/d1/…/d{slashes}`. */
export const deepIndexPath = (slashes: number): string =>
  Array.from({ length: slashes + 1 }, (_unused, i) => `d${i}`).join('/');

/**
 * Fixed leaf content `buildTreeChain` writes at the bottom of its chain. A
 * caller that wants to compare `buildTreeChain`'s output against an
 * independently-synthesised tree for the same depth (e.g. a
 * `synthesizeTreeFromIndex`/`writeNestedTree` round-trip) writes a blob with
 * this SAME content — content-addressing then makes the two blob ids equal
 * regardless of which writer produced them, without threading an id across
 * the two call sites.
 */
export const DEEP_CHAIN_LEAF_CONTENT = 'deep-chain-leaf';

/**
 * Build a `depth`-level nested tree chain: one leaf blob at the bottom,
 * wrapped in `depth` levels of single-entry directory trees named
 * `d0`..`d{depth}` — the exact shape `synthesizeTreeFromIndex` and
 * `writeNestedTree` produce for a single entry at `deepIndexPath(depth)`.
 * `depth` follows the same slash-count convention as `deepIndexPath` and
 * `seedMaxTreeDepth`'s callers. Returns the root tree's `ObjectId`.
 */
export async function buildTreeChain(ctx: Context, depth: number): Promise<ObjectId> {
  const leafId = await writeObject(ctx, {
    type: 'blob',
    content: new TextEncoder().encode(DEEP_CHAIN_LEAF_CONTENT),
    id: '' as ObjectId,
  });
  let childId: ObjectId = leafId;
  let childMode: FileMode = FILE_MODE.REGULAR;
  for (let segment = depth; segment >= 0; segment -= 1) {
    childId = await writeTree(ctx, [treeEntry(childMode, `d${segment}` as FilePath, childId)]);
    childMode = FILE_MODE.DIRECTORY;
  }
  return childId;
}

/**
 * Create `depth` nested directories under `ctx.layout.workDir` in the
 * **memory** adapter, with one leaf file (`leaf`) at the bottom. Every
 * level reuses the SAME single-character directory name (`a`) — the chain
 * has no siblings, so no name collision is possible, and a 1-byte segment
 * maximises how deep a fixture can go before `validateWalkedEntryPath`'s own
 * 4096-byte total-path cap (independent of `core.maxTreeDepth`) becomes the
 * binding constraint rather than the depth guard under test.
 * `createMemoryContext()` has no path-length limit, so the same fixture runs
 * identically on linux, macOS and Windows — a real on-disk deep checkout
 * would fail with `File name too long` long before reaching a realistic
 * `core.maxTreeDepth`. `depth` follows `walkWorkingTree`'s own counter: the
 * deepest directory frame the walker enters is checked against the depth
 * guard at exactly this value.
 */
export async function seedDeepWorkingTree(ctx: Context, depth: number): Promise<void> {
  const chain = Array.from({ length: depth }, () => 'a').join('/');
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${chain}/leaf`, 'leaf');
}

/**
 * Like {@link seedDeepWorkingTree}, but the deepest directory is left EMPTY
 * (no leaf file). Even a single-character leaf name pushes a `depth`-2048
 * chain's leaf path one byte past `validateWalkedEntryPath`'s 4096-byte
 * total-path cap, so a fixture probing right at that boundary must stop one
 * segment short of a leaf.
 */
export async function seedDeepEmptyWorkingTree(ctx: Context, depth: number): Promise<void> {
  const chain = Array.from({ length: depth }, () => 'a').join('/');
  await ctx.fs.mkdir(`${ctx.layout.workDir}/${chain}`);
}

/**
 * Like {@link seedDeepEmptyWorkingTree}, but plants one 1-character leaf
 * file one level short of the bottom instead of leaving the whole chain
 * empty — a positive oracle for "the walk actually descended" rather than
 * merely "didn't throw". The deepest directory (`depth`) stays empty, so
 * the boundary {@link seedDeepEmptyWorkingTree} probes (walking exactly to
 * `depth` without throwing) is unchanged; the leaf sits one level up, at
 * `depth - 1`.
 *
 * No leaf fits any deeper: a 1-character leaf inside the `depth`-th
 * directory would be `2*depth + 1` bytes, one byte past
 * `validateWalkedEntryPath`'s 4096-byte total-path cap (independent of
 * `core.maxTreeDepth`); the same leaf one level up, inside the
 * `(depth - 1)`-th directory, is `2*depth - 1` bytes — safely under it.
 * Returns the leaf's repo-relative path.
 */
export async function seedDeepWorkingTreeWithNearBottomLeaf(
  ctx: Context,
  depth: number,
): Promise<string> {
  const leafParent = Array.from({ length: depth - 1 }, () => 'a').join('/');
  const leafPath = `${leafParent}/x`;
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${leafPath}`, 'leaf');
  const chain = Array.from({ length: depth }, () => 'a').join('/');
  await ctx.fs.mkdir(`${ctx.layout.workDir}/${chain}`);
  return leafPath;
}

export interface BuildSeededContextParts {
  readonly objects?: ReadonlyArray<GitObject>;
  readonly refs?: ReadonlyArray<{ readonly name: RefName; readonly id: ObjectId }>;
  readonly packedRefs?: ReadonlyArray<PackedRefEntry>;
  readonly index?: GitIndex;
  readonly signal?: AbortSignal;
  /** Repository hash algorithm; defaults to `createMemoryContext`'s own default (sha1). */
  readonly algorithm?: 'sha1' | 'sha256';
}

export async function buildSeededContext(parts: BuildSeededContextParts = {}): Promise<Context> {
  const ctx = createMemoryContext({
    ...(parts.signal !== undefined ? { signal: parts.signal } : {}),
    ...(parts.algorithm !== undefined ? { algorithm: parts.algorithm } : {}),
  });
  const { gitDir } = ctx.layout;

  // Seed objects
  for (const object of parts.objects ?? []) {
    const bytes = serializeObject(object, ctx.hashConfig);
    const id = (await ctx.hash.hashHex(bytes)) as ObjectId;
    const loosePath = `${gitDir}/objects/${computeLooseObjectPath(id)}`;
    const compressed = await ctx.compressor.deflate(bytes);
    await ctx.fs.write(loosePath, compressed);
  }

  // Seed loose refs
  for (const ref of parts.refs ?? []) {
    await ctx.fs.writeUtf8(`${gitDir}/${ref.name}`, `${ref.id}\n`);
  }

  // Seed packed-refs
  if (parts.packedRefs !== undefined && parts.packedRefs.length > 0) {
    const serialized = serializePackedRefs({
      entries: parts.packedRefs,
      peeling: 'none',
      sorted: false,
    });
    await ctx.fs.writeUtf8(`${gitDir}/packed-refs`, serialized);
  }

  // Seed index (with SHA1 trailer so parseIndex accepts it).
  if (parts.index !== undefined) {
    const indexBytes = await serializeIndexFixtureAsync(parts.index, ctx);
    await ctx.fs.write(`${gitDir}/index`, indexBytes);
  }

  return ctx;
}

/**
 * Write hand-built object *content* bytes as a loose object, bypassing every
 * domain serializer (`serializeObject`/`serializeTreeContent`). Used to plant
 * tree bodies whose entry order or entry names a canonicalising writer
 * (`writeTree`/`writeObject`) would never produce on disk — e.g. an unsorted
 * or invalid-name tree — so a raw reader observes the exact bytes a
 * corrupt/adversarial repository could contain.
 */
export async function writeRawObjectBytes(
  ctx: Context,
  type: ObjectType,
  content: Uint8Array,
): Promise<ObjectId> {
  const header = serializeHeader(type, content.length);
  const bytes = new Uint8Array(header.length + content.length);
  bytes.set(header, 0);
  bytes.set(content, header.length);
  const id = (await ctx.hash.hashHex(bytes)) as ObjectId;
  const loosePath = `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(id)}`;
  const compressed = await ctx.compressor.deflate(bytes);
  await ctx.fs.write(loosePath, compressed);
  return id;
}

/**
 * No-dereference audit helper: a context whose `ctx.fs.read` throws if ever called with
 * `symlinkPath` — the no-dereference discipline made a hard failure instead
 * of a passive spy assertion.
 */
export const refuseReadOnSymlink = (base: Context, symlinkPath: string): Context => ({
  ...base,
  fs: {
    ...base.fs,
    read: async (p: string): Promise<Uint8Array> => {
      if (p === symlinkPath)
        throw new Error(`no-dereference violation: ctx.fs.read called on ${p}`);
      return base.fs.read(p);
    },
  },
});

/**
 * Instrument a Context by wrapping its fs with call-tracking. Returns the wrapped
 * context and a `calls()` accessor that returns the ordered list of fs operations.
 */
export interface InstrumentedContext {
  readonly ctx: Context;
  readonly calls: () => ReadonlyArray<{ readonly method: string; readonly path: string }>;
}

export function instrumentedContext(base: Context): InstrumentedContext {
  const log: Array<{ method: string; path: string }> = [];
  const record = (method: string, path: string): void => {
    log.push({ method, path });
  };

  const wrappedFs: FileSystem = {
    read: async (p) => {
      record('read', p);
      return base.fs.read(p);
    },
    readSlice: async (p, o, l) => {
      record('readSlice', p);
      return base.fs.readSlice(p, o, l);
    },
    readUtf8: async (p) => {
      record('readUtf8', p);
      return base.fs.readUtf8(p);
    },
    write: async (p, d) => {
      record('write', p);
      return base.fs.write(p, d);
    },
    writeStream: async (p, source) => {
      record('writeStream', p);
      return base.fs.writeStream(p, source);
    },
    writeExclusive: async (p, d) => {
      record('writeExclusive', p);
      return base.fs.writeExclusive(p, d);
    },
    writeUtf8: async (p, c) => {
      record('writeUtf8', p);
      return base.fs.writeUtf8(p, c);
    },
    appendUtf8: async (p, c) => {
      record('appendUtf8', p);
      return base.fs.appendUtf8(p, c);
    },
    exists: async (p) => {
      record('exists', p);
      return base.fs.exists(p);
    },
    stat: async (p): Promise<FileStat> => {
      record('stat', p);
      return base.fs.stat(p);
    },
    lstat: async (p): Promise<FileStat> => {
      record('lstat', p);
      return base.fs.lstat(p);
    },
    readdir: async (p): Promise<ReadonlyArray<DirEntry>> => {
      record('readdir', p);
      return base.fs.readdir(p);
    },
    mkdir: async (p) => {
      record('mkdir', p);
      return base.fs.mkdir(p);
    },
    rm: async (p) => {
      record('rm', p);
      return base.fs.rm(p);
    },
    rename: async (s, d) => {
      record('rename', `${s}->${d}`);
      return base.fs.rename(s, d);
    },
    readlink: async (p) => {
      record('readlink', p);
      return base.fs.readlink(p);
    },
    symlink: async (t, p) => {
      record('symlink', p);
      return base.fs.symlink(t, p);
    },
    chmod: async (p, m) => {
      record('chmod', p);
      return base.fs.chmod(p, m);
    },
    rmRecursive: async (p) => {
      record('rmRecursive', p);
      return base.fs.rmRecursive(p);
    },
    openWithNoFollow: async (p, m) => {
      record('openWithNoFollow', p);
      return base.fs.openWithNoFollow(p, m);
    },
    homedir: () => base.fs.homedir(),
    xdgConfigHome: () => base.fs.xdgConfigHome(),
    systemConfigPath: () => base.fs.systemConfigPath(),
  };

  const ctx: Context = {
    ...base,
    fs: wrappedFs,
  };
  return {
    ctx,
    calls: () => log.slice(),
  };
}

/**
 * Serialize a GitIndex through's serializeIndex, producing bytes
 * suitable for `ctx.fs.write('.git/index',...)`. readIndex tests
 * use this to round-trip without needing a writeIndex primitive.
 */
/**
 * Serialize a GitIndex with a trailing SHA1 checksum so that parseIndex
 * accepts the round-trip.'s `serializeIndex` omits the trailer;
 * this fixture adds it for readIndex tests.
 */
export async function serializeIndexFixtureAsync(
  index: GitIndex,
  ctx: Context,
): Promise<Uint8Array> {
  const body = serializeIndex(index, ctx.hashConfig.digestLength);
  const hex = await ctx.hash.hashHex(body);
  const trailer = new Uint8Array(20);
  for (let i = 0; i < 20; i += 1) {
    trailer[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  const out = new Uint8Array(body.length + 20);
  out.set(body, 0);
  out.set(trailer, body.length);
  return out;
}

/**
 * Synchronous alias returning only the body (no trailer). Exposed for step 1
 * self-test which only checks size-shape, not parse round-trip.
 */
export function serializeIndexFixture(index: GitIndex): Uint8Array {
  return serializeIndex(index, 20);
}

const byOidAscending = (a: Commit, b: Commit): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function layerModelFor(
  sorted: ReadonlyArray<Commit>,
  positionOf: ReadonlyMap<ObjectId, number>,
  baseGraphHashes: ReadonlyArray<ObjectId>,
): CommitGraphLayerModel {
  const commits: CommitGraphCommitModel[] = sorted.map((commit) => ({
    oid: commit.id,
    rootTree: commit.data.tree,
    parentPositions: commit.data.parents.map((parent) => positionOf.get(parent)!),
    generationV1: 1,
    committerDate: commit.data.committer.timestamp,
    generationV2Offset: 0,
  }));
  return {
    hashVersion: 1,
    numBaseGraphs: baseGraphHashes.length,
    baseGraphHashes,
    includeGenerationData: true,
    commits,
  };
}

/**
 * Write a real `commit-graph` (single-file, `layers.length === 1`) or chain
 * (`layers.length > 1`, base → tip) encoding the given REAL commits (Pin D
 * format, via the domain parser's own test encoder). Each layer is sorted by
 * oid — the on-disk fanout/OIDL requirement — and parent references are
 * resolved to GLOBAL positions across the concatenated layer ordering, the
 * same arithmetic `read-commit-graph.ts` decodes.
 */
export async function writeCommitGraph(
  ctx: Context,
  layers: ReadonlyArray<ReadonlyArray<Commit>>,
): Promise<void> {
  const gitDir = ctx.layout.gitDir;
  const positionOf = new Map<ObjectId, number>();
  let cumulative = 0;
  const sortedLayers = layers.map((layerCommits) => {
    const sorted = [...layerCommits].sort(byOidAscending);
    sorted.forEach((commit, i) => {
      positionOf.set(commit.id, cumulative + i);
    });
    cumulative += sorted.length;
    return sorted;
  });

  if (sortedLayers.length === 1) {
    const bytes = buildCommitGraphBytes(layerModelFor(sortedLayers[0]!, positionOf, []));
    await ctx.fs.write(commitGraphPath(gitDir), bytes);
    return;
  }

  const hashes: ObjectId[] = [];
  for (const sorted of sortedLayers) {
    const baseGraphHashes = hashes.length > 0 ? [hashes[hashes.length - 1]!] : [];
    const bytes = buildCommitGraphBytes(layerModelFor(sorted, positionOf, baseGraphHashes));
    const hash = (await ctx.hash.hashHex(bytes)) as ObjectId;
    hashes.push(hash);
    await ctx.fs.write(`${gitDir}/objects/info/commit-graphs/graph-${hash}.graph`, bytes);
  }
  await ctx.fs.writeUtf8(commitGraphChainPath(gitDir), `${hashes.join('\n')}\n`);
}
