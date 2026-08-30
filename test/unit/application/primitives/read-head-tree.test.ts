import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import * as flattenTreeMod from '../../../../src/application/primitives/flatten-tree.js';
import {
  FLAT_TREE_CACHE_FRACTION,
  FLAT_TREE_CACHE_MAX_ENTRIES,
  flatTreeByteSize,
  readHeadTree,
} from '../../../../src/application/primitives/read-head-tree.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { FlatTree } from '../../../../src/domain/diff/flat-tree.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { AuthorIdentity, FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
import type { LruCache } from '../../../../src/domain/storage/index.js';
import { seedMaxTreeDepth } from './fixtures.js';

vi.mock('../../../../src/domain/storage/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/domain/storage/index.js')>();
  return { ...actual, createLruCache: vi.fn(actual.createLruCache) };
});

const storage = await import('../../../../src/domain/storage/index.js');
const createLruCacheSpy = vi.mocked(storage.createLruCache);

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

// `flattenTreeMod.flattenTree` is a module-namespace export shared by every
// test in this describe — Vitest's ESM `vi.spyOn`/`mockRestore` cycle does
// not reliably zero `.mock.calls` between successive spy/restore pairs on
// the same property, so every assertion below counts calls made SINCE a
// captured baseline rather than trusting an absolute total.
function flattenCallsSince(spy: ReturnType<typeof vi.spyOn>, baseline: number): number {
  return spy.mock.calls.length - baseline;
}

async function commitOneFile(ctx: ReturnType<typeof createMemoryContext>): Promise<void> {
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
  await add(ctx, ['a.txt']);
  await commit(ctx, { message: 'first', author });
}

