/**
 * Unit tests for the closure algorithm's own decision points — tip peeling,
 * the pending-commit walk, the extended-position space and the word-wise
 * emit — as opposed to the loading, header-interpretation and range-decline
 * behaviour its sibling suite covers.
 *
 * Fixtures stay deliberately small: a synthetic pack whose insertion order IS
 * its pack-position order, a hand-built `.bitmap` carrying only type streams
 * (no per-commit entries, so every want falls through to the pending-commit
 * walk this file is about), and — where an object must land OUTSIDE the
 * artefact's own position space — loose objects written straight into the
 * object store.
 */
import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  type LoadedPackBitmap,
  resolveBitmapClosure,
} from '../../../../../src/application/primitives/internal/bitmap-binding.js';
import { loadPackBitmapArtefact } from '../../../../../src/application/primitives/internal/pack-bitmap-binding.js';
import { getPackRegistry } from '../../../../../src/application/primitives/read-object.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import type {
  AuthorIdentity,
  Blob,
  Commit,
  FileMode,
  GitObject,
  ObjectId,
  Tag,
  Tree,
  TreeEntry,
} from '../../../../../src/domain/objects/index.js';
import { serializeObject } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';
import {
  type BitmapEntrySpec,
  type BitmapStreamSpec,
  buildBitmap,
} from '../../../domain/storage/arbitraries.js';
import { type EntrySpec, writeSyntheticBitmap, writeSyntheticPack } from '../pack-fixture.js';

const AUTHOR: AuthorIdentity = { name: 'A', email: 'a@a', timestamp: 0, timezoneOffset: '+0000' };
const enc = new TextEncoder();
const REGULAR_FILE = '100644' as FileMode;
const GITLINK = '160000' as FileMode;

/** A well-formed oid the object store deliberately does not carry: reaching
 *  for it is how a test proves a read never happened. */
const missingOid = (ctx: Context): ObjectId => 'ab'.repeat(ctx.hashConfig.digestLength) as ObjectId;

// ---------------------------------------------------------------------------
// Object and store helpers
// ---------------------------------------------------------------------------

function stripHeader(bytes: Uint8Array): Uint8Array {
  return bytes.subarray(bytes.indexOf(0) + 1);
}

async function idOf(ctx: Context, object: GitObject): Promise<ObjectId> {
  return (await ctx.hash.hashHex(serializeObject(object, ctx.hashConfig))) as ObjectId;
}

function rawContentOf(ctx: Context, object: GitObject): Uint8Array {
  return stripHeader(serializeObject(object, ctx.hashConfig));
}

const blobOf = (content: string): Blob => ({
  type: 'blob',
  id: '' as ObjectId,
  content: enc.encode(content),
});

const treeOf = (entries: ReadonlyArray<TreeEntry>): Tree => ({
  type: 'tree',
  id: '' as ObjectId,
  entries,
});

const commitOf = (tree: ObjectId, parents: ReadonlyArray<ObjectId>, message: string): Commit => ({
  type: 'commit',
  id: '' as ObjectId,
  data: { tree, parents, author: AUTHOR, committer: AUTHOR, message, extraHeaders: [] },
});

const tagOf = (object: ObjectId, tagName: string): Tag => ({
  type: 'tag',
  id: '' as ObjectId,
  data: {
    object,
    objectType: 'commit',
    tagName,
    tagger: AUTHOR,
    message: tagName,
    extraHeaders: [],
  },
});

const loosePathOf = (ctx: Context, id: ObjectId): string =>
  `${ctx.layout.gitDir}/objects/${id.slice(0, 2)}/${id.slice(2)}`;

async function writeLoose(ctx: Context, object: GitObject): Promise<ObjectId> {
  const bytes = serializeObject(object, ctx.hashConfig);
  const id = (await ctx.hash.hashHex(bytes)) as ObjectId;
  await ctx.fs.write(loosePathOf(ctx, id), await ctx.compressor.deflate(bytes));
  return id;
}

const baseEntry = (ctx: Context, object: GitObject): EntrySpec => ({
  kind: 'base',
  type: object.type,
  content: rawContentOf(ctx, object),
});

// ---------------------------------------------------------------------------
// Bitmap helpers — type streams only; no per-commit entry ever covers a want,
// so every closure below exercises the pending-commit walk end to end.
// ---------------------------------------------------------------------------

interface TypeStreamBits {
  readonly commits?: ReadonlyArray<number>;
  readonly trees?: ReadonlyArray<number>;
  readonly blobs?: ReadonlyArray<number>;
  readonly tags?: ReadonlyArray<number>;
}

