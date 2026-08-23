/**
 * Unit tests for the Tier-1 `packRefs` command — git's `pack-refs --all`,
 * always. Composes the `RefStore` seam's own `packRefs` verb; this file
 * exercises both backends through the SAME command entry point.
 *
 * Coverage:
 *  - files: two loose refs plus one already-packed ref all land in
 *    `packed-refs`, and the loose files that duplicate it are removed
 *  - files: a second run is a no-op — same bytes, nothing pruned
 *  - files: an empty repository is left byte-for-byte unchanged (no
 *    header-only `packed-refs` is written where none existed)
 *  - files: HEAD stays symbolic and loose — never packed
 *  - files: an annotated tag's packed-refs entry carries a peeled `^` line
 *  - reftable: a three-table stack compacts to one table
 *  - reftable: orphan `*.ref` / `*.temp` files are unlinked while every
 *    listed table survives
 *  - reftable: a deleted ref stays absent after a full compaction
 *    (tombstone elided, not resurrected)
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { packRefs } from '../../../../src/application/commands/pack-refs.js';
import { tagCreate } from '../../../../src/application/commands/tag.js';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import { tablesListPath } from '../../../../src/application/primitives/path-layout.js';
import { MAX_PEEL_DEPTH } from '../../../../src/application/primitives/types.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { AuthorIdentity, ObjectId, Tag } from '../../../../src/domain/objects/index.js';
import { ObjectId as ObjectIdFactory, RefName } from '../../../../src/domain/objects/index.js';
import {
  type ReftableLogRecord,
  type ReftableRefRecord,
  serializeReftable,
} from '../../../../src/domain/refs/index.js';
import {
  DEFAULT_BLOCK_SIZE,
  DEFAULT_RESTART_INTERVAL,
  type ReftableWriteOptions,
} from '../../../../src/domain/refs/reftable/reftable-writer.js';
import type { Context } from '../../../../src/ports/context.js';
import {
  commonReftableDir,
  withReftableStorage,
  writeReftableFiles,
} from '../primitives/reftable-fixtures.js';

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const gitDirOf = (ctx: Context): string => ctx.layout.gitDir;
const packedRefsPathOf = (ctx: Context): string => `${gitDirOf(ctx)}/packed-refs`;
const looseHeadsPathOf = (ctx: Context, name: string): string =>
  `${gitDirOf(ctx)}/refs/heads/${name}`;

interface SeededRepo {
  readonly ctx: Context;
  readonly commitId: ObjectId;
}

const seedOneCommit = async (): Promise<SeededRepo> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'hello');
  await add(ctx, ['a.txt']);
  const { id: commitId } = await commit(ctx, { message: 'seed', author: AUTHOR });
  return { ctx, commitId };
};

/** A reftable-backed repository, bootstrapped through the real `init` so
 *  `assertOperationalRepository` (HEAD, config) is satisfied — the fixture
 *  tables are then planted directly, bypassing the write protocol. */
const seedReftableRepo = async (): Promise<Context> => {
  const ctx = withReftableStorage(createMemoryContext());
  await init(ctx);
  return ctx;
};

