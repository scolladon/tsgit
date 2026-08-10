/**
 * Unit tests for the pack-bitmap closure binding — position mapping, XOR
 * reconstruction, range validation and its whole-artefact decline, and
 * degradation to "undefined" (the caller's signal to fall back to the walk).
 *
 * Fixtures are hand-assembled: a real synthetic pack (`writeSyntheticPack`)
 * carrying real commit/tree/blob objects, alongside a hand-crafted `.bitmap`
 * (`buildBitmap`/`encodeEwah`) whose entries this suite fully controls. A
 * bit is a PACK position — insertion order into `writeSyntheticPack`, since
 * every entry here is a base entry and offsets strictly increase — and an
 * entry header's `position` is an INDEX position, the SHA-sorted rank among
 * every id the pack carries.
 */
import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { runBitmapHealthPass } from '../../../../../src/application/commands/internal/fsck/bitmap-health.js';
import {
  type LoadedPackBitmap,
  resolveBitmapClosure,
} from '../../../../../src/application/primitives/internal/bitmap-binding.js';
import { computeClosure } from '../../../../../src/application/primitives/internal/closure-engine.js';
import {
  type LoadedMidxBitmap,
  loadMidxBitmapArtefact,
} from '../../../../../src/application/primitives/internal/midx-bitmap-binding.js';
import { loadPackBitmapArtefact } from '../../../../../src/application/primitives/internal/pack-bitmap-binding.js';
import { packPositionMap } from '../../../../../src/application/primitives/internal/pack-positions.js';
import { getPackRegistry } from '../../../../../src/application/primitives/read-object.js';
import { permissionDenied } from '../../../../../src/domain/error.js';
import type {
  AuthorIdentity,
  Blob,
  Commit,
  FileMode,
  GitObject,
  ObjectId,
  Tree,
} from '../../../../../src/domain/objects/index.js';
import { serializeObject } from '../../../../../src/domain/objects/index.js';
import {
  lookupPackIndex,
  midxOidAt,
  midxReverseIndexAt,
  parseMultiPackIndex,
  parsePackIndex,
} from '../../../../../src/domain/storage/index.js';
import { allObjectIds } from '../../../../../src/domain/storage/pack-index.js';
import type { Context } from '../../../../../src/ports/context.js';
import {
  type BitmapEntrySpec,
  type BitmapSpec,
  type BitmapStreamSpec,
  buildBitmap,
  buildMidx,
  type MidxSpec,
} from '../../../domain/storage/arbitraries.js';
import {
  type EntrySpec,
  writeSyntheticBitmap,
  writeSyntheticPack,
  writeSyntheticRevIndex,
} from '../pack-fixture.js';

const AUTHOR: AuthorIdentity = {
  name: 'A',
  email: 'a@a',
  timestamp: 0,
  timezoneOffset: '+0000',
};

const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// Fixture construction
// ---------------------------------------------------------------------------

function stripHeader(bytes: Uint8Array): Uint8Array {
  const nul = bytes.indexOf(0);
  return bytes.subarray(nul + 1);
}

async function idOf(ctx: Context, object: GitObject): Promise<string> {
  return ctx.hash.hashHex(serializeObject(object, ctx.hashConfig));
}

function rawContentOf(ctx: Context, object: GitObject): Uint8Array {
  return stripHeader(serializeObject(object, ctx.hashConfig));
}

interface ChainFixture {
  readonly entries: ReadonlyArray<EntrySpec>;
  readonly blobIds: ReadonlyArray<string>;
  readonly treeIds: ReadonlyArray<string>;
  readonly commitIds: ReadonlyArray<string>;
}

/**
 * A linear chain of `length` generations, each contributing one blob, one
 * tree and one commit, in that order — pack position `3*i`/`3*i+1`/`3*i+2`
 * for generation `i`'s blob/tree/commit, since `writeSyntheticPack` assigns
 * pack position by insertion order (every entry here is a base entry, so
 * offsets strictly increase).
 */
async function buildChain(ctx: Context, length: number, prefix = 'gen'): Promise<ChainFixture> {
  const entries: EntrySpec[] = [];
  const blobIds: string[] = [];
  const treeIds: string[] = [];
  const commitIds: string[] = [];
  let parent: string | undefined;

  for (let i = 0; i < length; i += 1) {
    const blob: Blob = { type: 'blob', id: '' as ObjectId, content: enc.encode(`${prefix}-${i}`) };
    const blobId = await idOf(ctx, blob);
    entries.push({ kind: 'base', type: 'blob', content: rawContentOf(ctx, blob) });
    blobIds.push(blobId);

    const tree: Tree = {
      type: 'tree',
      id: '' as ObjectId,
      entries: [{ name: 'f.txt', mode: '100644' as FileMode, id: blobId as ObjectId }],
    };
    const treeId = await idOf(ctx, tree);
    entries.push({ kind: 'base', type: 'tree', content: rawContentOf(ctx, tree) });
    treeIds.push(treeId);

    const commit: Commit = {
      type: 'commit',
      id: '' as ObjectId,
      data: {
        tree: treeId as ObjectId,
        parents: parent === undefined ? [] : [parent as ObjectId],
        author: AUTHOR,
        committer: AUTHOR,
        message: `${prefix}-${i}`,
        extraHeaders: [],
      },
    };
    const commitId = await idOf(ctx, commit);
    entries.push({ kind: 'base', type: 'commit', content: rawContentOf(ctx, commit) });
    commitIds.push(commitId);

    parent = commitId;
  }

  return { entries, blobIds, treeIds, commitIds };
}

function indexPositionOf(ids: ReadonlyArray<string>, id: string): number {
  return [...ids].sort().indexOf(id);
}

function asOids(ids: ReadonlyArray<string>): ObjectId[] {
  return ids.map((id) => id as ObjectId);
}

const packDir = (ctx: Context): string => `${ctx.layout.gitDir}/objects/pack`;
const packBitmapPath = (ctx: Context, name: string): string =>
  `${packDir(ctx)}/pack-${name}.bitmap`;
const packIdxPath = (ctx: Context, name: string): string => `${packDir(ctx)}/pack-${name}.idx`;

/** Chain-position layout for `length` generations: blob/tree/commit at
 *  `3*i`/`3*i+1`/`3*i+2`. */