function typeStreamsFor(
  objectCount: number,
  bits: TypeStreamBits,
): readonly [BitmapStreamSpec, BitmapStreamSpec, BitmapStreamSpec, BitmapStreamSpec] {
  const stream = (set: ReadonlyArray<number> | undefined): BitmapStreamSpec => ({
    bitSize: objectCount,
    bits: set ?? [],
  });
  return [stream(bits.commits), stream(bits.trees), stream(bits.blobs), stream(bits.tags)];
}

const packBitmapPath = (ctx: Context, name: string): string =>
  `${ctx.layout.gitDir}/objects/pack/pack-${name}.bitmap`;

async function writeBitmapFor(
  ctx: Context,
  name: string,
  objectCount: number,
  bits: TypeStreamBits,
  entries: ReadonlyArray<BitmapEntrySpec> = [],
): Promise<void> {
  const body = buildBitmap({
    optionFlags: 1,
    digestLength: ctx.hashConfig.digestLength,
    checksum: new Uint8Array(ctx.hashConfig.digestLength).fill(0xbb),
    typeStreams: typeStreamsFor(objectCount, bits),
    entries,
    trailingBytes: 0,
  });
  await writeSyntheticBitmap(ctx, packBitmapPath(ctx, name), body);
}

async function loadArtefact(ctx: Context): Promise<LoadedPackBitmap> {
  const [pack] = await getPackRegistry(ctx).all();
  if (pack === undefined) throw new Error('expected a registered pack');
  const artefact = await loadPackBitmapArtefact(ctx, pack);
  if (artefact === undefined) throw new Error('expected a usable bitmap artefact');
  return artefact;
}

/** A pack carrying one blob and one tree that names it, optionally with a
 *  gitlink entry beside it — pack positions 0 (blob) and 1 (tree). */
async function buildTreeTipFixture(
  name: string,
  withGitlink: boolean,
): Promise<{ readonly ctx: Context; readonly blobId: ObjectId; readonly treeId: ObjectId }> {
  const ctx = createMemoryContext();
  const blob = blobOf('leaf');
  const blobId = await idOf(ctx, blob);
  const entries: TreeEntry[] = [{ name: 'f.txt', mode: REGULAR_FILE, id: blobId }];
  if (withGitlink) entries.push({ name: 'sub', mode: GITLINK, id: missingOid(ctx) });
  const tree = treeOf(entries);
  const treeId = await idOf(ctx, tree);

  await writeSyntheticPack(ctx, name, [baseEntry(ctx, blob), baseEntry(ctx, tree)]);
  await writeBitmapFor(ctx, name, 2, { blobs: [0], trees: [1] });
  return { ctx, blobId, treeId };
}

/** A pack of two blobs — a valid artefact carrying nothing a test's own
 *  loose objects can collide with. */
async function buildLooseOnlyFixture(name: string): Promise<Context> {
  const ctx = createMemoryContext();
  await writeSyntheticPack(ctx, name, [baseEntry(ctx, blobOf('a')), baseEntry(ctx, blobOf('b'))]);
  await writeBitmapFor(ctx, name, 2, { blobs: [0, 1] });
  return ctx;
}

const idsOf = (
  result: ReadonlyArray<{ readonly id: ObjectId; readonly type: string }>,
): ReadonlyArray<ObjectId> => result.map((object) => object.id);

// ---------------------------------------------------------------------------
// Tip peeling — a tree tip resolves its whole subtree on the spot
// ---------------------------------------------------------------------------

describe('Given a want whose tip is a tree, not a commit', () => {
  describe('When the closure is resolved with objects', () => {
    it('Then the tree and every object under it are emitted, each with its own type', async () => {
      // Arrange
      const fixture = await buildTreeTipFixture('tree-tip', false);
      const artefact = await loadArtefact(fixture.ctx);
      const sut = resolveBitmapClosure;

      // Act
      const result = await sut(fixture.ctx, artefact, {
        wants: [fixture.treeId],
        not: [],
        objects: true,
      });

      // Assert
      expect(result).toEqual([
        { id: fixture.blobId, type: 'blob' },
        { id: fixture.treeId, type: 'tree' },
      ]);
    });
  });
});

describe('Given a walked tree carrying a gitlink beside a regular file', () => {
  describe('When the closure is resolved with objects', () => {
    it('Then the gitlink is skipped and never resolved as an object of this repository', async () => {
      // Arrange — the submodule commit is absent from the object store, so a
      // walk that failed to skip it would fault rather than merely over-report.
      const fixture = await buildTreeTipFixture('gitlink-tip', true);
      const artefact = await loadArtefact(fixture.ctx);
      const sut = resolveBitmapClosure;

      // Act
      const result = await sut(fixture.ctx, artefact, {
        wants: [fixture.treeId],
        not: [],
        objects: true,
      });

      // Assert
      expect(result).toEqual([
        { id: fixture.blobId, type: 'blob' },
        { id: fixture.treeId, type: 'tree' },
      ]);
    });
  });
});