describe('packRefs — files backend', () => {
  describe('Given a files repository with two loose refs and one already-packed ref', () => {
    describe('When packRefs runs', () => {
      it('Then all three appear in packed-refs and the loose files are gone', async () => {
        // Arrange
        const { ctx, commitId } = await seedOneCommit();
        await ctx.fs.writeUtf8(
          packedRefsPathOf(ctx),
          `# pack-refs with: peeled fully-peeled sorted \n${commitId} refs/heads/archived\n`,
        );
        await branchCreate(ctx, { name: 'feature' });
        const sut = packRefs;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual({
          packedRefCount: 3,
          prunedLooseRefCount: 2,
          removedOrphanCount: 0,
        });
        const packed = await ctx.fs.readUtf8(packedRefsPathOf(ctx));
        expect(packed).toContain('refs/heads/archived');
        expect(packed).toContain('refs/heads/main');
        expect(packed).toContain('refs/heads/feature');
        expect(await ctx.fs.exists(looseHeadsPathOf(ctx, 'main'))).toBe(false);
        expect(await ctx.fs.exists(looseHeadsPathOf(ctx, 'feature'))).toBe(false);
      });
    });
  });

  describe('Given a files repository already packed once', () => {
    describe('When packRefs runs again with nothing new to pack', () => {
      it('Then the second run is a no-op — same packed-refs bytes, nothing pruned', async () => {
        // Arrange
        const { ctx } = await seedOneCommit();
        await branchCreate(ctx, { name: 'feature' });
        const sut = packRefs;
        await sut(ctx);
        const before = await ctx.fs.readUtf8(packedRefsPathOf(ctx));

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.prunedLooseRefCount).toBe(0);
        expect(result.packedRefCount).toBe(2);
        const after = await ctx.fs.readUtf8(packedRefsPathOf(ctx));
        expect(after).toBe(before);
      });
    });
  });

  describe('Given a freshly initialised files repository with no refs', () => {
    describe('When packRefs runs', () => {
      it('Then the repository is unchanged — no packed-refs file is written', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const sut = packRefs;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual({
          packedRefCount: 0,
          prunedLooseRefCount: 0,
          removedOrphanCount: 0,
        });
        expect(await ctx.fs.exists(packedRefsPathOf(ctx))).toBe(false);
      });
    });
  });

  describe('Given a files repository with commits', () => {
    describe('When packRefs runs', () => {
      it('Then HEAD stays symbolic and loose, never packed', async () => {
        // Arrange
        const { ctx } = await seedOneCommit();
        const sut = packRefs;

        // Act
        await sut(ctx);

        // Assert
        expect(await ctx.fs.readUtf8(`${gitDirOf(ctx)}/HEAD`)).toBe('ref: refs/heads/main\n');
        const packed = await ctx.fs.readUtf8(packedRefsPathOf(ctx));
        expect(packed).not.toContain('HEAD');
      });
    });
  });

  describe('Given an annotated tag', () => {
    describe('When packRefs runs', () => {
      it('Then the packed-refs entry carries the peeled commit oid on its own ^ line', async () => {
        // Arrange
        const { ctx } = await seedOneCommit();
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[user]\n  name = Grace\n  email = grace@example.com\n',
        );
        __resetConfigCacheForTests();
        const created = await tagCreate(ctx, { name: 'v1', message: 'release' });
        const sut = packRefs;

        // Act
        await sut(ctx);

        // Assert
        const packed = await ctx.fs.readUtf8(packedRefsPathOf(ctx));
        const lines = packed.split('\n');
        const tagLineIndex = lines.findIndex((line) => line.endsWith('refs/tags/v1'));
        expect(tagLineIndex).toBeGreaterThan(-1);
        expect(lines[tagLineIndex]).toBe(`${created.id} refs/tags/v1`);
        expect(lines[tagLineIndex + 1]?.startsWith('^')).toBe(true);
      });
    });
  });

  describe('Given a tag chain at exactly MAX_PEEL_DEPTH pointing at a commit', () => {
    describe('When packRefs runs', () => {
      it('Then it succeeds and the packed-refs entry carries the commit as the peeled oid', async () => {
        // Arrange — kills the `depth > MAX_PEEL_DEPTH` EqualityOperator `>=`
        // mutant on `ref-store.ts`'s OWN `peelToNonTag` (pack-refs' peel
        // walk), distinct from `resolve-ref.ts`'s own bound.
        const { ctx, commitId } = await seedOneCommit();
        const chainTip = await buildTagChain(ctx, MAX_PEEL_DEPTH, commitId);
        await ctx.fs.writeUtf8(`${gitDirOf(ctx)}/refs/tags/chain`, `${chainTip}\n`);
        const sut = packRefs;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.packedRefCount).toBeGreaterThan(0);
        const packed = await ctx.fs.readUtf8(packedRefsPathOf(ctx));
        const lines = packed.split('\n');
        const tagLineIndex = lines.findIndex((line) => line.endsWith('refs/tags/chain'));
        expect(tagLineIndex).toBeGreaterThan(-1);
        expect(lines[tagLineIndex]).toBe(`${chainTip} refs/tags/chain`);
        expect(lines[tagLineIndex + 1]).toBe(`^${commitId}`);
      });
    });
  });

  describe('Given a tag chain exceeding MAX_PEEL_DEPTH', () => {
    describe('When packRefs runs', () => {
      it('Then it throws REF_CHAIN_TOO_DEEP with the depth at which the walk stopped', async () => {
        // Arrange — one hop past the cap: the walk counter, not a
        // coincidence of chain length, is what stops it.
        const { ctx, commitId } = await seedOneCommit();
        const chainTip = await buildTagChain(ctx, MAX_PEEL_DEPTH + 1, commitId);
        await ctx.fs.writeUtf8(`${gitDirOf(ctx)}/refs/tags/deep`, `${chainTip}\n`);
        const sut = packRefs;

        // Act — captured OUTSIDE the try: an `expect.unreachable()` thrown
        // inside it would be swallowed by this same `catch` and resurface as
        // a confusing downstream TypeError instead of the intended message.
        let caught: unknown;
        try {
          await sut(ctx);
        } catch (err) {
          caught = err;
        }
        if (caught === undefined) expect.unreachable();

        // Assert
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('REF_CHAIN_TOO_DEEP');
        if (data.code === 'REF_CHAIN_TOO_DEEP') {
          expect(data.depth).toBe(MAX_PEEL_DEPTH + 1);
        }
      });
    });
  });
});

