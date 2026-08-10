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
  loadPackBitmapArtefact,
  resolveBitmapClosure,
} from '../../../../../src/application/primitives/internal/bitmap-binding.js';
import { computeClosure } from '../../../../../src/application/primitives/internal/closure-engine.js';
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
import { parsePackIndex } from '../../../../../src/domain/storage/index.js';
import { allObjectIds } from '../../../../../src/domain/storage/pack-index.js';
import type { Context } from '../../../../../src/ports/context.js';
import {
  type BitmapEntrySpec,
  type BitmapSpec,
  type BitmapStreamSpec,
  buildBitmap,
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
          { loadPackBitmapArtefact: scopedLoad, resolveBitmapClosure: scopedResolve },
          { createMemoryContext: scopedCreateContext },
          { writeSyntheticPack: scopedWritePack, writeSyntheticBitmap: scopedWriteBitmap },
          { getPackRegistry: scopedRegistry },
        ] = await Promise.all([
          import('../../../../../src/application/primitives/internal/bitmap-binding.js'),
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