describe('readHeadTree', () => {
  describe('Given an unborn HEAD (no commits yet)', () => {
    describe('When readHeadTree runs', () => {
      it('Then it returns undefined', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);

        // Act
        const result = await readHeadTree(ctx);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a committed HEAD with a nested tree', () => {
    describe('When readHeadTree runs', () => {
      it('Then it returns a FlatTree of leaf blobs keyed by full path', async () => {
        // Arrange — src/a.txt + b.txt committed; the `src` directory entry must be
        // flattened away, leaving only the two leaf blobs.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/src/a.txt`, 'a');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
        await add(ctx, ['src/a.txt', 'b.txt']);
        await commit(ctx, { message: 'first', author });

        // Act
        const result = await readHeadTree(ctx);

        // Assert — exactly the two leaves, full-path keyed, regular mode, no `src`.
        expect(result?.entries.size).toBe(2);
        expect(result?.entries.get('a.txt' as FilePath)).toBeUndefined();
        expect(result?.entries.get('src' as FilePath)).toBeUndefined();
        const leaf = result?.entries.get('src/a.txt' as FilePath);
        expect(leaf?.mode).toBe(FILE_MODE.REGULAR);
        expect(leaf?.id).toMatch(/^[0-9a-f]{40}$/);
        expect(result?.entries.get('b.txt' as FilePath)?.mode).toBe(FILE_MODE.REGULAR);
      });
    });
  });

  describe('Given HEAD resolving to a non-commit object', () => {
    describe('When readHeadTree runs', () => {
      it('Then it throws UNEXPECTED_OBJECT_TYPE with expected=commit', async () => {
        // Arrange — point refs/heads/main at the committed tree oid (a real object,
        // but a tree, not a commit), so resolveRef('HEAD') peels to a non-commit.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'first', author });
        const head = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`);
        const ref = head.replace('ref: ', '').trim();
        const commitOid = (await ctx.fs.readUtf8(`${ctx.layout.gitDir}/${ref}`)).trim();
        const commitObj = await readObject(ctx, commitOid as ObjectId);
        const treeOid = commitObj.type === 'commit' ? commitObj.data.tree : '';
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${ref}`, `${treeOid}\n`);

        // Act + Assert — specific data, not just the class.
        try {
          await readHeadTree(ctx);
          expect.unreachable('readHeadTree should reject a non-commit HEAD');
        } catch (err) {
          expect((err as { data: { code: string } }).data.code).toBe('UNEXPECTED_OBJECT_TYPE');
          expect((err as { data: { expected: string } }).data.expected).toBe('commit');
          expect((err as { data: { actual: string } }).data.actual).toBe('tree');
          expect((err as { data: { id: string } }).data.id).toBe(treeOid);
        }
      });
    });
  });

  describe('Given two status-shaped reads of the same HEAD', () => {
    describe('When readHeadTree runs twice', () => {
      it('Then the tree is flattened once', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await commitOneFile(ctx);
        const flattenSpy = vi.spyOn(flattenTreeMod, 'flattenTree');
        const baseline = flattenSpy.mock.calls.length;

        // Act
        const first = await readHeadTree(ctx);
        const second = await readHeadTree(ctx);

        // Assert
        expect(second).toEqual(first);
        expect(flattenCallsSince(flattenSpy, baseline)).toBe(1);
        flattenSpy.mockRestore();
      });
    });
  });

  describe('Given core.maxTreeDepth changed between two reads', () => {
    describe('When readHeadTree runs before and after the change', () => {
      it('Then the tree is re-flattened', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await commitOneFile(ctx);
        const flattenSpy = vi.spyOn(flattenTreeMod, 'flattenTree');
        const baseline = flattenSpy.mock.calls.length;

        // Act
        await readHeadTree(ctx);
        await seedMaxTreeDepth(ctx, '10');
        await readHeadTree(ctx);

        // Assert — an oid-only key would have served the first read's cached
        // entry here; the depth component in the key forces a fresh flatten.
        expect(flattenCallsSince(flattenSpy, baseline)).toBe(2);
        flattenSpy.mockRestore();
      });
    });
  });

  describe('Given a HEAD tree larger than the byte cap', () => {
    describe('When readHeadTree runs twice', () => {
      it('Then it is not cached and both reads still succeed', async () => {
        // Arrange — a 1-byte deltaCache budget floors the flat-tree cache's
        // own cap below any real FlatTree, so this entry is always over-cap.
        const ctx = createMemoryContext({ deltaCacheMaxBytes: 1 });
        await commitOneFile(ctx);
        const flattenSpy = vi.spyOn(flattenTreeMod, 'flattenTree');
        const baseline = flattenSpy.mock.calls.length;

        // Act
        const first = await readHeadTree(ctx);
        const second = await readHeadTree(ctx);

        // Assert — never cached, so every read re-flattens.
        expect(second).toEqual(first);
        expect(flattenCallsSince(flattenSpy, baseline)).toBe(2);
        flattenSpy.mockRestore();
      });
    });
  });

  describe('Given two Contexts sharing one session — one with caching disabled (zero deltaCache budget), one with a normal budget', () => {
    describe('When the disabled Context reads first, then the enabled Context reads twice', () => {
      it('Then the enabled Context still caches on its second read — the disabled read never poisons the shared cache slot', async () => {
        // Arrange — mirrors fsck's audit Context: it shares ctx.session with
        // the opening Context but carries a zero-budget deltaCache.
        // deltaBaseCachingEnabled must gate flatTreeCacheFor off ENTIRELY for
        // the disabled Context, never registering anything under the shared
        // session — otherwise a permanently-zero-budget cache object would
        // get memoised there and the enabled Context would inherit it,
        // unable to ever cache.
        const enabledCtx = createMemoryContext();
        await commitOneFile(enabledCtx);
        const disabledCtx = {
          ...enabledCtx,
          deltaCache: { ...enabledCtx.deltaCache, maxSize: 0 },
        };
        const flattenSpy = vi.spyOn(flattenTreeMod, 'flattenTree');
        const baseline = flattenSpy.mock.calls.length;

        // Act
        await readHeadTree(disabledCtx);
        await readHeadTree(enabledCtx);
        await readHeadTree(enabledCtx);

        // Assert — the disabled read always re-flattens (1 call); the
        // enabled Context's two reads flatten once then hit its own cache
        // (1 more call) — 2 total, never 3.
        expect(flattenCallsSince(flattenSpy, baseline)).toBe(2);
        flattenSpy.mockRestore();
      });
    });
  });

  describe('Given an empty HEAD tree', () => {
    describe('When readHeadTree runs twice', () => {
      it('Then the fixed base overhead keeps the size positive, set does not throw, and the second read hits the cache', async () => {
        // Arrange — a first commit over an untouched index has no parent
        // tree to compare against, so it commits the empty tree, whose
        // per-entry footprint sums to exactly 0; FLAT_TREE_BASE_OVERHEAD_BYTES
        // alone must keep the sizer's result positive.
        const ctx = createMemoryContext();
        await init(ctx);
        await commit(ctx, { message: 'empty', author, allowEmpty: true });
        const flattenSpy = vi.spyOn(flattenTreeMod, 'flattenTree');
        const baseline = flattenSpy.mock.calls.length;

        // Act
        const first = await readHeadTree(ctx);
        const second = await readHeadTree(ctx);

        // Assert — no throw reached this line, and the entry is genuinely
        // cached rather than silently dropped.
        expect(first?.entries.size).toBe(0);
        expect(second?.entries.size).toBe(0);
        expect(flattenCallsSince(flattenSpy, baseline)).toBe(1);
        flattenSpy.mockRestore();
      });
    });
  });

  describe('Given a HEAD tree containing a gitlink', () => {
    describe('When readHeadTree runs twice', () => {
      it('Then the cached FlatTree still carries the 160000 entry', async () => {
        // Arrange — hand-built tree/commit: a gitlink's target oid is never
        // read by flatten, so any well-formed oid string stands in for a
        // real submodule commit.
        const ctx = createMemoryContext();
        await init(ctx);
        const gitlinkTarget = '1234567890abcdef1234567890abcdef12345678' as ObjectId;
        const treeId = await writeObject(ctx, {
          type: 'tree',
          id: '' as ObjectId,
          entries: [treeEntry(FILE_MODE.GITLINK, 'sub', gitlinkTarget)],
        });
        const commitId = await writeObject(ctx, {
          type: 'commit',
          id: '' as ObjectId,
          data: {
            tree: treeId,
            parents: [],
            author,
            committer: author,
            message: 'gitlink',
            extraHeaders: [],
          },
        });
        const head = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`);
        const ref = head.replace('ref: ', '').trim();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${ref}`, `${commitId}\n`);

        // Act
        const first = await readHeadTree(ctx);
        const second = await readHeadTree(ctx);

        // Assert — the gitlink entry survives both the raw flatten and the
        // cached return.
        expect(first?.entries.get('sub' as FilePath)).toEqual({
          id: gitlinkTarget,
          mode: FILE_MODE.GITLINK,
        });
        expect(second?.entries.get('sub' as FilePath)).toEqual({
          id: gitlinkTarget,
          mode: FILE_MODE.GITLINK,
        });
      });
    });
  });

  describe('Given HEAD moves between two calls', () => {
    describe('When readHeadTree runs before and after the move', () => {
      it('Then the new tree is flattened', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await commitOneFile(ctx);
        const flattenSpy = vi.spyOn(flattenTreeMod, 'flattenTree');
        const baseline = flattenSpy.mock.calls.length;

        // Act
        const first = await readHeadTree(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
        await add(ctx, ['b.txt']);
        await commit(ctx, { message: 'second', author });
        const second = await readHeadTree(ctx);

        // Assert
        expect(first?.entries.size).toBe(1);
        expect(second?.entries.size).toBe(2);
        expect(flattenCallsSince(flattenSpy, baseline)).toBe(2);
        flattenSpy.mockRestore();
      });
    });
  });

  describe('Given the sizer applied to trees differing only in entry count', () => {
    describe('When comparing a one-entry tree against the empty tree', () => {
      it('Then the difference includes the fixed per-entry overhead, not just the raw path+oid character counts', () => {
        // Arrange — same path/oid character counts either way; the fixed
        // per-entry overhead is what a raw-character-count-only sizer would
        // miss entirely.
        const path = 'a' as FilePath;
        const id = 'b'.repeat(40) as ObjectId;
        const empty: FlatTree = { entries: new Map() };
        const oneEntry: FlatTree = {
          entries: new Map([[path, { id, mode: FILE_MODE.REGULAR }]]),
        };
        const sut = flatTreeByteSize;

        // Act
        const emptySize = sut(empty);
        const oneEntrySize = sut(oneEntry);

        // Assert — the delta is strictly greater than the raw character
        // count (1 + 40 = 41): a sizer that only summed characters would
        // report exactly 41 here.
        const rawCharacterCount = path.length + id.length;
        expect(oneEntrySize - emptySize).toBeGreaterThan(rawCharacterCount);
      });
    });

    describe('When path and oid lengths differ (oid longer than path)', () => {
      it('Then the per-entry delta is path.length PLUS oid.length, not their difference', () => {
        // Arrange — id (40 chars) far exceeds path (1 char): a `-` in place
        // of the `+` between them would still land above the FLAT_TREE_
        // ENTRY_OVERHEAD_BYTES floor, so this pins the exact delta rather
        // than a loose lower bound.
        const path = 'a' as FilePath;
        const id = 'b'.repeat(40) as ObjectId;
        const empty: FlatTree = { entries: new Map() };
        const oneEntry: FlatTree = {
          entries: new Map([[path, { id, mode: FILE_MODE.REGULAR }]]),
        };

        // Act
        const delta = flatTreeByteSize(oneEntry) - flatTreeByteSize(empty);

        // Assert — path.length(1) + id.length(40) + per-entry overhead(110)
        expect(delta).toBe(path.length + id.length + 110);
      });
    });
  });

  describe('Given the flat-tree cache is created for the first time', () => {
    describe('When createLruCache is called to build it', () => {
      it('Then it is given an entry cap, not just a byte cap', async () => {
        // Arrange — a byte cap alone admits unboundedly many small trees;
        // the entry cap is a second, independent defence.
        const ctx = createMemoryContext();
        createLruCacheSpy.mockClear();
        await commitOneFile(ctx);

        // Act
        await readHeadTree(ctx);

        // Assert
        const memoCall = createLruCacheSpy.mock.calls.find(
          (call) => call[0] === ctx.deltaCache.maxSize * FLAT_TREE_CACHE_FRACTION,
        );
        expect(memoCall?.[1]).toBe(FLAT_TREE_CACHE_MAX_ENTRIES);
      });
    });
  });

  describe('Given a deltaCache sized so a real one-entry tree fits the multiplied share but not a 16×-larger divided one', () => {
    describe('When readHeadTree runs twice', () => {
      it('Then it is not cached — the share is a FRACTION of the deltaCache budget, not a multiple of it', async () => {
        // Arrange — 1000-byte deltaCache: the correct 1/16 share (62.5
        // bytes) is far smaller than any real one-entry FlatTree (~200
        // bytes), so real code never caches it. A 16×-inflated share
        // (maxSize / FLAT_TREE_CACHE_FRACTION = 16000 bytes) would
        // comfortably fit the same tree and wrongly cache it.
        const ctx = createMemoryContext({ deltaCacheMaxBytes: 1000 });
        await commitOneFile(ctx);
        const flattenSpy = vi.spyOn(flattenTreeMod, 'flattenTree');
        const baseline = flattenSpy.mock.calls.length;

        // Act
        const first = await readHeadTree(ctx);
        const second = await readHeadTree(ctx);

        // Assert — never cached, so every read re-flattens.
        expect(second).toEqual(first);
        expect(flattenCallsSince(flattenSpy, baseline)).toBe(2);
        flattenSpy.mockRestore();
      });
    });
  });

  describe('Given a deltaCache sized so the byte budget never binds', () => {
    describe('When more entries than FLAT_TREE_CACHE_MAX_ENTRIES are inserted', () => {
      it('Then the entry cap itself evicts down to the cap, not the byte budget', async () => {
        // Arrange — a deltaCache large enough that the cache's own byte
        // share never binds at FLAT_TREE_CACHE_MAX_ENTRIES tiny entries;
        // only the entry-count cap can be what evicts. Direct `.set()` calls
        // on the cache itself (grabbed off the createLruCache spy's own
        // return value) keep this fast — flattening
        // FLAT_TREE_CACHE_MAX_ENTRIES + 1 distinct real HEAD trees would be
        // impractical.
        const ctx = createMemoryContext({
          deltaCacheMaxBytes: FLAT_TREE_CACHE_MAX_ENTRIES * 100,
        });
        createLruCacheSpy.mockClear();
        await commitOneFile(ctx);
        await readHeadTree(ctx);
        // THREE distinct caches share this exact 65_536 entry cap by design
        // (each module's own doc cross-references the others): the pack
        // registry's delta-base cache (`pack-registry.ts`, constructed
        // EAGERLY the moment `readObject` first calls `getPackRegistry`,
        // before it ever resolves the object), object-resolver's
        // parsed-object memo (populated resolving that same commit), and
        // read-head-tree's own flat-tree cache. A bare `findIndex` on
        // `call[1]` grabs whichever spawns FIRST — the delta-base cache,
        // never the flat-tree one. The flat-tree cache is always the LAST
        // of the three: `flatTreeCacheFor` is only ever called, within
        // `readHeadTree`, after the HEAD commit read that triggers the
        // other two. Asserting the count pins that structural ordering
        // instead of silently trusting it, and picks the LAST match rather
        // than the first.
        const matchingCallIndexes = createLruCacheSpy.mock.calls.reduce<number[]>(
          (acc, call, index) => {
            if (call[1] === FLAT_TREE_CACHE_MAX_ENTRIES) acc.push(index);
            return acc;
          },
          [],
        );
        expect(matchingCallIndexes).toHaveLength(3);
        const memoCallIndex = matchingCallIndexes.at(-1) as number;
        const cache = createLruCacheSpy.mock.results[memoCallIndex]?.value as LruCache<FlatTree>;
        const dummy: FlatTree = { entries: new Map() };

        // Act
        for (let i = 0; i <= FLAT_TREE_CACHE_MAX_ENTRIES; i += 1) {
          cache.set(`synthetic-${i}`, dummy, 1);
        }

        // Assert — capped at the entry count; the byte budget (far larger
        // than FLAT_TREE_CACHE_MAX_ENTRIES tiny 1-byte entries) never bound.
        expect(cache.entryCount).toBe(FLAT_TREE_CACHE_MAX_ENTRIES);
      });
    });
  });
});