/** `length` tags chained onto `base` (a commit): tag 0 points at `base`, tag
 *  1 at tag 0, and so on — the same shape `read-tree.test.ts`'s own
 *  MAX_PEEL_DEPTH fixtures use, reused here against `ref-store.ts`'s
 *  separate `peelToNonTag` (the pack-refs peel walk). */
async function buildTagChain(ctx: Context, length: number, base: ObjectId): Promise<ObjectId> {
  let currentId = base;
  let currentType: 'commit' | 'tag' = 'commit';
  for (let i = 0; i < length; i += 1) {
    const tag: Tag = {
      type: 'tag',
      id: '' as ObjectId,
      data: {
        object: currentId,
        objectType: currentType,
        tagName: `chain${i}`,
        tagger: AUTHOR,
        message: `t${i}`,
        extraHeaders: [],
      },
    };
    currentId = await writeObject(ctx, tag);
    currentType = 'tag';
  }
  return currentId;
}

const oid = (fill: number): ObjectId => ObjectIdFactory.fromRaw(new Uint8Array(20).fill(fill));

const liveRef = (name: string, idFill: number, updateIndex: number): ReftableRefRecord => ({
  name: RefName.from(name),
  updateIndex: BigInt(updateIndex),
  value: { kind: 'direct', id: oid(idFill) },
});

const tombstoneRef = (name: string, updateIndex: number): ReftableRefRecord => ({
  name: RefName.from(name),
  updateIndex: BigInt(updateIndex),
  value: { kind: 'deletion' },
});

async function buildFixtureTable(
  ctx: Context,
  refs: readonly ReftableRefRecord[],
  logs: readonly ReftableLogRecord[],
  minUpdateIndex: bigint,
  maxUpdateIndex: bigint,
): Promise<Uint8Array> {
  const options: ReftableWriteOptions = {
    hashId: 'sha1',
    blockSize: DEFAULT_BLOCK_SIZE,
    restartInterval: DEFAULT_RESTART_INTERVAL,
    indexObjects: true,
    minUpdateIndex,
    maxUpdateIndex,
  };
  return serializeReftable(refs, logs, options, ctx.compressor.deflate);
}