describe('Given a want whose tip is an annotated tag over a commit', () => {
  describe('When the closure is resolved without objects', () => {
    it('Then the tag itself joins the answer, typed as a tag by the stream partition', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const emptyTreeId = await idOf(ctx, treeOf([]));
      const commit = commitOf(emptyTreeId, [], 'tagged');
      const commitId = await idOf(ctx, commit);
      const tag = tagOf(commitId, 'v1');
      const tagId = await idOf(ctx, tag);
      await writeSyntheticPack(ctx, 'tag-tip', [baseEntry(ctx, commit), baseEntry(ctx, tag)]);
      // Position 1 is claimed by no OTHER stream, which is what makes it a tag.
      await writeBitmapFor(ctx, 'tag-tip', 2, { commits: [0], tags: [1] });
      const artefact = await loadArtefact(ctx);
      const sut = resolveBitmapClosure;

      // Act
      const result = await sut(ctx, artefact, { wants: [tagId], not: [], objects: false });

      // Assert
      expect(result).toEqual([
        { id: commitId, type: 'commit' },
        { id: tagId, type: 'tag' },
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// The pending-commit walk
// ---------------------------------------------------------------------------

describe('Given a pending commit whose tree is absent from the object store', () => {
  describe('When the closure is resolved without objects', () => {
    it('Then the commit alone is answered — the tree is never reached for', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const commit = commitOf(missingOid(ctx), [], 'treeless');
      const commitId = await idOf(ctx, commit);
      await writeSyntheticPack(ctx, 'no-objects', [baseEntry(ctx, commit)]);
      await writeBitmapFor(ctx, 'no-objects', 1, { commits: [0] });
      const artefact = await loadArtefact(ctx);
      const sut = resolveBitmapClosure;

      // Act
      const result = await sut(ctx, artefact, { wants: [commitId], not: [], objects: false });

      // Assert
      expect(result).toEqual([{ id: commitId, type: 'commit' }]);
    });
  });
});

describe('Given a merge whose two sides converge on one already-queued base commit', () => {
  describe('When the closure is resolved', () => {
    it('Then the base is walked once, not once per side that queued it', async () => {
      // Arrange — every commit is loose, so each visit costs one read of its
      // own object file and the count is observable.
      const ctx = await buildLooseOnlyFixture('merge-walk');
      const emptyTreeId = await idOf(ctx, treeOf([]));
      const baseId = await writeLoose(ctx, commitOf(emptyTreeId, [], 'base'));
      const leftId = await writeLoose(ctx, commitOf(emptyTreeId, [baseId], 'left'));
      const rightId = await writeLoose(ctx, commitOf(emptyTreeId, [baseId], 'right'));
      const mergeId = await writeLoose(ctx, commitOf(emptyTreeId, [leftId, rightId], 'merge'));
      const basePath = loosePathOf(ctx, baseId);
      let baseReads = 0;
      const wrapped: Context = {
        ...ctx,
        fs: {
          ...ctx.fs,
          read: async (path: string) => {
            if (path === basePath) baseReads += 1;
            return ctx.fs.read(path);
          },
        },
      };
      const artefact = await loadArtefact(wrapped);
      const sut = resolveBitmapClosure;

      // Act
      const result = await sut(wrapped, artefact, { wants: [mergeId], not: [], objects: false });

      // Assert — one physical read while walking the ancestry; the later
      // read while typing the object for emission now hits the delta cache
      // that loose read populated (F2.3), so a re-walk of the base — which
      // would add a further physical read — is what this still catches.
      expect(baseReads).toBe(1);
      expect(new Set(idsOf(result))).toEqual(new Set([mergeId, leftId, rightId, baseId]));
    });
  });
});

// ---------------------------------------------------------------------------
// Extended positions — objects the artefact has no position for
// ---------------------------------------------------------------------------

describe('Given an extended-position object reached from both the wants and the not side', () => {
  describe('When the closure is resolved', () => {
    it('Then it is excluded — the difference is taken over extended positions too', async () => {
      // Arrange
      const ctx = await buildLooseOnlyFixture('extended-difference');
      const emptyTreeId = await idOf(ctx, treeOf([]));
      const looseCommitId = await writeLoose(ctx, commitOf(emptyTreeId, [], 'shared'));
      const artefact = await loadArtefact(ctx);
      const sut = resolveBitmapClosure;

      // Act
      const result = await sut(ctx, artefact, {
        wants: [looseCommitId],
        not: [looseCommitId],
        objects: false,
      });

      // Assert
      expect(result).toEqual([]);
    });
  });
});

describe('Given an extended-position blob wanted without objects', () => {
  describe('When the closure is resolved', () => {
    it('Then it is filtered out, exactly as an in-artefact blob would be', async () => {
      // Arrange
      const ctx = await buildLooseOnlyFixture('extended-type-filter');
      const looseBlobId = await writeLoose(ctx, blobOf('loose leaf'));
      const artefact = await loadArtefact(ctx);
      const sut = resolveBitmapClosure;

      // Act
      const result = await sut(ctx, artefact, {
        wants: [looseBlobId],
        not: [],
        objects: false,
      });

      // Assert
      expect(result).toEqual([]);
    });
  });
});

describe('Given more extended positions across one closure than the push limit allows', () => {
  describe('When the closure is resolved', () => {
    it('Then it refuses with PACK_TOO_LARGE while filling, before any object is emitted', async () => {
      // Arrange — the wants and the not side share ONE extended counter, so
      // the not side is what trips a bound the answer itself never reaches.
      vi.resetModules();
      vi.doMock('../../../../../src/application/primitives/types.js', async (importOriginal) => {
        const actual =
          await importOriginal<
            typeof import('../../../../../src/application/primitives/types.js')
          >();
        return { ...actual, MAX_PUSH_OBJECTS: 2 };
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
        const ctx = scopedCreateContext();
        await scopedWritePack(ctx, 'extended-bound', [
          baseEntry(ctx, blobOf('a')),
          baseEntry(ctx, blobOf('b')),
        ]);
        const body = buildBitmap({
          optionFlags: 1,
          digestLength: ctx.hashConfig.digestLength,
          checksum: new Uint8Array(ctx.hashConfig.digestLength).fill(0xbb),
          typeStreams: typeStreamsFor(2, { blobs: [0, 1] }),
          entries: [],
          trailingBytes: 0,
        });
        await scopedWriteBitmap(ctx, packBitmapPath(ctx, 'extended-bound'), body);

        const emptyTreeId = await idOf(ctx, treeOf([]));
        const wantedId = await writeLoose(ctx, commitOf(emptyTreeId, [], 'wanted'));
        const excludedRootId = await writeLoose(ctx, commitOf(emptyTreeId, [], 'excluded-root'));
        const excludedId = await writeLoose(
          ctx,
          commitOf(emptyTreeId, [excludedRootId], 'excluded'),
        );

        const [pack] = await scopedRegistry(ctx).all();
        const artefact = await scopedLoad(ctx, pack as NonNullable<typeof pack>);
        const sut = scopedResolve;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, artefact as LoadedPackBitmap, {
            wants: [wantedId],
            not: [excludedId],
            objects: false,
          });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError | undefined)?.data).toEqual({
          code: 'PACK_TOO_LARGE',
          objectCount: 3,
          limit: 2,
        });
      } finally {
        vi.doUnmock('../../../../../src/application/primitives/types.js');
        vi.resetModules();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// The word-wise emit — the last lane's mask
// ---------------------------------------------------------------------------

describe('Given an artefact whose object count fills its last lane exactly', () => {
  describe('When the closure is resolved over that lane', () => {
    it('Then every position in it is emitted — a full lane is masked in, not out', async () => {
      // Arrange — 31 blobs plus the tree naming them is exactly one 32-bit
      // lane, the boundary where the last lane is whole rather than partial.
      const ctx = createMemoryContext();
      const blobs = Array.from({ length: 31 }, (_unused, i) => blobOf(`leaf-${i}`));
      const blobIds = await Promise.all(blobs.map((blob) => idOf(ctx, blob)));
      const tree = treeOf(
        blobIds.map((id, i) => ({
          name: `b${String(i).padStart(2, '0')}`,
          mode: REGULAR_FILE,
          id,
        })),
      );
      const treeId = await idOf(ctx, tree);
      await writeSyntheticPack(ctx, 'full-lane', [
        ...blobs.map((blob) => baseEntry(ctx, blob)),
        baseEntry(ctx, tree),
      ]);
      await writeBitmapFor(ctx, 'full-lane', 32, {
        blobs: blobIds.map((_unused, i) => i),
        trees: [31],
      });
      const artefact = await loadArtefact(ctx);
      const sut = resolveBitmapClosure;

      // Act
      const result = await sut(ctx, artefact, { wants: [treeId], not: [], objects: true });

      // Assert
      expect(idsOf(result)).toEqual([...blobIds, treeId]);
    });
  });
});