function chainPositions(length: number): {
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

function typeStreamsFor(
  objectCount: number,
  opts: {
    readonly commits?: ReadonlyArray<number>;
    readonly trees?: ReadonlyArray<number>;
    readonly blobs?: ReadonlyArray<number>;
    readonly tags?: ReadonlyArray<number>;
  },
): readonly [BitmapStreamSpec, BitmapStreamSpec, BitmapStreamSpec, BitmapStreamSpec] {
  const stream = (bits: ReadonlyArray<number> | undefined): BitmapStreamSpec => ({
    bitSize: objectCount,
    bits: bits ?? [],
  });
  return [stream(opts.commits), stream(opts.trees), stream(opts.blobs), stream(opts.tags)];
}

/** One entry per commit, XOR-chained against the PREVIOUS entry
 *  (`xorOffset: 1`, except entry 0, a terminator): entry `i`'s STORED bits
 *  are generation `i`'s OWN blob/tree/commit positions — the delta —  so
 *  `resolved[i] = stored[i] XOR resolved[i-1]` accumulates every prior
 *  generation's positions too. */
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

function healthySpec(
  ctx: Context,
  typeStreams: readonly [BitmapStreamSpec, BitmapStreamSpec, BitmapStreamSpec, BitmapStreamSpec],
  entries: ReadonlyArray<BitmapEntrySpec>,
): BitmapSpec {
  return {
    optionFlags: 1,
    digestLength: ctx.hashConfig.digestLength,
    checksum: new Uint8Array(ctx.hashConfig.digestLength).fill(0xbb),
    typeStreams,
    entries,
    trailingBytes: 0,
  };
}

interface LinearBitmapFixture {
  readonly ctx: Context;
  readonly blobIds: ReadonlyArray<string>;
  readonly treeIds: ReadonlyArray<string>;
  readonly commitIds: ReadonlyArray<string>;
  readonly ids: ReadonlyArray<string>;
  readonly objectCount: number;
}

interface LinearBitmapFixtureOptions {
  readonly name?: string;
  readonly writeRev?: (ctx: Context, name: string, idxBytes: Uint8Array) => Promise<void>;
}

/**
 * Fixture-building functions this file's own default imports satisfy.
 * Overridable so a test that runs under `vi.resetModules()`/`vi.doMock`
 * (the caching and ordering tests below) can build its `ctx` and pack
 * through the SAME freshly-reloaded module graph the mocked code runs in
 * — mixing a `ctx` built via a stale module instance with code reloaded
 * fresh makes every `instanceof TsgitError` check inside that code fail,
 * since a resettable module graph gives each reload its own class identity.
 */
interface FixtureDeps {
  readonly createContext: typeof createMemoryContext;
  readonly writePack: typeof writeSyntheticPack;
  readonly writeBitmap: typeof writeSyntheticBitmap;
  readonly registry: typeof getPackRegistry;
}

const DEFAULT_DEPS: FixtureDeps = {
  createContext: createMemoryContext,
  writePack: writeSyntheticPack,
  writeBitmap: writeSyntheticBitmap,
  registry: getPackRegistry,
};

/** A full N-generation linear chain, packed, with a healthy, XOR-chained
 *  bitmap covering every commit — the shared "everything works" fixture
 *  most of this suite builds on and narrows. */
async function buildLinearBitmapFixture(
  length: number,
  opts: LinearBitmapFixtureOptions = {},
  deps: FixtureDeps = DEFAULT_DEPS,
): Promise<LinearBitmapFixture> {
  const ctx = deps.createContext();
  const name = opts.name ?? 'linear';
  const chain = await buildChain(ctx, length);
  const ids = await deps.writePack(ctx, name, chain.entries);
  const objectCount = ids.length;
  const idxOf = (id: string) => indexPositionOf(ids, id);

  if (opts.writeRev !== undefined) {
    const idxBytes = await ctx.fs.read(packIdxPath(ctx, name));
    await opts.writeRev(ctx, name, idxBytes);
  }

  const { blobs, trees, commits } = chainPositions(length);
  const typeStreams = typeStreamsFor(objectCount, { blobs, trees, commits });
  const entries = chainBitmapEntries(chain.commitIds, objectCount, idxOf);
  const body = buildBitmap(healthySpec(ctx, typeStreams, entries));
  await deps.writeBitmap(ctx, packBitmapPath(ctx, name), body);

  return {
    ctx,
    blobIds: chain.blobIds,
    treeIds: chain.treeIds,
    commitIds: chain.commitIds,
    ids,
    objectCount,
  };
}

async function firstPack(ctx: Context, deps: FixtureDeps = DEFAULT_DEPS) {
  const [pack] = await deps.registry(ctx).all();
  if (pack === undefined) throw new Error('expected a registered pack');
  return pack;
}

async function loadArtefact(ctx: Context): Promise<LoadedPackBitmap | undefined> {
  const pack = await firstPack(ctx);
  return loadPackBitmapArtefact(ctx, pack);
}

// ---------------------------------------------------------------------------
// Reconstruction
// ---------------------------------------------------------------------------

describe('Given a hand-built XOR chain A(xor 0) <- B(xor 1) <- C(xor 1)', () => {
  describe('When the closure is resolved from the tip commit', () => {
    it('Then it returns the union of every generation the chain accumulates', async () => {
      // Arrange
      const fixture = await buildLinearBitmapFixture(3, { name: 'xor-abc' });
      const artefact = await loadArtefact(fixture.ctx);

      // Act
      const result = await resolveBitmapClosure(fixture.ctx, artefact!, {
        wants: [fixture.commitIds[2] as ObjectId],
        not: [],
        objects: true,
      });

      // Assert
      const ids = new Set(result.map((o) => o.id));
      expect(ids).toEqual(
        new Set(asOids([...fixture.blobIds, ...fixture.treeIds, ...fixture.commitIds])),
      );
    });
  });
});

describe('Given a chain longer than 64 links', () => {
  describe('When the tip is reconstructed cold, with no predecessor cached', () => {
    it('Then the walk is iterative — it resolves without a stack overflow — and returns every generation', async () => {
      // Arrange
      const length = 70;
      const fixture = await buildLinearBitmapFixture(length, { name: 'xor-long' });
      const artefact = await loadArtefact(fixture.ctx);

      // Act
      const result = await resolveBitmapClosure(fixture.ctx, artefact!, {
        wants: [fixture.commitIds[length - 1] as ObjectId],
        not: [],
        objects: false,
      });

      // Assert
      const ids = new Set(result.map((o) => o.id));
      expect(ids).toEqual(new Set(asOids(fixture.commitIds)));
    });
  });
});

describe('Given an entry whose reconstruction is requested via both wants and not, in one closure call', () => {
  describe('When the second request is resolved', () => {
    it('Then the sets agree (the closure difference is empty) and only one fold pass runs for it', async () => {
      // Arrange
      vi.resetModules();
      const foldSpy = vi.fn();
      vi.doMock('../../../../../src/domain/storage/index.js', async (importOriginal) => {
        const actual =
          await importOriginal<typeof import('../../../../../src/domain/storage/index.js')>();
        return {
          ...actual,
          foldEwahStream: (
            ...args: Parameters<typeof actual.foldEwahStream>
          ): ReturnType<typeof actual.foldEwahStream> => {
            foldSpy();
            return actual.foldEwahStream(...args);
          },
        };
      });

      try {
        const [
          { resolveBitmapClosure: scopedResolve },
          { loadPackBitmapArtefact: scopedLoad },
          { createMemoryContext: scopedCreateContext },
          { writeSyntheticPack: scopedWritePack, writeSyntheticBitmap: scopedWriteBitmap },
          { getPackRegistry: scopedRegistry },
        ] = await Promise.all([
          import('../../../../../src/application/primitives/internal/bitmap-binding.js'),
          import('../../../../../src/application/primitives/internal/pack-bitmap-binding.js'),
          import('../../../../../src/adapters/memory/memory-adapter.js'),
          import('../pack-fixture.js'),
          import('../../../../../src/application/primitives/read-object.js'),
        ]);
        const scopedDeps: FixtureDeps = {
          createContext: scopedCreateContext,
          writePack: scopedWritePack,
          writeBitmap: scopedWriteBitmap,
          registry: scopedRegistry,
        };
        const fixture = await buildLinearBitmapFixture(1, { name: 'xor-cache' }, scopedDeps);
        const pack = await firstPack(fixture.ctx, scopedDeps);
        const artefact = await scopedLoad(fixture.ctx, pack);
        foldSpy.mockClear();

        // Act
        const result = await scopedResolve(fixture.ctx, artefact!, {
          wants: [fixture.commitIds[0] as ObjectId],
          not: [fixture.commitIds[0] as ObjectId],
          objects: false,
        });

        // Assert
        expect(result).toEqual([]);
        expect(foldSpy).toHaveBeenCalledTimes(1);
      } finally {
        vi.doUnmock('../../../../../src/domain/storage/index.js');
        vi.resetModules();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Header interpretation — position is an INDEX position, not a pack position
// ---------------------------------------------------------------------------

describe('Given a pack bitmap whose entry header must resolve through the .idx', () => {
  describe('When the closure is resolved from that entry alone', () => {
    it('Then the entry names the commit its index position identifies — reading it as a pack position would name a different object', async () => {
      // Arrange — a 4-generation chain all but guarantees at least one
      // commit whose SHA-sorted index position differs from its pack
      // position (0, 4, 8, ... — see chainPositions), which is what makes
      // the wrong reading observable at all.
      const fixture = await buildLinearBitmapFixture(4, { name: 'header-mapping' });
      const idxBytes = await fixture.ctx.fs.read(packIdxPath(fixture.ctx, 'header-mapping'));
      const index = parsePackIndex(idxBytes);
      const packPositions = packPositionMap(index);
      const target = fixture.commitIds.find((id, i) => {
        const indexPosition = indexPositionOf(fixture.ids, id);
        return indexPosition !== 3 * i + 2;
      });
      if (target === undefined) throw new Error('fixture never separates index and pack position');
      const targetIndexPosition = indexPositionOf(fixture.ids, target);
      const oidsByIndexPosition = allObjectIds(index);
      const correctOid = oidsByIndexPosition[targetIndexPosition];
      // The wrong reading treats `header.position` (an index position) AS a
      // pack position, translating it through `packPositions` a second
      // time before resolving — landing on a different index position and
      // therefore a different oid.
      const wrongOid = oidsByIndexPosition[packPositions[targetIndexPosition] as number];
      expect(wrongOid).not.toBe(correctOid);
      expect(correctOid).toBe(target);

      const artefact = await loadArtefact(fixture.ctx);

      // Act
      const result = await resolveBitmapClosure(fixture.ctx, artefact!, {
        wants: [target as ObjectId],
        not: [],
        objects: false,
      });

      // Assert — the correct reading names `target`; the wrong reading
      // (asserted above) would have named `wrongOid` instead.
      const resultIds = new Set(result.map((o) => o.id));
      expect(resultIds.has(target as ObjectId)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Mapping — .rev usable / absent / refused, identical oid sets
// ---------------------------------------------------------------------------

describe('RegisteredPack position mapping — .rev usable, absent, refused', () => {
  const wantId = (fixture: LinearBitmapFixture): ObjectId => fixture.commitIds[2] as ObjectId;

  const resolveIds = async (fixture: LinearBitmapFixture): Promise<ReadonlySet<ObjectId>> => {
    const artefact = await loadArtefact(fixture.ctx);
    const result = await resolveBitmapClosure(fixture.ctx, artefact!, {
      wants: [wantId(fixture)],
      not: [],
      objects: true,
    });
    return new Set(result.map((o) => o.id));
  };

  describe('Given a pack whose .rev is usable, When the bitmap tier resolves the closure', () => {
    it('Then the closure resolves the same oid set as with no .rev at all', async () => {
      // Arrange
      const fixture = await buildLinearBitmapFixture(3, {
        name: 'rev-usable',
        writeRev: async (ctx, name, idxBytes) => {
          await writeSyntheticRevIndex(ctx, name, packPositionMap(parsePackIndex(idxBytes)));
        },
      });

      // Act
      const result = await resolveIds(fixture);

      // Assert
      expect(result).toEqual(
        new Set(asOids([...fixture.blobIds, ...fixture.treeIds, ...fixture.commitIds])),
      );
    });
  });

  describe('Given a pack with no .rev sibling, When the bitmap tier resolves the closure', () => {
    it('Then the closure resolves the same oid set as with a usable .rev', async () => {
      // Arrange
      const fixture = await buildLinearBitmapFixture(3, { name: 'rev-absent' });

      // Act
      const result = await resolveIds(fixture);

      // Assert
      expect(result).toEqual(
        new Set(asOids([...fixture.blobIds, ...fixture.treeIds, ...fixture.commitIds])),
      );
    });
  });

  describe('Given a pack whose .rev is refused (bad magic), When the bitmap tier resolves the closure', () => {
    it('Then the closure resolves the same oid set as with a usable .rev', async () => {
      // Arrange
      const fixture = await buildLinearBitmapFixture(3, {
        name: 'rev-refused',
        writeRev: async (ctx, name, idxBytes) => {
          await writeSyntheticRevIndex(ctx, name, packPositionMap(parsePackIndex(idxBytes)), {
            magic: 0,
          });
        },
      });

      // Act
      const result = await resolveIds(fixture);

      // Assert
      expect(result).toEqual(
        new Set(asOids([...fixture.blobIds, ...fixture.treeIds, ...fixture.commitIds])),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Types — every set bit's type against the owning stream
// ---------------------------------------------------------------------------

describe('Given a linear chain whose closure includes every type stream', () => {
  describe('When the full closure is resolved', () => {
    it('Then every position is typed correctly against the stream that owns it', async () => {
      // Arrange
      const fixture = await buildLinearBitmapFixture(3, { name: 'types' });
      const artefact = await loadArtefact(fixture.ctx);

      // Act
      const result = await resolveBitmapClosure(fixture.ctx, artefact!, {
        wants: [fixture.commitIds[2] as ObjectId],
        not: [],
        objects: true,
      });

      // Assert
      const typeById = new Map(result.map((o) => [o.id, o.type]));
      for (const id of fixture.blobIds) expect(typeById.get(id as ObjectId)).toBe('blob');
      for (const id of fixture.treeIds) expect(typeById.get(id as ObjectId)).toBe('tree');
      for (const id of fixture.commitIds) expect(typeById.get(id as ObjectId)).toBe('commit');
    });
  });
});

// ---------------------------------------------------------------------------
// Extended positions — a want reachable only through a loose object
// ---------------------------------------------------------------------------

describe('Given a want reachable only through a loose object', () => {
  describe('When the closure is resolved', () => {
    it('Then the loose object is emitted with the right type', async () => {
      // Arrange — a packed commit with NO bitmap entry, whose tree points at
      // a loose blob the pack never carries.
      const ctx = createMemoryContext();
      const base = await buildChain(ctx, 1, 'base');

      const looseBlob: Blob = { type: 'blob', id: '' as ObjectId, content: enc.encode('loose') };
      const looseBlobId = await idOf(ctx, looseBlob);
      const looseBytes = serializeObject(looseBlob, ctx.hashConfig);
      const loosePath = `${ctx.layout.gitDir}/objects/${looseBlobId.slice(0, 2)}/${looseBlobId.slice(2)}`;
      await ctx.fs.write(loosePath, await ctx.compressor.deflate(looseBytes));

      const tipTree: Tree = {
        type: 'tree',
        id: '' as ObjectId,
        entries: [{ name: 'loose.txt', mode: '100644' as FileMode, id: looseBlobId as ObjectId }],
      };
      const tipTreeId = await idOf(ctx, tipTree);
      const tipCommit: Commit = {
        type: 'commit',
        id: '' as ObjectId,
        data: {
          tree: tipTreeId as ObjectId,
          parents: [base.commitIds[0] as ObjectId],
          author: AUTHOR,
          committer: AUTHOR,
          message: 'tip',
          extraHeaders: [],
        },
      };
      const tipCommitId = await idOf(ctx, tipCommit);

      const entries: EntrySpec[] = [
        ...base.entries,
        { kind: 'base', type: 'tree', content: rawContentOf(ctx, tipTree) },
        { kind: 'base', type: 'commit', content: rawContentOf(ctx, tipCommit) },
      ];
      const ids = await writeSyntheticPack(ctx, 'extended', entries);
      const objectCount = ids.length;
      const idxOf = (id: string) => indexPositionOf(ids, id);

      // The bitmap covers ONLY the base generation (position 0/1/2); the
      // tip commit (position 3/4, tree/commit) and its loose blob are
      // deliberately uncovered, forcing the pending-commit walk.
      const typeStreams = typeStreamsFor(objectCount, {
        blobs: [0],
        trees: [1, 3],
        commits: [2, 4],
      });
      const entrySpecs = chainBitmapEntries(base.commitIds, objectCount, idxOf);
      const body = buildBitmap(healthySpec(ctx, typeStreams, entrySpecs));
      await writeSyntheticBitmap(ctx, packBitmapPath(ctx, 'extended'), body);

      const artefact = await loadArtefact(ctx);

      // Act
      const result = await resolveBitmapClosure(ctx, artefact!, {
        wants: [tipCommitId as ObjectId],
        not: [],
        objects: true,
      });

      // Assert
      const loose = result.find((o) => o.id === looseBlobId);
      expect(loose?.type).toBe('blob');
    });
  });
});

// ---------------------------------------------------------------------------
// Degradation — own it each: absent, unreadable, and four structural
// refusals (bad magic, version 2, missing full-DAG flag, an overrunning
// stream) — the binding declines every time; a warn fires for the refused
// cases and not for absent/unreadable.
// ---------------------------------------------------------------------------

function pokeUint32(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  const copy = bytes.slice();
  new DataView(copy.buffer).setUint32(offset, value);
  return copy;
}

function pokeUint16(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  const copy = bytes.slice();
  new DataView(copy.buffer).setUint16(offset, value);
  return copy;
}

const firstStreamWordCountOffset = (digestLength: number): number => 12 + digestLength + 4;

async function healthyBitmapBytes(fixture: LinearBitmapFixture, name: string): Promise<Uint8Array> {
  const { blobs, trees, commits } = chainPositions(1);
  const typeStreams = typeStreamsFor(fixture.objectCount, { blobs, trees, commits });
  const idxOf = (id: string) => indexPositionOf(fixture.ids, id);
  const entries = chainBitmapEntries(fixture.commitIds, fixture.objectCount, idxOf);
  void name;
  return buildBitmap(healthySpec(fixture.ctx, typeStreams, entries));
}

describe('Given a pack with no bitmap file on disk', () => {
  describe('When the artefact is loaded', () => {
    it('Then the binding declines and no warn is emitted', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'no-bitmap', await buildChain(ctx, 1).then((c) => c.entries));
      const warn = vi.fn();
      const wrapped = { ...ctx, logger: { warn } };
      const pack = await firstPack(wrapped);

      // Act
      const artefact = await loadPackBitmapArtefact(wrapped, pack);

      // Assert
      expect(artefact).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    });
  });
});

describe('Given a pack whose bitmap is unreadable (permission denied)', () => {
  describe('When the artefact is loaded', () => {
    it('Then the binding declines and no warn is emitted', async () => {
      // Arrange
      const fixture = await buildLinearBitmapFixture(1, { name: 'unreadable' });
      const body = await healthyBitmapBytes(fixture, 'unreadable');
      await writeSyntheticBitmap(fixture.ctx, packBitmapPath(fixture.ctx, 'unreadable'), body);
      const path = packBitmapPath(fixture.ctx, 'unreadable');
      const warn = vi.fn();
      const wrapped: Context = {
        ...fixture.ctx,
        logger: { warn },
        fs: {
          ...fixture.ctx.fs,
          read: async (p: string) => {
            if (p === path) throw permissionDenied(p);
            return fixture.ctx.fs.read(p);
          },
        },
      };
      const pack = await firstPack(wrapped);

      // Act
      const artefact = await loadPackBitmapArtefact(wrapped, pack);

      // Assert
      expect(artefact).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    });
  });
});

interface RefusalCase {
  readonly label: string;
  readonly corrupt: (healthy: Uint8Array, digestLength: number) => Uint8Array;
}

const REFUSAL_CASES: ReadonlyArray<RefusalCase> = [
  { label: 'bad magic', corrupt: (healthy) => pokeUint32(healthy, 0, 0xdeadbeef) },
  { label: 'version 2', corrupt: (healthy) => pokeUint16(healthy, 4, 2) },
  { label: 'flag word without full-DAG', corrupt: (healthy) => pokeUint16(healthy, 6, 0) },
  {
    label: 'an overrunning stream',
    corrupt: (healthy, digestLength) =>
      pokeUint32(healthy, firstStreamWordCountOffset(digestLength), 0x7fffffff),
  },
];

describe.each(REFUSAL_CASES)('Given a pack bitmap refused for $label', ({ corrupt }) => {
  describe('When the artefact is loaded', () => {
    it('Then the binding declines and a warn is emitted with the artefact name', async () => {
      // Arrange
      const fixture = await buildLinearBitmapFixture(1, { name: 'refused' });
      const healthy = await healthyBitmapBytes(fixture, 'refused');
      const corrupted = corrupt(healthy, fixture.ctx.hashConfig.digestLength);
      await writeSyntheticBitmap(fixture.ctx, packBitmapPath(fixture.ctx, 'refused'), corrupted);
      const warn = vi.fn();
      const wrapped = { ...fixture.ctx, logger: { warn } };
      const pack = await firstPack(wrapped);

      // Act
      const artefact = await loadPackBitmapArtefact(wrapped, pack);

      // Assert
      expect(artefact).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      const [, context] = warn.mock.calls[0] ?? [];
      expect((context as { bitmap?: string } | undefined)?.bitmap).toBe('pack-refused.bitmap');
    });
  });
});

// ---------------------------------------------------------------------------
// Range validation — own it each, in both position spaces
// ---------------------------------------------------------------------------

async function buildMinimalBitmapFixture(
  name: string,
): Promise<{ readonly ctx: Context; readonly objectCount: number }> {
  const ctx = createMemoryContext();
  const entries: EntrySpec[] = [
    { kind: 'base', type: 'blob', content: enc.encode('one') },
    { kind: 'base', type: 'blob', content: enc.encode('two') },
  ];
  await writeSyntheticPack(ctx, name, entries);
  return { ctx, objectCount: 2 };
}

async function loadWithEntries(
  ctx: Context,
  name: string,
  objectCount: number,
  entries: ReadonlyArray<BitmapEntrySpec>,
  typeStreams?: readonly [BitmapStreamSpec, BitmapStreamSpec, BitmapStreamSpec, BitmapStreamSpec],
) {
  const streams = typeStreams ?? typeStreamsFor(objectCount, {});
  const body = buildBitmap(healthySpec(ctx, streams, entries));
  await writeSyntheticBitmap(ctx, packBitmapPath(ctx, name), body);
  const pack = await firstPack(ctx);
  return loadPackBitmapArtefact(ctx, pack);
}

describe('Given a 2-object pack whose entry header names objectCount - 1', () => {
  describe('When the artefact is loaded', () => {
    it('Then the artefact is accepted', async () => {
      // Arrange
      const { ctx, objectCount } = await buildMinimalBitmapFixture('boundary-header-accept');
      const entries: BitmapEntrySpec[] = [
        { position: 1, xorOffset: 0, flags: 0, bitSize: 0, bits: [] },
      ];

      // Act
      const artefact = await loadWithEntries(ctx, 'boundary-header-accept', objectCount, entries);

      // Assert
      expect(artefact).toBeDefined();
    });
  });
});

describe('Given a 2-object pack whose entry header names objectCount', () => {
  describe('When the artefact is loaded', () => {
    it('Then the artefact declines', async () => {
      // Arrange
      const { ctx, objectCount } = await buildMinimalBitmapFixture('boundary-header-decline');
      const entries: BitmapEntrySpec[] = [
        { position: 2, xorOffset: 0, flags: 0, bitSize: 0, bits: [] },
      ];

      // Act
      const artefact = await loadWithEntries(ctx, 'boundary-header-decline', objectCount, entries);

      // Assert
      expect(artefact).toBeUndefined();
    });
  });
});

describe('Given a 2-object pack whose entry header names 999999', () => {
  describe('When the artefact is loaded', () => {
    it('Then the artefact declines', async () => {
      // Arrange
      const { ctx, objectCount } = await buildMinimalBitmapFixture('far-header-decline');
      const entries: BitmapEntrySpec[] = [
        { position: 999999, xorOffset: 0, flags: 0, bitSize: 0, bits: [] },
      ];

      // Act
      const artefact = await loadWithEntries(ctx, 'far-header-decline', objectCount, entries);

      // Assert
      expect(artefact).toBeUndefined();
    });
  });
});

describe('Given a 2-object pack whose commits type stream sets a bit at objectCount - 1', () => {
  describe('When the artefact is loaded', () => {
    it('Then the artefact is accepted', async () => {
      // Arrange
      const { ctx, objectCount } = await buildMinimalBitmapFixture('boundary-bit-accept');
      const typeStreams = typeStreamsFor(objectCount, { commits: [1] });

      // Act
      const artefact = await loadWithEntries(
        ctx,
        'boundary-bit-accept',
        objectCount,
        [],
        typeStreams,
      );

      // Assert
      expect(artefact).toBeDefined();
    });
  });
});

describe('Given a 2-object pack whose commits type stream sets a bit at objectCount', () => {
  describe('When the artefact is loaded', () => {
    it('Then the artefact declines', async () => {
      // Arrange
      const { ctx, objectCount } = await buildMinimalBitmapFixture('boundary-bit-decline');
      const typeStreams = typeStreamsFor(objectCount, { commits: [2] });

      // Act
      const artefact = await loadWithEntries(
        ctx,
        'boundary-bit-decline',
        objectCount,
        [],
        typeStreams,
      );

      // Assert
      expect(artefact).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// The decline is whole-artefact, the fault is reported, the caller sees
// nothing, and the ordering that makes it safe
// ---------------------------------------------------------------------------

interface OutOfRangeFixture {
  readonly ctx: Context;
  readonly commitId: ObjectId;
  readonly artefactName: string;
}

/** A two-entry bitmap: entry 0 is healthy and covers `commitId`'s own
 *  reachability; entry 1 names an out-of-range position and is otherwise
 *  disconnected from the want under test. The whole artefact must decline
 *  regardless — the healthy entry is never allowed to answer. */
async function buildWholeArtefactDeclineFixture(
  name = 'whole-decline',
  deps: FixtureDeps = DEFAULT_DEPS,
): Promise<OutOfRangeFixture> {
  const ctx = deps.createContext();
  const chain = await buildChain(ctx, 1);
  const ids = await deps.writePack(ctx, name, chain.entries);
  const objectCount = ids.length;
  const idxOf = (id: string) => indexPositionOf(ids, id);

  const healthyEntry: BitmapEntrySpec = {
    position: idxOf(chain.commitIds[0] as string),
    xorOffset: 0,
    flags: 0,
    bitSize: objectCount,
    bits: [0, 1, 2],
  };
  const outOfRangeEntry: BitmapEntrySpec = {
    position: 999999,
    xorOffset: 0,
    flags: 0,
    bitSize: 0,
    bits: [],
  };
  const { blobs, trees, commits } = chainPositions(1);
  const typeStreams = typeStreamsFor(objectCount, { blobs, trees, commits });
  const body = buildBitmap(healthySpec(ctx, typeStreams, [healthyEntry, outOfRangeEntry]));
  await deps.writeBitmap(ctx, packBitmapPath(ctx, name), body);

  return { ctx, commitId: chain.commitIds[0] as ObjectId, artefactName: `pack-${name}.bitmap` };
}

describe('Given a two-entry bitmap whose second entry is out of range, the first healthy and covering the want', () => {
  describe('When the artefact is loaded', () => {
    it('Then the binding declines entirely — the healthy entry is never used', async () => {
      // Arrange
      const fixture = await buildWholeArtefactDeclineFixture();
      const pack = await firstPack(fixture.ctx);

      // Act
      const artefact = await loadPackBitmapArtefact(fixture.ctx, pack);

      // Assert
      expect(artefact).toBeUndefined();
    });
  });
});

describe('Given the out-of-range whole-artefact fixture', () => {
  describe('When the artefact is loaded', () => {
    it('Then ctx.logger.warn is called once, naming the artefact', async () => {
      // Arrange
      const fixture = await buildWholeArtefactDeclineFixture('reported');
      const warn = vi.fn();
      const wrapped = { ...fixture.ctx, logger: { warn } };
      const pack = await firstPack(wrapped);

      // Act
      await loadPackBitmapArtefact(wrapped, pack);

      // Assert
      expect(warn).toHaveBeenCalledTimes(1);
      const [, context] = warn.mock.calls[0] ?? [];
      expect((context as { bitmap?: string } | undefined)?.bitmap).toBe('pack-reported.bitmap');
    });
  });
});

describe('Given the out-of-range whole-artefact fixture, through the engine', () => {
  describe('When a bitmap-tier closure is requested', () => {
    it('Then the walk answers correctly and nothing throws', async () => {
      // Arrange
      const fixture = await buildWholeArtefactDeclineFixture('caller-sees-nothing');

      // Act
      const result = await computeClosure(fixture.ctx, {
        tier: 'bitmap',
        wants: [fixture.commitId],
        not: [],
        objects: false,
      });

      // Assert
      expect(result.tier).toBe('walk');
      expect(result.objects.map((o) => o.id)).toEqual([fixture.commitId]);
    });
  });
});

describe('Given the out-of-range whole-artefact fixture, under an instrumented Context', () => {
  describe('When a bitmap-tier closure is requested through the engine', () => {
    it('Then allObjectIds and packPositions() are never entered — the ordering is the assertion, not the answer', async () => {
      // Arrange
      vi.resetModules();
      const allObjectIdsSpy = vi.fn();
      vi.doMock('../../../../../src/domain/storage/pack-index.js', async (importOriginal) => {
        const actual =
          await importOriginal<typeof import('../../../../../src/domain/storage/pack-index.js')>();
        return {
          ...actual,
          allObjectIds: (
            ...args: Parameters<typeof actual.allObjectIds>
          ): ReturnType<typeof actual.allObjectIds> => {
            allObjectIdsSpy();
            return actual.allObjectIds(...args);
          },
        };
      });

      try {
        const [
          { computeClosure: scopedComputeClosure },
          { getPackRegistry: scopedGetPackRegistry },
          { createMemoryContext: scopedCreateContext },
          { writeSyntheticPack: scopedWritePack, writeSyntheticBitmap: scopedWriteBitmap },
        ] = await Promise.all([
          import('../../../../../src/application/primitives/internal/closure-engine.js'),
          import('../../../../../src/application/primitives/read-object.js'),
          import('../../../../../src/adapters/memory/memory-adapter.js'),
          import('../pack-fixture.js'),
        ]);
        const scopedDeps: FixtureDeps = {
          createContext: scopedCreateContext,
          writePack: scopedWritePack,
          writeBitmap: scopedWriteBitmap,
          registry: scopedGetPackRegistry,
        };
        const fixture = await buildWholeArtefactDeclineFixture('ordering', scopedDeps);
        const [pack] = await scopedGetPackRegistry(fixture.ctx).all();
        const packPositionsSpy = vi.spyOn(
          pack as { packPositions: () => unknown },
          'packPositions',
        );

        // Act
        const result = await scopedComputeClosure(fixture.ctx, {
          tier: 'bitmap',
          wants: [fixture.commitId],
          not: [],
          objects: false,
        });

        // Assert
        expect(result.tier).toBe('walk');
        expect(allObjectIdsSpy).not.toHaveBeenCalled();
        expect(packPositionsSpy).not.toHaveBeenCalled();
      } finally {
        vi.doUnmock('../../../../../src/domain/storage/pack-index.js');
        vi.resetModules();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// fsck and consumption disagree, correctly — one fixture, one `it`
// ---------------------------------------------------------------------------

describe('Given a bitmap with an out-of-range entry header whose trailer is restamped', () => {
  describe('When the fsck bitmap pass and the closure binding each examine it', () => {
    it('Then runBitmapHealthPass finds nothing (exitBit 0) and the binding declines — both on the same bytes', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const name = 'fsck-vs-consumption';
      const chain = await buildChain(ctx, 1);
      await writeSyntheticPack(ctx, name, chain.entries);
      const outOfRangeEntry: BitmapEntrySpec = {
        position: 999999,
        xorOffset: 0,
        flags: 0,
        bitSize: 0,
        bits: [],
      };
      const typeStreams = typeStreamsFor(3, {});
      const body = buildBitmap(healthySpec(ctx, typeStreams, [outOfRangeEntry]));
      // RESTAMPED (no digestOver/flipTrailer override): the trailer matches
      // the corrupt body exactly, so the checksum-only fsck pass sees a
      // valid file.
      await writeSyntheticBitmap(ctx, packBitmapPath(ctx, name), body);
      const pack = await firstPack(ctx);

      // Act
      const fsckResult = await runBitmapHealthPass(ctx, {});
      const artefact = await loadPackBitmapArtefact(ctx, pack);

      // Assert
      expect(fsckResult.findings).toHaveLength(0);
      expect(fsckResult.exitBit).toBe(0);
      expect(artefact).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Midx bitmap flavour — bits are PSEUDO-PACK positions, resolved through the
// midx's reverse-index chunk; entry headers are MIDX positions, resolved
// directly. Fixtures reuse the pack-flavour helpers above wherever the shape
// coincides (a bare `position` value is "the sorted rank among the ids the
// artefact carries", true of both an `.idx` and a midx's OIDL over the SAME
// oid set) and add only what the midx artefact itself needs: a flat
// multi-pack-index (`buildMidx`) and its own `.bitmap`.
// ---------------------------------------------------------------------------

const midxFlatPath = (ctx: Context): string => `${packDir(ctx)}/multi-pack-index`;
const midxBitmapPath = (ctx: Context, hex: string): string =>
  `${packDir(ctx)}/multi-pack-index-${hex}.bitmap`;

async function writeMidxBytes(ctx: Context, bytes: Uint8Array): Promise<void> {
  await ctx.fs.write(midxFlatPath(ctx), bytes);
}

/** `buildMidx` leaves the trailer as `digestLength` zero bytes (it is never
 *  read by the parser) — the midx-bitmap name this suite composes matches
 *  that STORED trailer exactly, with no separate stamping step needed for
 *  the healthy case. */
const zeroTrailerHex = (digestLength: number): string => '00'.repeat(digestLength);

function flipByte(bytes: Uint8Array, offset: number): Uint8Array {
  const copy = bytes.slice();
  copy[offset] = copy[offset]! ^ 0xff;
  return copy;
}

function baseMidxSpec(digestLength: number): Omit<MidxSpec, 'entries' | 'packNames' | 'revBody'> {
  return {
    version: 1,
    hashVersion: digestLength === 32 ? 2 : 1,
    digestLength,
    numBaseFiles: 0,
  };
}

/**
 * `packNames`/`entries` for a midx that claims the SAME pack
 * `writeSyntheticPack` just wrote, with each entry's `packIndex`/`offset`
 * read back from that pack's own REAL `.idx` — never invented. The
 * midx-bitmap tier itself never opens a pack (§D4's whole point), but
 * `readObject` resolves every oid the closure algorithm walks through
 * `PackRegistry.lookup`, and a midx PRESENT in the generation is
 * authoritative for lookups of any oid its OIDL carries: an entry whose
 * `packIndex`/`offset` do not name a real pack position throws, not
 * merely miscounts, so this fixture never invents one.
 */
async function realMidxBinding(
  ctx: Context,
  name: string,
  ids: ReadonlyArray<string>,
): Promise<Pick<MidxSpec, 'entries' | 'packNames'>> {
  const idxBytes = await ctx.fs.read(packIdxPath(ctx, name));
  const index = parsePackIndex(idxBytes);
  return {
    packNames: [`pack-${name}.idx`],
    entries: ids.map((id) => ({
      id: id as ObjectId,
      packIndex: 0,
      offset: lookupPackIndex(index, id as ObjectId) as number,
    })),
  };
}

async function loadMidxArtefact(ctx: Context): Promise<LoadedMidxBitmap | undefined> {
  return loadMidxBitmapArtefact(ctx, await getPackRegistry(ctx).midxBitmap());
}

interface MidxBitmapFixture {
  readonly ctx: Context;
  readonly blobIds: ReadonlyArray<string>;
  readonly treeIds: ReadonlyArray<string>;
  readonly commitIds: ReadonlyArray<string>;
  readonly ids: ReadonlyArray<string>;
  readonly objectCount: number;
  readonly hex: string;
}

interface MidxBitmapFixtureOptions {
  readonly name?: string;
  /** Omit the midx's reverse-index chunk entirely. Default `true` (present). */
  readonly withRidx?: boolean;
}

/**
 * A full N-generation linear chain, packed and CLAIMED by a midx whose OIDL
 * carries every chain oid plus a reverse-index chunk, and a midx bitmap
 * XOR-chained across every commit. Pseudo-pack position is this fixture's
 * OWN choice — insertion order, the same layout `chainPositions` already
 * describes for the pack flavour — consistently applied to the
 * reverse-index chunk body and to every bit the bitmap declares; entry
 * headers carry each commit's MIDX position (its SHA-sorted rank among
 * `ids`, identical in shape to an index position since the midx's OIDL is
 * the SAME oid set sorted the SAME way).
 */
async function buildMidxBitmapFixture(
  length: number,
  opts: MidxBitmapFixtureOptions = {},
): Promise<MidxBitmapFixture> {
  const ctx = createMemoryContext();
  const name = opts.name ?? 'midx-linear';
  const chain = await buildChain(ctx, length, name);
  const ids = await writeSyntheticPack(ctx, name, chain.entries);
  const objectCount = ids.length;
  const digestLength = ctx.hashConfig.digestLength;
  const midxPositionOf = (id: string) => indexPositionOf(ids, id);

  const revBody = ids.map((id) => midxPositionOf(id));
  const binding = await realMidxBinding(ctx, name, ids);
  const midxSpec: MidxSpec = {
    ...baseMidxSpec(digestLength),
    ...binding,
    ...(opts.withRidx === false ? {} : { revBody }),
  };
  await writeMidxBytes(ctx, buildMidx(midxSpec));

  const { blobs, trees, commits } = chainPositions(length);
  const typeStreams = typeStreamsFor(objectCount, { blobs, trees, commits });
  const entries = chainBitmapEntries(chain.commitIds, objectCount, midxPositionOf);
  const body = buildBitmap(healthySpec(ctx, typeStreams, entries));
  const hex = zeroTrailerHex(digestLength);
  await writeSyntheticBitmap(ctx, midxBitmapPath(ctx, hex), body);

  return {
    ctx,
    blobIds: chain.blobIds,
    treeIds: chain.treeIds,
    commitIds: chain.commitIds,
    ids,
    objectCount,
    hex,
  };
}

interface MidxAndPackBitmapFixture extends MidxBitmapFixture {
  readonly packName: string;
}

interface MidxAndPackBitmapFixtureOptions extends MidxBitmapFixtureOptions {
  /** Skip writing the midx bitmap file at all. Default `true` (present). */
  readonly withMidxBitmap?: boolean;
}

/**
 * `buildMidxBitmapFixture` plus a healthy PACK bitmap covering the SAME
 * chain, built from the SAME type streams and entries (index position and
 * midx position coincide for this fixture's single oid set, and pseudo-pack
 * position and pack position both use insertion order) — the artefact this
 * suite's fall-through tests prove answers once the midx bitmap is declined
 * or not found, with the identical object set either artefact would report.
 */
async function buildMidxAndPackBitmapFixture(
  length: number,
  opts: MidxAndPackBitmapFixtureOptions = {},
): Promise<MidxAndPackBitmapFixture> {
  const ctx = createMemoryContext();
  const name = opts.name ?? 'midx-and-pack';
  const chain = await buildChain(ctx, length, name);
  const ids = await writeSyntheticPack(ctx, name, chain.entries);
  const objectCount = ids.length;
  const digestLength = ctx.hashConfig.digestLength;
  const positionOf = (id: string) => indexPositionOf(ids, id);

  const { blobs, trees, commits } = chainPositions(length);
  const typeStreams = typeStreamsFor(objectCount, { blobs, trees, commits });
  const entries = chainBitmapEntries(chain.commitIds, objectCount, positionOf);

  await writeSyntheticBitmap(
    ctx,
    packBitmapPath(ctx, name),
    buildBitmap(healthySpec(ctx, typeStreams, entries)),
  );

  const revBody = ids.map((id) => positionOf(id));
  const binding = await realMidxBinding(ctx, name, ids);
  const midxSpec: MidxSpec = {
    ...baseMidxSpec(digestLength),
    ...binding,
    ...(opts.withRidx === false ? {} : { revBody }),
  };
  await writeMidxBytes(ctx, buildMidx(midxSpec));

  const hex = zeroTrailerHex(digestLength);
  if (opts.withMidxBitmap !== false) {
    await writeSyntheticBitmap(
      ctx,
      midxBitmapPath(ctx, hex),
      buildBitmap(healthySpec(ctx, typeStreams, entries)),
    );
  }

  return {
    ctx,
    blobIds: chain.blobIds,
    treeIds: chain.treeIds,
    commitIds: chain.commitIds,
    ids,
    objectCount,
    hex,
    packName: name,
  };
}

// ---------------------------------------------------------------------------
// Midx mapping — a bit resolves through the reverse-index chunk
// ---------------------------------------------------------------------------

describe('Given a crafted midx carrying a reverse-index chunk and a midx bitmap', () => {
  describe('When the closure is resolved from the tip commit', () => {
    it('Then every bit resolves to the right oid through the reverse-index chunk', async () => {
      // Arrange
      const fixture = await buildMidxBitmapFixture(3, { name: 'midx-mapping' });
      const artefact = await loadMidxArtefact(fixture.ctx);

      // Act
      const result = await resolveBitmapClosure(fixture.ctx, artefact!, {
        wants: [fixture.commitIds[2] as ObjectId],
        not: [],
        objects: true,
      });

      // Assert
      const ids = new Set(result.map((o) => o.id));
      expect(ids).toEqual(
        new Set(asOids([...fixture.blobIds, ...fixture.treeIds, ...fixture.commitIds])),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// The 108/0 measurement: entry headers read as MIDX positions versus as
// PSEUDO-PACK positions — the single most likely implementation bug in the
// entry. Pseudo-pack position here is deliberately the REVERSAL of midx
// position (`revBody[p] = objectCount - 1 - p`), a fixed-point-free
// permutation whenever `objectCount` is even (used below): reading a
// header's own MIDX position AS a pseudo-pack position can therefore never
// coincidentally land back on itself, so "the wrong reading matches none" is
// guaranteed by construction, not by chance over real SHA values.
// ---------------------------------------------------------------------------

interface Ag12Fixture {
  readonly midx: ReturnType<typeof parseMultiPackIndex>;
  readonly headers: ReadonlyArray<{ readonly position: number }>;
  readonly commitIds: ReadonlyArray<string>;
}

async function buildAg12Fixture(): Promise<Ag12Fixture> {
  const length = 4; // 12 objects — even, so the reversal below has no fixed point
  const ctx = createMemoryContext();
  const name = 'ag12';
  const chain = await buildChain(ctx, length, name);
  const ids = await writeSyntheticPack(ctx, name, chain.entries);
  const objectCount = ids.length;
  const digestLength = ctx.hashConfig.digestLength;
  const midxPositionOf = (id: string) => indexPositionOf(ids, id);
  const pseudoPackPositionOf = (id: string) => objectCount - 1 - midxPositionOf(id);

  const revBody = new Array<number>(objectCount);
  for (const id of ids) revBody[pseudoPackPositionOf(id)] = midxPositionOf(id);

  const typeStreams = typeStreamsFor(objectCount, {
    blobs: chain.blobIds.map(pseudoPackPositionOf),
    trees: chain.treeIds.map(pseudoPackPositionOf),
    commits: chain.commitIds.map(pseudoPackPositionOf),
  });
  const entries: BitmapEntrySpec[] = chain.commitIds.map((commitId) => ({
    position: midxPositionOf(commitId),
    xorOffset: 0,
    flags: 0,
    bitSize: 0,
    bits: [],
  }));
  const body = buildBitmap(healthySpec(ctx, typeStreams, entries));

  const binding = await realMidxBinding(ctx, name, ids);
  await writeMidxBytes(
    ctx,
    buildMidx({
      ...baseMidxSpec(digestLength),
      ...binding,
      revBody,
    }),
  );
  const hex = zeroTrailerHex(digestLength);
  await writeSyntheticBitmap(ctx, midxBitmapPath(ctx, hex), body);

  const midxBytes = await ctx.fs.read(midxFlatPath(ctx));
  const midx = parseMultiPackIndex(midxBytes, digestLength);
  const artefact = await loadMidxArtefact(ctx);
  if (artefact === undefined) throw new Error('expected the midx bitmap to load');

  return { midx, headers: artefact.headers, commitIds: chain.commitIds };
}

describe('Given a midx bitmap with several commit entries', () => {
  describe('When each header position is read as a MIDX position, directly', () => {
    it('Then every entry names its own commit', async () => {
      // Arrange
      const fixture = await buildAg12Fixture();

      // Act
      const matches = fixture.headers.map(
        (header, i) => midxOidAt(fixture.midx, header.position) === fixture.commitIds[i],
      );

      // Assert
      expect(matches).toHaveLength(fixture.commitIds.length);
      expect(matches.every(Boolean)).toBe(true);
    });
  });

  describe('When each header position is instead read as a PSEUDO-PACK position, through the reverse-index chunk', () => {
    it('Then no entry names its own commit', async () => {
      // Arrange
      const fixture = await buildAg12Fixture();

      // Act
      const matches = fixture.headers.map(
        (header, i) =>
          midxOidAt(fixture.midx, midxReverseIndexAt(fixture.midx, header.position)) ===
          fixture.commitIds[i],
      );

      // Assert
      expect(matches.some(Boolean)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// No reverse-index chunk — free structural information: the midx tier is
// unusable, and the pack tier takes over.
// ---------------------------------------------------------------------------

describe('Given a midx bitmap beside a midx with no reverse-index chunk', () => {
  describe('When the artefact is loaded directly', () => {
    it('Then the midx tier declines', async () => {
      // Arrange
      const fixture = await buildMidxAndPackBitmapFixture(2, {
        name: 'no-ridx',
        withRidx: false,
      });

      // Act
      const artefact = await loadMidxArtefact(fixture.ctx);

      // Assert
      expect(artefact).toBeUndefined();
    });
  });

  describe('When a bitmap-tier closure is requested through the engine', () => {
    it('Then the pack tier answers with the correct object set', async () => {
      // Arrange
      const fixture = await buildMidxAndPackBitmapFixture(2, {
        name: 'no-ridx-engine',
        withRidx: false,
      });

      // Act
      const result = await computeClosure(fixture.ctx, {
        tier: 'bitmap',
        wants: [fixture.commitIds[1] as ObjectId],
        not: [],
        objects: true,
      });

      // Assert
      expect(result.tier).toBe('bitmap');
      const ids = new Set(result.objects.map((o) => o.id));
      expect(ids).toEqual(
        new Set(asOids([...fixture.blobIds, ...fixture.treeIds, ...fixture.commitIds])),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Discovery — own it each: a renamed bitmap is simply not found; a midx
// whose own stored trailer is wrong hides its own bitmap.
// ---------------------------------------------------------------------------

describe('Given the midx bitmap renamed to a hash the midx does not itself store', () => {
  describe('When a bitmap-tier closure is requested through the engine', () => {
    it('Then the midx bitmap is not found and the pack tier answers', async () => {
      // Arrange
      const fixture = await buildMidxAndPackBitmapFixture(2, {
        name: 'renamed',
        withMidxBitmap: false,
      });
      const wrongHex = zeroTrailerHex(fixture.ctx.hashConfig.digestLength).replace(/^00/, 'ff');
      const { blobs, trees, commits } = chainPositions(2);
      const typeStreams = typeStreamsFor(fixture.objectCount, { blobs, trees, commits });
      const entries = chainBitmapEntries(fixture.commitIds, fixture.objectCount, (id) =>
        indexPositionOf(fixture.ids, id),
      );
      await writeSyntheticBitmap(
        fixture.ctx,
        midxBitmapPath(fixture.ctx, wrongHex),
        buildBitmap(healthySpec(fixture.ctx, typeStreams, entries)),
      );

      // Act
      const result = await computeClosure(fixture.ctx, {
        tier: 'bitmap',
        wants: [fixture.commitIds[1] as ObjectId],
        not: [],
        objects: true,
      });

      // Assert
      expect(result.tier).toBe('bitmap');
      const ids = new Set(result.objects.map((o) => o.id));
      expect(ids).toEqual(
        new Set(asOids([...fixture.blobIds, ...fixture.treeIds, ...fixture.commitIds])),
      );
    });
  });
});

describe('Given a midx whose own stored trailer is wrong, with a healthy bitmap beside its ORIGINAL name', () => {
  describe('When a bitmap-tier closure is requested through the engine', () => {
    it('Then the wrong trailer hides the bitmap and the pack tier answers', async () => {
      // Arrange
      const fixture = await buildMidxAndPackBitmapFixture(2, { name: 'wrong-trailer' });
      const midxBytes = await fixture.ctx.fs.read(midxFlatPath(fixture.ctx));
      const digestLength = fixture.ctx.hashConfig.digestLength;
      // One byte inside the STORED trailer flipped, never restamped — the
      // composed bitmap name this scan derives no longer matches the file
      // already written at `fixture.hex`.
      await fixture.ctx.fs.write(
        midxFlatPath(fixture.ctx),
        flipByte(midxBytes, midxBytes.length - digestLength),
      );

      // Act
      const result = await computeClosure(fixture.ctx, {
        tier: 'bitmap',
        wants: [fixture.commitIds[1] as ObjectId],
        not: [],
        objects: true,
      });

      // Assert
      expect(result.tier).toBe('bitmap');
      const ids = new Set(result.objects.map((o) => o.id));
      expect(ids).toEqual(
        new Set(asOids([...fixture.blobIds, ...fixture.treeIds, ...fixture.commitIds])),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Types — the four streams against the midx's object count
// ---------------------------------------------------------------------------

function countSetBits(bits: Uint32Array): number {
  let count = 0;
  for (const word of bits) {
    let w = word >>> 0;
    while (w !== 0) {
      count += w & 1;
      w >>>= 1;
    }
  }
  return count;
}

describe('Given a midx bitmap whose closure includes every type stream', () => {
  describe('When the artefact is loaded', () => {
    it('Then the set bits across all four streams sum to the midx object count', async () => {
      // Arrange
      const fixture = await buildMidxBitmapFixture(3, { name: 'midx-types-count' });

      // Act
      const artefact = await loadMidxArtefact(fixture.ctx);

      // Assert
      const total = artefact!.typeBits.reduce((sum, bits) => sum + countSetBits(bits), 0);
      expect(total).toBe(fixture.objectCount);
    });
  });

  describe('When the full closure is resolved', () => {
    it('Then every position is typed correctly against the stream that owns it', async () => {
      // Arrange
      const fixture = await buildMidxBitmapFixture(3, { name: 'midx-types-predict' });
      const artefact = await loadMidxArtefact(fixture.ctx);

      // Act
      const result = await resolveBitmapClosure(fixture.ctx, artefact!, {
        wants: [fixture.commitIds[2] as ObjectId],
        not: [],
        objects: true,
      });

      // Assert
      const typeById = new Map(result.map((o) => [o.id, o.type]));
      for (const id of fixture.blobIds) expect(typeById.get(id as ObjectId)).toBe('blob');
      for (const id of fixture.treeIds) expect(typeById.get(id as ObjectId)).toBe('tree');
      for (const id of fixture.commitIds) expect(typeById.get(id as ObjectId)).toBe('commit');
    });
  });
});

// ---------------------------------------------------------------------------
// Range validation against the pseudo-pack — own it each, in both position
// spaces, checked against MultiPackIndex.objectCount (the pseudo-pack's own
// count) — Part 12's pack-count rows do not exercise this boundary.
// ---------------------------------------------------------------------------

async function buildMinimalMidxBitmapFixture(
  name: string,
): Promise<{ readonly ctx: Context; readonly objectCount: number; readonly hex: string }> {
  const ctx = createMemoryContext();
  const entries: EntrySpec[] = [
    { kind: 'base', type: 'blob', content: enc.encode('midx-one') },
    { kind: 'base', type: 'blob', content: enc.encode('midx-two') },
  ];
  const ids = await writeSyntheticPack(ctx, name, entries);
  const digestLength = ctx.hashConfig.digestLength;
  const binding = await realMidxBinding(ctx, name, ids);
  await writeMidxBytes(
    ctx,
    buildMidx({
      ...baseMidxSpec(digestLength),
      ...binding,
      revBody: [0, 1],
    }),
  );
  return { ctx, objectCount: 2, hex: zeroTrailerHex(digestLength) };
}

async function loadMidxWithEntries(
  ctx: Context,
  hex: string,
  objectCount: number,
  entries: ReadonlyArray<BitmapEntrySpec>,
  typeStreams?: readonly [BitmapStreamSpec, BitmapStreamSpec, BitmapStreamSpec, BitmapStreamSpec],
): Promise<LoadedMidxBitmap | undefined> {
  const streams = typeStreams ?? typeStreamsFor(objectCount, {});
  const body = buildBitmap(healthySpec(ctx, streams, entries));
  await writeSyntheticBitmap(ctx, midxBitmapPath(ctx, hex), body);
  return loadMidxArtefact(ctx);
}

describe('Given a 2-object midx whose entry header names objectCount - 1', () => {
  describe('When the artefact is loaded', () => {
    it('Then the artefact is accepted', async () => {
      // Arrange
      const { ctx, hex, objectCount } = await buildMinimalMidxBitmapFixture(
        'midx-boundary-header-accept',
      );
      const entries: BitmapEntrySpec[] = [
        { position: 1, xorOffset: 0, flags: 0, bitSize: 0, bits: [] },
      ];

      // Act
      const artefact = await loadMidxWithEntries(ctx, hex, objectCount, entries);

      // Assert
      expect(artefact).toBeDefined();
    });
  });
});

describe('Given a 2-object midx whose entry header names objectCount', () => {
  describe('When the artefact is loaded', () => {
    it('Then the artefact declines', async () => {
      // Arrange
      const { ctx, hex, objectCount } = await buildMinimalMidxBitmapFixture(
        'midx-boundary-header-decline',
      );
      const entries: BitmapEntrySpec[] = [
        { position: 2, xorOffset: 0, flags: 0, bitSize: 0, bits: [] },
      ];

      // Act
      const artefact = await loadMidxWithEntries(ctx, hex, objectCount, entries);

      // Assert
      expect(artefact).toBeUndefined();
    });
  });
});

describe('Given a 2-object midx whose entry header names 999999', () => {
  describe('When the artefact is loaded', () => {
    it('Then the artefact declines', async () => {
      // Arrange
      const { ctx, hex, objectCount } =
        await buildMinimalMidxBitmapFixture('midx-far-header-decline');
      const entries: BitmapEntrySpec[] = [
        { position: 999999, xorOffset: 0, flags: 0, bitSize: 0, bits: [] },
      ];

      // Act
      const artefact = await loadMidxWithEntries(ctx, hex, objectCount, entries);

      // Assert
      expect(artefact).toBeUndefined();
    });
  });
});

describe('Given a 2-object midx whose commits type stream sets a bit at objectCount - 1', () => {
  describe('When the artefact is loaded', () => {
    it('Then the artefact is accepted', async () => {
      // Arrange
      const { ctx, hex, objectCount } = await buildMinimalMidxBitmapFixture(
        'midx-boundary-bit-accept',
      );
      const typeStreams = typeStreamsFor(objectCount, { commits: [1] });

      // Act
      const artefact = await loadMidxWithEntries(ctx, hex, objectCount, [], typeStreams);

      // Assert
      expect(artefact).toBeDefined();
    });
  });
});

describe('Given a 2-object midx whose commits type stream sets a bit at objectCount', () => {
  describe('When the artefact is loaded', () => {
    it('Then the artefact declines', async () => {
      // Arrange
      const { ctx, hex, objectCount } = await buildMinimalMidxBitmapFixture(
        'midx-boundary-bit-decline',
      );
      const typeStreams = typeStreamsFor(objectCount, { commits: [2] });

      // Act
      const artefact = await loadMidxWithEntries(ctx, hex, objectCount, [], typeStreams);

      // Assert
      expect(artefact).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// The decline is whole-artefact, the fault is reported, the caller sees
// nothing, and the ordering that makes it safe
// ---------------------------------------------------------------------------

interface MidxOutOfRangeFixture {
  readonly ctx: Context;
  readonly commitId: ObjectId;
  readonly treeId: ObjectId;
  readonly blobId: ObjectId;
  readonly artefactName: string;
}

/** A midx whose bitmap has two entries: one healthy, covering `commitId`'s
 *  own reachability; one naming an out-of-range position. A healthy PACK
 *  bitmap covers the SAME chain, so a decline here has somewhere to fall
 *  through to. The whole midx artefact must decline regardless of the
 *  healthy entry.
 *
 *  `createContext` is overridable so a caller running under
 *  `vi.resetModules()`/`vi.doMock()` (the ordering test below) can build its
 *  `ctx` through the SAME freshly-reloaded module graph the mocked code
 *  runs in — a `ctx` built via a stale module instance throws `TsgitError`s
 *  a fresh reload's `instanceof` checks (inside `loose-oid-cache.ts`, on the
 *  fallback loose-object probe every commit read tries first) do not
 *  recognise. */
async function buildMidxWholeArtefactDeclineFixture(
  name = 'midx-whole-decline',
  createContext: typeof createMemoryContext = createMemoryContext,
): Promise<MidxOutOfRangeFixture> {
  const ctx = createContext();
  const chain = await buildChain(ctx, 1, name);
  const ids = await writeSyntheticPack(ctx, name, chain.entries);
  const objectCount = ids.length;
  const digestLength = ctx.hashConfig.digestLength;
  const positionOf = (id: string) => indexPositionOf(ids, id);

  const { blobs, trees, commits } = chainPositions(1);
  const typeStreams = typeStreamsFor(objectCount, { blobs, trees, commits });
  const packEntries = chainBitmapEntries(chain.commitIds, objectCount, positionOf);
  await writeSyntheticBitmap(
    ctx,
    packBitmapPath(ctx, name),
    buildBitmap(healthySpec(ctx, typeStreams, packEntries)),
  );

  const revBody = ids.map((id) => positionOf(id));
  const binding = await realMidxBinding(ctx, name, ids);
  await writeMidxBytes(
    ctx,
    buildMidx({
      ...baseMidxSpec(digestLength),
      ...binding,
      revBody,
    }),
  );

  const healthyEntry: BitmapEntrySpec = {
    position: positionOf(chain.commitIds[0] as string),
    xorOffset: 0,
    flags: 0,
    bitSize: objectCount,
    bits: [0, 1, 2],
  };
  const outOfRangeEntry: BitmapEntrySpec = {
    position: 999999,
    xorOffset: 0,
    flags: 0,
    bitSize: 0,
    bits: [],
  };
  const hex = zeroTrailerHex(digestLength);
  await writeSyntheticBitmap(
    ctx,
    midxBitmapPath(ctx, hex),
    buildBitmap(healthySpec(ctx, typeStreams, [healthyEntry, outOfRangeEntry])),
  );

  return {
    ctx,
    commitId: chain.commitIds[0] as ObjectId,
    treeId: chain.treeIds[0] as ObjectId,
    blobId: chain.blobIds[0] as ObjectId,
    artefactName: `multi-pack-index-${hex}.bitmap`,
  };
}

describe('Given a two-entry midx bitmap whose second entry is out of range, the first healthy and covering the want', () => {
  describe('When the artefact is loaded', () => {
    it('Then the binding declines entirely — the healthy entry is never used', async () => {
      // Arrange
      const fixture = await buildMidxWholeArtefactDeclineFixture();

      // Act
      const artefact = await loadMidxArtefact(fixture.ctx);

      // Assert
      expect(artefact).toBeUndefined();
    });
  });
});

describe('Given the out-of-range midx whole-artefact fixture', () => {
  describe('When the artefact is loaded', () => {
    it('Then ctx.logger.warn is called once, naming the MIDX bitmap', async () => {
      // Arrange
      const fixture = await buildMidxWholeArtefactDeclineFixture('midx-reported');
      const warn = vi.fn();
      const wrapped = { ...fixture.ctx, logger: { warn } };

      // Act
      await loadMidxBitmapArtefact(wrapped, await getPackRegistry(wrapped).midxBitmap());

      // Assert
      expect(warn).toHaveBeenCalledTimes(1);
      const [, context] = warn.mock.calls[0] ?? [];
      expect((context as { bitmap?: string } | undefined)?.bitmap).toBe(fixture.artefactName);
    });
  });
});

describe('Given the out-of-range midx whole-artefact fixture, through the engine', () => {
  describe('When a bitmap-tier closure is requested', () => {
    it('Then the pack tier answers correctly and nothing throws', async () => {
      // Arrange
      const fixture = await buildMidxWholeArtefactDeclineFixture('midx-caller-sees-nothing');

      // Act
      const result = await computeClosure(fixture.ctx, {
        tier: 'bitmap',
        wants: [fixture.commitId],
        not: [],
        objects: true,
      });

      // Assert — the decline is silent and the PACK artefact answers, with
      // its own full object set (unlike a walk fallback, which this fixture
      // never reaches).
      expect(result.tier).toBe('bitmap');
      const ids = new Set(result.objects.map((o) => o.id));
      expect(ids).toEqual(new Set([fixture.commitId, fixture.treeId, fixture.blobId]));
    });
  });
});

describe('Given the out-of-range midx whole-artefact fixture, under an instrumented Context', () => {
  describe('When a bitmap-tier closure is requested through the engine', () => {
    it('Then midxOidAt and midxReverseIndexAt are never reached for the declining artefact — the ordering is the assertion, not the answer', async () => {
      // Arrange
      vi.resetModules();
      const midxOidAtSpy = vi.fn();
      const midxReverseIndexAtSpy = vi.fn();
      vi.doMock('../../../../../src/domain/storage/index.js', async (importOriginal) => {
        const actual =
          await importOriginal<typeof import('../../../../../src/domain/storage/index.js')>();
        return {
          ...actual,
          midxOidAt: (
            ...args: Parameters<typeof actual.midxOidAt>
          ): ReturnType<typeof actual.midxOidAt> => {
            midxOidAtSpy();
            return actual.midxOidAt(...args);
          },
          midxReverseIndexAt: (
            ...args: Parameters<typeof actual.midxReverseIndexAt>
          ): ReturnType<typeof actual.midxReverseIndexAt> => {
            midxReverseIndexAtSpy();
            return actual.midxReverseIndexAt(...args);
          },
        };
      });

      try {
        const [
          { computeClosure: scopedComputeClosure },
          { createMemoryContext: scopedCreateContext },
        ] = await Promise.all([
          import('../../../../../src/application/primitives/internal/closure-engine.js'),
          import('../../../../../src/adapters/memory/memory-adapter.js'),
        ]);
        const fixture = await buildMidxWholeArtefactDeclineFixture(
          'midx-ordering',
          scopedCreateContext,
        );

        // Act
        const result = await scopedComputeClosure(fixture.ctx, {
          tier: 'bitmap',
          wants: [fixture.commitId],
          not: [],
          objects: true,
        });

        // Assert
        expect(result.tier).toBe('bitmap');
        expect(midxOidAtSpy).not.toHaveBeenCalled();
        expect(midxReverseIndexAtSpy).not.toHaveBeenCalled();
      } finally {
        vi.doUnmock('../../../../../src/domain/storage/index.js');
        vi.resetModules();
      }
    });
  });
});
