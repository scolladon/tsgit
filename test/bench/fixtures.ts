/**
 * Benchmark fixtures. Builds synthetic repos under the OS tmpdir on first
 * import, then re-uses them for every `*.bench.ts` file in the same vitest run.
 *
 * We deliberately seed with the Node shim (not isomorphic-git) so the fixture
 * exercises our own loose-object storage, then both libraries read the same
 * resulting on-disk layout. That isolates the benchmark to read-path
 * performance rather than write-path differences.
 */
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { packPositionMap } from '../../src/application/primitives/internal/pack-positions.js';
import type { Blob, Commit, FileMode, ObjectId, Tree } from '../../src/domain/objects/index.js';
import { serializeObject } from '../../src/domain/objects/index.js';
import { parsePackIndex } from '../../src/domain/storage/index.js';
import { openRepository } from '../../src/index.node.js';
import type { Context } from '../../src/ports/context.js';
import {
  type EntrySpec,
  writeSyntheticBitmap,
  writeSyntheticPack,
  writeSyntheticRevIndex,
} from '../unit/application/primitives/pack-fixture.js';
import {
  type BitmapEntrySpec,
  type BitmapStreamSpec,
  buildBitmap,
} from '../unit/domain/storage/arbitraries.js';

export interface BenchRepo {
  readonly cwd: string;
  readonly headCommitId: string;
  readonly firstBlobId: string;
  readonly cleanup: () => Promise<void>;
}

const AUTHOR = {
  name: 'Bench',
  email: 'bench@tsgit.dev',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
} as const;

export const setupSmallRepo = async (opts: { commits?: number } = {}): Promise<BenchRepo> => {
  const commits = opts.commits ?? 50;
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'tsgit-bench-small-'));
  const repo = await openRepository({ cwd });

  let firstBlobId = '';
  let headCommitId = '';
  try {
    await repo.init();
    for (let i = 0; i < commits; i += 1) {
      const name = `f${i.toString().padStart(4, '0')}.txt`;
      await writeFile(path.join(cwd, name), `payload ${i}\n`);
      await repo.add([name]);
      const result = await repo.commit({
        message: `commit ${i}`,
        author: { ...AUTHOR, timestamp: AUTHOR.timestamp + i },
      });
      headCommitId = result.id;
      if (i === 0) {
        const tree = await repo.primitives.readTree(result.tree);
        const blobEntry = tree.entries.find((entry) => entry.name === name);
        if (blobEntry !== undefined) firstBlobId = blobEntry.id;
      }
    }
  } finally {
    await repo.dispose();
  }

  if (firstBlobId === '' || headCommitId === '') {
    throw new Error('benchmark fixture failed to capture seed ids');
  }

  return {
    cwd,
    headCommitId,
    firstBlobId,
    cleanup: () => rm(cwd, { recursive: true, force: true }),
  };
};

export const setupDirtyWorkingTree = async (
  base: BenchRepo,
  modifiedFiles: number,
): Promise<void> => {
  for (let i = 0; i < modifiedFiles; i += 1) {
    const name = `f${i.toString().padStart(4, '0')}.txt`;
    await writeFile(path.join(base.cwd, name), `payload ${i} dirty\n`);
  }
};

/**
 * Fixtures for the `.rev` accelerator bench (`buildOffsetTable`). Built
 * entirely with the domain's own pack writer (`writeSyntheticPack`) and
 * reverse-index writer (`writeSyntheticRevIndex`) against a disk-backed
 * `Context` — never `git` — so the fixture directory holds exactly the
 * bytes the accelerator reads, nothing a `git repack` heuristic chose.
 */

const OFFSET_TABLE_BLOB_BYTES = 24;

/** xorshift32 fill, keyed by index — deterministic, distinct-per-object content. */
const offsetTableBlobContent = (index: number): Uint8Array => {
  const buf = new Uint8Array(OFFSET_TABLE_BLOB_BYTES);
  let state = (index + 1) >>> 0;
  for (let i = 0; i < OFFSET_TABLE_BLOB_BYTES; i += 1) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    buf[i] = state & 0xff;
  }
  return buf;
};