describe('packRefs — reftable backend', () => {
  describe('Given a reftable stack with three small tables', () => {
    describe('When packRefs runs', () => {
      it('Then the whole stack compacts to one table', async () => {
        // Arrange
        const ctx = await seedReftableRepo();
        const dir = commonReftableDir(ctx);
        const t1 = await buildFixtureTable(ctx, [liveRef('refs/heads/a', 1, 1)], [], 1n, 1n);
        const t2 = await buildFixtureTable(ctx, [liveRef('refs/heads/b', 2, 2)], [], 2n, 2n);
        const t3 = await buildFixtureTable(ctx, [liveRef('refs/heads/c', 3, 3)], [], 3n, 3n);
        await writeReftableFiles(ctx, dir, [
          { name: 't1.ref', bytes: t1 },
          { name: 't2.ref', bytes: t2 },
          { name: 't3.ref', bytes: t3 },
        ]);
        const sut = packRefs;

        // Act
        const result = await sut(ctx);

        // Assert
        const namesAfter = (await ctx.fs.readUtf8(tablesListPath(ctx.layout.gitDir)))
          .trim()
          .split('\n');
        expect(namesAfter).toHaveLength(1);
        expect(result.packedRefCount).toBe(3);
        expect(result.prunedLooseRefCount).toBe(0);
      });
    });
  });

  describe('Given orphan *.ref and *.temp files in the reftable directory', () => {
    describe('When packRefs runs', () => {
      it('Then the orphans are unlinked while every listed table survives', async () => {
        // Arrange
        const ctx = await seedReftableRepo();
        const dir = commonReftableDir(ctx);
        const t1 = await buildFixtureTable(ctx, [liveRef('refs/heads/a', 1, 1)], [], 1n, 1n);
        await writeReftableFiles(ctx, dir, [{ name: 't1.ref', bytes: t1 }]);
        await ctx.fs.write(`${dir}/0x000000000099-0x000000000099-deadbeef.ref`, t1);
        await ctx.fs.write(`${dir}/0x000000000099-0x000000000099-cafebabe.temp`, t1);
        const sut = packRefs;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.removedOrphanCount).toBe(2);
        expect(await ctx.fs.exists(`${dir}/0x000000000099-0x000000000099-deadbeef.ref`)).toBe(
          false,
        );
        expect(await ctx.fs.exists(`${dir}/0x000000000099-0x000000000099-cafebabe.temp`)).toBe(
          false,
        );
        const namesAfter = (await ctx.fs.readUtf8(tablesListPath(ctx.layout.gitDir)))
          .trim()
          .split('\n');
        for (const name of namesAfter) {
          expect(await ctx.fs.exists(`${dir}/${name}`)).toBe(true);
        }
      });
    });
  });

  describe('Given a directory (not a file) inside the reftable directory named like an orphan table', () => {
    describe('When packRefs runs', () => {
      it('Then the directory is left alone — never mistaken for a stray table file', async () => {
        // Arrange — nothing on disk prevents a directory from landing under
        // `.git/reftable/` (a stray tool, a manual mkdir); `isOrphanCandidate`
        // matches purely on name suffix, so only the sweep's own
        // `entry.isDirectory` guard stops this from being unlinked as though
        // it were a genuine `*.ref` file.
        const ctx = await seedReftableRepo();
        const dir = commonReftableDir(ctx);
        const t1 = await buildFixtureTable(ctx, [liveRef('refs/heads/a', 1, 1)], [], 1n, 1n);
        await writeReftableFiles(ctx, dir, [{ name: 't1.ref', bytes: t1 }]);
        const strayDir = `${dir}/0x000000000099-0x000000000099-deadbeef.ref`;
        await ctx.fs.mkdir(strayDir);
        const sut = packRefs;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.removedOrphanCount).toBe(0);
        expect(await ctx.fs.exists(strayDir)).toBe(true);
      });
    });
  });

  describe('Given a directory named like a *.ref.lock file alongside an orphan *.temp file', () => {
    describe('When packRefs runs', () => {
      it('Then the directory is never read as a compaction-in-flight signal — the temp file is still swept', async () => {
        // Arrange — the compaction-in-flight check matches purely on name
        // suffix too; only `!entry.isDirectory` stops a same-suffixed
        // directory from falsely signalling a mid-flight compaction and
        // suppressing this pass's `*.temp` cleanup.
        const ctx = await seedReftableRepo();
        const dir = commonReftableDir(ctx);
        const t1 = await buildFixtureTable(ctx, [liveRef('refs/heads/a', 1, 1)], [], 1n, 1n);
        await writeReftableFiles(ctx, dir, [{ name: 't1.ref', bytes: t1 }]);
        const tempPath = `${dir}/0x000000000099-0x000000000099-cafebabe.temp`;
        await ctx.fs.write(tempPath, t1);
        await ctx.fs.mkdir(`${dir}/0x000000000042-0x000000000042-aaaaaaaa.ref.lock`);
        const sut = packRefs;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.removedOrphanCount).toBe(1);
        expect(await ctx.fs.exists(tempPath)).toBe(false);
      });
    });
  });

  describe('Given an orphan *.temp file alongside a stray *.ref.lock file', () => {
    describe('When packRefs runs', () => {
      it('Then the temp file survives this pass — a *.ref.lock signals a compaction might be mid-flight', async () => {
        // Arrange — the lock's OWN table name is irrelevant; its mere
        // presence in the directory is the sweep's only signal, since a
        // compaction's temp file carries no lock of its own to match
        // against by name.
        const ctx = await seedReftableRepo();
        const dir = commonReftableDir(ctx);
        const t1 = await buildFixtureTable(ctx, [liveRef('refs/heads/a', 1, 1)], [], 1n, 1n);
        await writeReftableFiles(ctx, dir, [{ name: 't1.ref', bytes: t1 }]);
        await ctx.fs.write(`${dir}/0x000000000099-0x000000000099-cafebabe.temp`, t1);
        await ctx.fs.writeExclusive(
          `${dir}/0x000000000042-0x000000000042-aaaaaaaa.ref.lock`,
          new Uint8Array(0),
        );
        const sut = packRefs;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.removedOrphanCount).toBe(0);
        expect(await ctx.fs.exists(`${dir}/0x000000000099-0x000000000099-cafebabe.temp`)).toBe(
          true,
        );
      });
    });
  });

  describe('Given an older table with a live ref and a newer table that tombstones it', () => {
    describe('When packRefs runs', () => {
      it('Then the deleted ref stays absent after a full compaction', async () => {
        // Arrange
        const ctx = await seedReftableRepo();
        const dir = commonReftableDir(ctx);
        const older = await buildFixtureTable(
          ctx,
          [liveRef('refs/heads/gone', 1, 1), liveRef('refs/heads/kept', 2, 1)],
          [],
          1n,
          1n,
        );
        const newer = await buildFixtureTable(
          ctx,
          [tombstoneRef('refs/heads/gone', 2)],
          [],
          2n,
          2n,
        );
        await writeReftableFiles(ctx, dir, [
          { name: 'older.ref', bytes: older },
          { name: 'newer.ref', bytes: newer },
        ]);
        const sut = packRefs;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.packedRefCount).toBe(1);
        const namesAfter = (await ctx.fs.readUtf8(tablesListPath(ctx.layout.gitDir)))
          .trim()
          .split('\n');
        expect(namesAfter).toHaveLength(1);
      });
    });
  });
});