const offsetTableBlobEntry = (contentIndex: number): EntrySpec => ({
  kind: 'base',
  type: 'blob',
  content: offsetTableBlobContent(contentIndex),
});

/** Writes a correct `.rev` sibling for `packName`, derived from its own just-written `.idx`. */
async function writeCorrectRevIndex(ctx: Context, packName: string): Promise<void> {
  const idxPath = `${ctx.layout.gitDir}/objects/pack/pack-${packName}.idx`;
  const idxBytes = await ctx.fs.read(idxPath);
  const body = packPositionMap(parsePackIndex(idxBytes, 20));
  await writeSyntheticRevIndex(ctx, packName, body);
}

export interface OffsetTablePackFixture {
  readonly cwd: string;
  readonly cleanup: () => Promise<void>;
}

/** Large enough that gathering the offset table in O(n) from a `.rev` is
 *  expected to beat sorting `entryOffsets` in O(n log n). */
export const MANY_OBJECT_COUNT = 3_000;

/**
 * A single pack holding `MANY_OBJECT_COUNT` blobs — the shape `buildOffsetTable`'s
 * O(n) `.rev` gather is expected to win on. `withRevIndex` toggles whether the
 * pack's `.rev` sibling is written at all, giving the gather/sort pair distinct
 * fixture directories rather than one mutated in place.
 */
export const setupManyObjectPackFixture = async (
  withRevIndex: boolean,
): Promise<OffsetTablePackFixture> => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'tsgit-bench-offset-table-many-object-'));
  const ctx = createNodeContext({ workDir: cwd, hooks: false, command: false, ssh: false });
  const packName = 'offset-table-many-object';
  const entries = Array.from({ length: MANY_OBJECT_COUNT }, (_unused, i) =>
    offsetTableBlobEntry(i),
  );
  const ids = await writeSyntheticPack(ctx, packName, entries);
  if (ids.length !== MANY_OBJECT_COUNT) {
    throw new Error(
      `offset-table fixture: built ${ids.length} objects, expected ${MANY_OBJECT_COUNT}`,
    );
  }
  if (withRevIndex) await writeCorrectRevIndex(ctx, packName);

  return { cwd, cleanup: () => rm(cwd, { recursive: true, force: true }) };
};

/** Pack count large enough that one extra `.rev` open+read per pack can
 *  outweigh sorting each pack's own (small) offset array. */
export const MANY_SMALL_PACK_COUNT = 64;
/** Objects per pack — small enough that sorting them is nearly free, so the
 *  fixed per-pack `.rev` I/O cost is what the comparison actually measures. */
export const MANY_SMALL_PACK_OBJECTS_PER_PACK = 4;

/**
 * Asserts, from the on-disk directory listing (never the build loop's own
 * counters), that exactly `MANY_SMALL_PACK_COUNT` distinct `.pack` files
 * landed under the pack directory — the "many" half of "many small packs".
 * The "small" half is asserted per-pack at build time, against each pack's
 * own `writeSyntheticPack` result.
 */
async function assertManyPackFiles(ctx: Context): Promise<void> {
  const packDir = `${ctx.layout.gitDir}/objects/pack`;
  const entries = await ctx.fs.readdir(packDir);
  const packFiles = entries.filter((entry) => entry.isFile && entry.name.endsWith('.pack'));
  if (packFiles.length !== MANY_SMALL_PACK_COUNT) {
    throw new Error(
      `offset-table fixture: found ${packFiles.length} .pack files, expected ${MANY_SMALL_PACK_COUNT}`,
    );
  }
}

/**
 * `MANY_SMALL_PACK_COUNT` independent packs, each holding
 * `MANY_SMALL_PACK_OBJECTS_PER_PACK` blobs — the shape where one extra
 * `open` + `read` per pack can turn the accelerator into a regression.
 * `withRevIndex` toggles whether EVERY pack gets a `.rev` sibling.
 */
export const setupManySmallPacksFixture = async (
  withRevIndex: boolean,
): Promise<OffsetTablePackFixture> => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'tsgit-bench-offset-table-small-packs-'));
  const ctx = createNodeContext({ workDir: cwd, hooks: false, command: false, ssh: false });

  for (let p = 0; p < MANY_SMALL_PACK_COUNT; p += 1) {
    const packName = `offset-table-small-${p}`;
    const entries = Array.from({ length: MANY_SMALL_PACK_OBJECTS_PER_PACK }, (_unused, k) =>
      offsetTableBlobEntry(p * MANY_SMALL_PACK_OBJECTS_PER_PACK + k),
    );
    const ids = await writeSyntheticPack(ctx, packName, entries);
    if (ids.length !== MANY_SMALL_PACK_OBJECTS_PER_PACK) {
      throw new Error(
        `offset-table fixture: pack ${packName} built ${ids.length} objects, expected ${MANY_SMALL_PACK_OBJECTS_PER_PACK}`,
      );
    }
    if (withRevIndex) await writeCorrectRevIndex(ctx, packName);
  }
  await assertManyPackFiles(ctx);

  return { cwd, cleanup: () => rm(cwd, { recursive: true, force: true }) };
};

// ---------------------------------------------------------------------------
// Bitmap-closure fixture: revList()'s walk default versus packObjects()'s
// bitmap default, over the same bitmap-covered repository. Built entirely
// with writeSyntheticPack + the domain's own buildBitmap/encodeEwah writers
// (via buildBitmap) — never git.
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

async function objectId(ctx: Context, object: Blob | Tree | Commit): Promise<string> {
  return ctx.hash.hashHex(serializeObject(object, ctx.hashConfig));
}

/** Strips the `<type> <size>\0` header `EntrySpec.content` never carries. */
function withoutObjectHeader(ctx: Context, object: Blob | Tree | Commit): Uint8Array {
  const full = serializeObject(object, ctx.hashConfig);
  const nul = full.indexOf(0);
  return full.subarray(nul + 1);
}

interface LinearChain {
  readonly entries: ReadonlyArray<EntrySpec>;
  /** One id per generation, oldest first — the last entry is the chain's HEAD. */
  readonly commitIds: ReadonlyArray<string>;
}

/**
 * A linear chain of `length` generations, each contributing one blob, one
 * tree and one commit — pack position `3*i`/`3*i+1`/`3*i+2` for generation
 * `i`, since `writeSyntheticPack` assigns pack position by insertion order
 * and every entry here is a base entry (offsets strictly increase).
 */
async function buildLinearChain(ctx: Context, length: number): Promise<LinearChain> {
  const entries: EntrySpec[] = [];
  const commitIds: string[] = [];
  let parent: string | undefined;

  for (let i = 0; i < length; i += 1) {
    const blob: Blob = {
      type: 'blob',
      id: '' as ObjectId,
      content: enc.encode(`closure-bench-${i}`),
    };
    const blobId = await objectId(ctx, blob);
    entries.push({ kind: 'base', type: 'blob', content: withoutObjectHeader(ctx, blob) });

    const tree: Tree = {
      type: 'tree',
      id: '' as ObjectId,
      entries: [{ name: 'f.txt', mode: '100644' as FileMode, id: blobId as ObjectId }],
    };
    const treeId = await objectId(ctx, tree);
    entries.push({ kind: 'base', type: 'tree', content: withoutObjectHeader(ctx, tree) });

    const commit: Commit = {
      type: 'commit',
      id: '' as ObjectId,
      data: {
        tree: treeId as ObjectId,
        parents: parent === undefined ? [] : [parent as ObjectId],
        author: AUTHOR,
        committer: AUTHOR,
        message: `closure-bench-${i}`,
        extraHeaders: [],
      },
    };
    const commitId = await objectId(ctx, commit);
    entries.push({ kind: 'base', type: 'commit', content: withoutObjectHeader(ctx, commit) });
    commitIds.push(commitId);

    parent = commitId;
  }

  return { entries, commitIds };
}

/** SHA-sorted rank among `ids` — the INDEX position a bitmap entry header addresses. */
function indexPositionOf(ids: ReadonlyArray<string>, id: string): number {
  return [...ids].sort().indexOf(id);
}

/** Chain-position layout for `length` generations: blob/tree/commit at `3*i`/`3*i+1`/`3*i+2`. */
function chainPackPositions(length: number): {
  readonly blobs: ReadonlyArray<number>;
  readonly trees: ReadonlyArray<number>;
  readonly commits: ReadonlyArray<number>;
} {
  const blobs: number[] = [];
  const trees: number[] = [];
  const commits: number[] = [];
  for (let i = 0; i < length; i += 1) {
    blobs.push(3 * i);
    trees.push(3 * i + 1);
    commits.push(3 * i + 2);
  }
  return { blobs, trees, commits };
}

function chainTypeStreams(
  objectCount: number,
  positions: ReturnType<typeof chainPackPositions>,
): readonly [BitmapStreamSpec, BitmapStreamSpec, BitmapStreamSpec, BitmapStreamSpec] {
  const stream = (bits: ReadonlyArray<number>): BitmapStreamSpec => ({
    bitSize: objectCount,
    bits,
  });
  return [stream(positions.commits), stream(positions.trees), stream(positions.blobs), stream([])];
}

/**
 * One entry per commit, XOR-chained against the previous entry (`xorOffset:
 * 1`, except entry 0): entry `i`'s stored bits are generation `i`'s own
 * blob/tree/commit pack positions, so `resolved[i] = stored[i] XOR
 * resolved[i-1]` accumulates every prior generation too — exactly the
 * closure the chain's HEAD commit reaches.
 */
function chainBitmapEntries(
  commitIds: ReadonlyArray<string>,
  objectCount: number,
  idxOf: (id: string) => number,
): BitmapEntrySpec[] {
  return commitIds.map((commitId, i) => ({
    position: idxOf(commitId),
    xorOffset: i === 0 ? 0 : 1,
    flags: 0,
    bitSize: objectCount,
    bits: [3 * i, 3 * i + 1, 3 * i + 2],
  }));
}

const packBitmapPath = (ctx: Context, name: string): string =>
  `${ctx.layout.gitDir}/objects/pack/pack-${name}.bitmap`;

async function writeHealthyChainBitmap(
  ctx: Context,
  packName: string,
  chain: LinearChain,
  ids: ReadonlyArray<string>,
): Promise<void> {
  const objectCount = ids.length;
  const idxOf = (id: string): number => indexPositionOf(ids, id);
  const positions = chainPackPositions(chain.commitIds.length);
  const body = buildBitmap({
    optionFlags: 1,
    digestLength: ctx.hashConfig.digestLength,
    checksum: new Uint8Array(ctx.hashConfig.digestLength).fill(0xbb),
    typeStreams: chainTypeStreams(objectCount, positions),
    entries: chainBitmapEntries(chain.commitIds, objectCount, idxOf),
    trailingBytes: 0,
  });
  await writeSyntheticBitmap(ctx, packBitmapPath(ctx, packName), body);
}

export interface BitmapClosureFixture {
  readonly cwd: string;
  readonly headCommitId: string;
  readonly cleanup: () => Promise<void>;
}

const CLOSURE_PACK_NAME = 'bitmap-closure';

/**
 * A linear `commits`-generation history, packed and covered by a healthy
 * XOR-chained bitmap over its HEAD — the shape `revList`/`packObjects`'
 * bitmap tier answers from. `.git` is initialised through `openRepository`
 * first (both closure commands require an operational repository); the
 * pack and bitmap are then written directly to that same on-disk layout
 * via a raw `Context` — never through a real commit, and never through
 * `git`.
 */
export const setupBitmapClosureFixture = async (commits: number): Promise<BitmapClosureFixture> => {
  // Canonicalised up front: `openRepository` realpaths `cwd` internally
  // (macOS routes `os.tmpdir()` through a `/var` → `/private/var` symlink),
  // and this fixture hands its `cwd` back out for a caller to build a
  // second absolute path from (`packObjects`' `outputDirectory`) — that
  // path must already agree with the realpath'd root the repository's own
  // containment guard checks against.
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-bench-bitmap-closure-')));
  const bootstrap = await openRepository({ cwd });
  await bootstrap.init();
  await bootstrap.dispose();

  const ctx = createNodeContext({ workDir: cwd, hooks: false, command: false, ssh: false });
  const chain = await buildLinearChain(ctx, commits);
  const ids = await writeSyntheticPack(ctx, CLOSURE_PACK_NAME, chain.entries);
  await writeHealthyChainBitmap(ctx, CLOSURE_PACK_NAME, chain, ids);

  const headCommitId = chain.commitIds[chain.commitIds.length - 1];
  if (headCommitId === undefined) {
    throw new Error('bitmap-closure fixture: chain produced no commits');
  }

  return { cwd, headCommitId, cleanup: () => rm(cwd, { recursive: true, force: true }) };
};

// ---------------------------------------------------------------------------
// fsck-artefact-hashing fixture: the accelerator bench's own many-object
// pack, optionally carrying a `.rev` and a `.bitmap` sibling.
// ---------------------------------------------------------------------------

export interface FsckArtefactFixture {
  readonly cwd: string;
  readonly cleanup: () => Promise<void>;
}

const FSCK_ARTEFACT_PACK_NAME = 'fsck-artefacts';

/**
 * `runBitmapHealthPass` verifies a bitmap by its own trailing digest alone
 * — no header parse, no stream walk (see `bitmap-health.ts`) — so a bitmap
 * with empty type-streams and no entries is exactly as "healthy" as a
 * fully-populated one for THIS fixture's purpose, at a fraction of the
 * build cost.
 */
async function writeMinimalHealthyBitmap(
  ctx: Context,
  packName: string,
  objectCount: number,
): Promise<void> {
  const emptyStream: BitmapStreamSpec = { bitSize: objectCount, bits: [] };
  const body = buildBitmap({
    optionFlags: 1,
    digestLength: ctx.hashConfig.digestLength,
    checksum: new Uint8Array(ctx.hashConfig.digestLength).fill(0xbb),
    typeStreams: [emptyStream, emptyStream, emptyStream, emptyStream],
    entries: [],
    trailingBytes: 0,
  });
  await writeSyntheticBitmap(ctx, packBitmapPath(ctx, packName), body);
}

/**
 * The accelerator bench's own many-object pack (`offsetTableBlobEntry`,
 * `MANY_OBJECT_COUNT`), optionally carrying a `.rev` and a `.bitmap`
 * sibling — the shape `fsck`'s reverse-index and bitmap health passes
 * (`runRevIndexHealthPass`/`runBitmapHealthPass`) price against a pack
 * carrying neither.
 */
export const setupFsckArtefactFixture = async (
  withArtefacts: boolean,
): Promise<FsckArtefactFixture> => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'tsgit-bench-fsck-artefacts-'));
  const bootstrap = await openRepository({ cwd });
  await bootstrap.init();
  await bootstrap.dispose();

  const ctx = createNodeContext({ workDir: cwd, hooks: false, command: false, ssh: false });
  const entries = Array.from({ length: MANY_OBJECT_COUNT }, (_unused, i) =>
    offsetTableBlobEntry(i),
  );
  const ids = await writeSyntheticPack(ctx, FSCK_ARTEFACT_PACK_NAME, entries);
  if (ids.length !== MANY_OBJECT_COUNT) {
    throw new Error(
      `fsck-artefact fixture: built ${ids.length} objects, expected ${MANY_OBJECT_COUNT}`,
    );
  }

  if (withArtefacts) {
    await writeCorrectRevIndex(ctx, FSCK_ARTEFACT_PACK_NAME);
    await writeMinimalHealthyBitmap(ctx, FSCK_ARTEFACT_PACK_NAME, ids.length);
  }

  return { cwd, cleanup: () => rm(cwd, { recursive: true, force: true }) };
};
