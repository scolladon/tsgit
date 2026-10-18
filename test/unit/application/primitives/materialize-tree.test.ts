import { describe, expect, it } from 'vitest';

import { materializeTree } from '../../../../src/application/primitives/materialize-tree.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { GitIndex, IndexEntry } from '../../../../src/domain/git-index/index.js';
import { STAGE0_FLAGS } from '../../../../src/domain/git-index/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId, TreeEntry } from '../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
import { scriptedCommandRunner } from '../../../fixtures/scripted-command-runner.js';
import { recordingProgress } from '../commands/fixtures.js';
import { buildSeededContext } from './fixtures.js';

const EMPTY_INDEX: GitIndex = {
  version: 2,
  entries: [],
  extensions: [],
  trailerSha: new Uint8Array(0),
};

const writeBlob = async (
  ctx: Awaited<ReturnType<typeof buildSeededContext>>,
  content: string,
): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'blob',
    content: new TextEncoder().encode(content),
    id: '' as ObjectId,
  });

const makeIndexEntry = (path: string, id: ObjectId, stage: 0 | 1 | 2 | 3 = 0): IndexEntry => ({
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: 0,
  mtimeNanoseconds: 0,
  dev: 0,
  ino: 0,
  mode: FILE_MODE.REGULAR,
  uid: 0,
  gid: 0,
  fileSize: 0,
  id,
  flags: { ...STAGE0_FLAGS, stage },
  path: path as FilePath,
});

/** Build a one-level-nested tree (`<dir>/<name>` blobs) and return its id. */
const writeNestedTree = async (
  ctx: Awaited<ReturnType<typeof buildSeededContext>>,
  files: ReadonlyArray<{ readonly dir: string; readonly name: string; readonly id: ObjectId }>,
): Promise<ObjectId> => {
  const byDir = new Map<string, TreeEntry[]>();
  for (const f of files) {
    const list = byDir.get(f.dir) ?? [];
    list.push(treeEntry(FILE_MODE.REGULAR, f.name as FilePath, f.id));
    byDir.set(f.dir, list);
  }
  const rootEntries: TreeEntry[] = [];
  for (const [dir, entries] of byDir) {
    const subId = await writeTree(ctx, entries);
    rootEntries.push(treeEntry(FILE_MODE.DIRECTORY, dir as FilePath, subId));
  }
  return writeTree(ctx, rootEntries);
};

describe('materializeTree', () => {
  describe('Given a tree holding �.txt and 😀.txt', () => {
    describe('When materializeTree runs', () => {
      it('Then the entries come back �.txt first', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'x');
        const treeId = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, '�.txt' as FilePath, blobId),
          treeEntry(FILE_MODE.REGULAR, '\u{1F600}.txt' as FilePath, blobId),
        ]);

        // Act
        const sut = materializeTree;
        const result = await sut(ctx, {
          targetTree: treeId,
          currentIndex: EMPTY_INDEX,
        });

        // Assert
        expect(result.newIndexEntries.map((e) => e.path)).toEqual(['�.txt', '\u{1F600}.txt']);
      });
    });
  });

  describe('Given an empty index and a target tree with one blob', () => {
    describe('When materializeTree runs', () => {
      it('Then writes the blob to the workdir', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'hello');
        const treeEntries: TreeEntry[] = [
          treeEntry(FILE_MODE.REGULAR, 'a.txt' as FilePath, blobId),
        ];
        const treeId = await writeTree(ctx, treeEntries);

        // Act
        const result = await materializeTree(ctx, {
          targetTree: treeId,
          currentIndex: EMPTY_INDEX,
        });

        // Assert
        expect(result.written).toBe(1);
        expect(result.deleted).toBe(0);
        expect(result.newIndexEntries).toHaveLength(1);
        const bytes = await ctx.fs.read(`${ctx.layout.workDir}/a.txt`);
        expect(new TextDecoder().decode(bytes)).toBe('hello');
      });
    });
  });

  describe('Given an index with one path and an empty target tree (with force)', () => {
    describe('When materializeTree runs', () => {
      it('Then deletes the file', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'soon-gone');
        await ctx.fs.write(`${ctx.layout.workDir}/old.txt`, new TextEncoder().encode('soon-gone'));
        const treeId = await writeTree(ctx, []);
        const index: GitIndex = { ...EMPTY_INDEX, entries: [makeIndexEntry('old.txt', blobId)] };

        // Act
        const result = await materializeTree(ctx, {
          targetTree: treeId,
          currentIndex: index,
          force: true,
        });

        // Assert
        expect(result.deleted).toBe(1);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/old.txt`)).toBe(false);
      });
    });
  });

  describe('Given a noop entry (index matches target) AND forceRewriteAll', () => {
    describe('When materializeTree runs', () => {
      it('Then the path is rewritten anyway', async () => {
        // Arrange — seed index with the same id+mode the target tree has. The
        // index→target diff would normally classify this as `noop` and skip the
        // write. With `forceRewriteAll: true`, the path must be rewritten
        // unconditionally — the hard-reset use case where the working tree may
        // have diverged from the index.
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'committed');
        const treeId = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'a.txt' as FilePath, blobId),
        ]);
        const indexWithMatch: GitIndex = {
          ...EMPTY_INDEX,
          entries: [makeIndexEntry('a.txt', blobId)],
        };
        // Simulate a locally-modified file: index says 'committed', disk says 'dirty'.
        await ctx.fs.write(`${ctx.layout.workDir}/a.txt`, new TextEncoder().encode('dirty'));

        // Act
        const result = await materializeTree(ctx, {
          targetTree: treeId,
          currentIndex: indexWithMatch,
          force: true,
          forceRewriteAll: true,
        });

        // Assert — `written` includes the upgraded noop, and the file content
        // reverts to the committed blob.
        expect(result.written).toBe(1);
        const onDisk = new TextDecoder().decode(await ctx.fs.read(`${ctx.layout.workDir}/a.txt`));
        expect(onDisk).toBe('committed');
      });
    });
  });

  describe('Given a noop entry with a clean working-tree file AND forceRewriteAll: true, force: false', () => {
    describe('When materializeTree runs', () => {
      it('Then the upgraded entry goes through the tracked-dirty guard (kind is update, not add)', async () => {
        // Arrange — index has 'committed', working tree has 'committed' (clean per
        // the index's previousId hash check). forceRewriteAll upgrades the noop to
        // 'update'; force: false runs the dirty-tree guard. The 'update' branch of
        // the guard hashes the file and compares to previousId → match → no throw.
        //
        // If the upgrade mutated the kind to 'add' instead, the same code path
        // would run isUntrackedClash (file exists → throw CHECKOUT_OVERWRITE_DIRTY).
        // So this test discriminates 'update' from 'add' for the upgraded entry.
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'committed');
        const treeId = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'a.txt' as FilePath, blobId),
        ]);
        const indexWithMatch: GitIndex = {
          ...EMPTY_INDEX,
          entries: [makeIndexEntry('a.txt', blobId)],
        };
        await ctx.fs.write(`${ctx.layout.workDir}/a.txt`, new TextEncoder().encode('committed'));

        // Act
        const result = await materializeTree(ctx, {
          targetTree: treeId,
          currentIndex: indexWithMatch,
          force: false,
          forceRewriteAll: true,
        });

        // Assert
        expect(result.written).toBe(1);
      });
    });
  });

  describe('Given a noop entry without forceRewriteAll', () => {
    describe('When materializeTree runs', () => {
      it('Then the path is left alone', async () => {
        // Arrange — same setup, but `forceRewriteAll` omitted. Default behaviour
        // must preserve checkout semantics: clean (per the index)
        // files are never spuriously rewritten.
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'committed');
        const treeId = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'a.txt' as FilePath, blobId),
        ]);
        const indexWithMatch: GitIndex = {
          ...EMPTY_INDEX,
          entries: [makeIndexEntry('a.txt', blobId)],
        };
        await ctx.fs.write(`${ctx.layout.workDir}/a.txt`, new TextEncoder().encode('dirty'));

        // Act
        const result = await materializeTree(ctx, {
          targetTree: treeId,
          currentIndex: indexWithMatch,
          force: true,
        });

        // Assert — no writes (noop preserved), file stays dirty.
        expect(result.written).toBe(0);
        const onDisk = new TextDecoder().decode(await ctx.fs.read(`${ctx.layout.workDir}/a.txt`));
        expect(onDisk).toBe('dirty');
      });
    });
  });

  describe('Given forceRewriteAll: true with multiple noop entries', () => {
    describe('When materializeTree runs', () => {
      it('Then progress total reports them as upgraded updates', async () => {
        // Arrange — three paths that all match the index (so all three would be
        // noops without forceRewriteAll). With it, all three upgrade to updates,
        // and applyChangeset reports them in `total = stats.add + update + delete`.
        // This pins tallyStats' `stats[entry.kind] += 1` — a mutation to `-= 1`
        // would surface as a negative/zero progress total.
        const progress = recordingProgress();
        const ctx = await buildSeededContext();
        const ctxWithProgress = { ...ctx, progress: progress.reporter };
        const idA = await writeBlob(ctxWithProgress, 'A');
        const idB = await writeBlob(ctxWithProgress, 'B');
        const idC = await writeBlob(ctxWithProgress, 'C');
        const treeId = await writeTree(ctxWithProgress, [
          treeEntry(FILE_MODE.REGULAR, 'a.txt' as FilePath, idA),
          treeEntry(FILE_MODE.REGULAR, 'b.txt' as FilePath, idB),
          treeEntry(FILE_MODE.REGULAR, 'c.txt' as FilePath, idC),
        ]);
        const indexWithAllMatches: GitIndex = {
          ...EMPTY_INDEX,
          entries: [
            makeIndexEntry('a.txt', idA),
            makeIndexEntry('b.txt', idB),
            makeIndexEntry('c.txt', idC),
          ],
        };

        // Act
        await materializeTree(ctxWithProgress, {
          targetTree: treeId,
          currentIndex: indexWithAllMatches,
          force: true,
          forceRewriteAll: true,
        });

        // Assert — every update emits a progress tick whose `total` equals the
        // re-tallied stats sum (3 updates after upgrade, 0 add, 0 delete = 3).
        const totals = progress.events
          .filter(
            (e): e is { kind: 'update'; op: string; current: number; total: number } =>
              e.kind === 'update' && e.total !== undefined,
          )
          .map((e) => e.total);
        expect(totals).toEqual([3, 3, 3]);
      });
    });
  });

  describe('Given a scoped restore with conflict stages 1 to 3 of another path', () => {
    describe('When materializeTree runs', () => {
      it('Then every stage of the out-of-scope path is preserved in newIndexEntries', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const idA = await writeBlob(ctx, 'A');
        const ids = [
          await writeBlob(ctx, 'base'),
          await writeBlob(ctx, 'ours'),
          await writeBlob(ctx, 'theirs'),
        ];
        const treeId = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'a.txt' as FilePath, idA),
        ]);
        const index: GitIndex = {
          ...EMPTY_INDEX,
          entries: [
            makeIndexEntry('conflict.txt', ids[0] as ObjectId, 1),
            makeIndexEntry('conflict.txt', ids[1] as ObjectId, 2),
            makeIndexEntry('conflict.txt', ids[2] as ObjectId, 3),
          ],
        };
        const sut = materializeTree;

        // Act
        const result = await sut(ctx, {
          targetTree: treeId,
          currentIndex: index,
          paths: new Set(['a.txt' as FilePath]),
        });

        // Assert
        expect(result.newIndexEntries.map((e) => [e.path, e.flags.stage, e.id])).toEqual([
          ['a.txt', 0, idA],
          ['conflict.txt', 1, ids[0]],
          ['conflict.txt', 2, ids[1]],
          ['conflict.txt', 3, ids[2]],
        ]);
      });
    });
  });

  describe('Given a scoped restore with a stage-0 index entry out of scope', () => {
    describe('When materializeTree runs', () => {
      it('Then that entry IS preserved in newIndexEntries', async () => {
        // Arrange — `preserveOutOfScope` only runs in scoped mode and only pushes
        // entries whose path is NOT in `scopedPaths`. An out-of-scope stage-0 entry
        // must survive the scoped restore untouched. This exercises the loop body
        // and the `!scopedPaths.has(path)` guard's true branch.
        const ctx = await buildSeededContext();
        const idA = await writeBlob(ctx, 'A');
        const idKeep = await writeBlob(ctx, 'keep');
        const treeId = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'a.txt' as FilePath, idA),
        ]);
        const index: GitIndex = {
          ...EMPTY_INDEX,
          entries: [makeIndexEntry('keep.txt', idKeep)],
        };

        // Act — restore only 'a.txt'; 'keep.txt' is out of scope and must persist.
        const result = await materializeTree(ctx, {
          targetTree: treeId,
          currentIndex: index,
          paths: new Set(['a.txt' as FilePath]),
        });

        // Assert — both the restored path and the preserved out-of-scope path.
        expect(result.newIndexEntries.map((e) => e.path)).toEqual(['a.txt', 'keep.txt']);
        expect(result.newIndexEntries.find((e) => e.path === 'keep.txt')?.id).toBe(idKeep);
      });
    });
  });

  describe('Given a scoped restore with a stage-0 index entry IN scope', () => {
    describe('When materializeTree runs', () => {
      it('Then preserveOutOfScope does NOT also re-add it', async () => {
        // Arrange — an in-scope path that exists in both the index and the target.
        // `preserveOutOfScope`'s `!scopedPaths.has(path)` guard must be FALSE for it,
        // so it is contributed only once (via the target loop). If the guard were
        // inverted/forced true, the path would appear twice.
        const ctx = await buildSeededContext();
        const idOld = await writeBlob(ctx, 'old');
        const idNew = await writeBlob(ctx, 'new');
        const treeId = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'a.txt' as FilePath, idNew),
        ]);
        const index: GitIndex = {
          ...EMPTY_INDEX,
          entries: [makeIndexEntry('a.txt', idOld)],
        };

        // Act — restore 'a.txt', which is also present in the index.
        const result = await materializeTree(ctx, {
          targetTree: treeId,
          currentIndex: index,
          force: true,
          paths: new Set(['a.txt' as FilePath]),
        });

        // Assert — 'a.txt' appears exactly once.
        expect(result.newIndexEntries.map((e) => e.path)).toEqual(['a.txt']);
      });
    });
  });

  describe('Given a target tree whose entries sort differently from insertion order', () => {
    describe('When materializeTree runs', () => {
      it('Then newIndexEntries are in strict ascending path order', async () => {
        // Arrange — three blobs written to a tree. `writeTree` canonicalises tree
        // entry order, but `mergeNewIndexEntries` sorts the merged list explicitly.
        // Providing scrambled names and asserting strict ascending order pins the
        // `.sort()` call and its comparator: dropping the sort, inverting the
        // `-1`/`1` results, or forcing either ternary branch yields a non-ascending
        // (or fully descending) result.
        const ctx = await buildSeededContext();
        const idC = await writeBlob(ctx, 'C');
        const idA = await writeBlob(ctx, 'A');
        const idB = await writeBlob(ctx, 'B');
        const treeId = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'c.txt' as FilePath, idC),
          treeEntry(FILE_MODE.REGULAR, 'a.txt' as FilePath, idA),
          treeEntry(FILE_MODE.REGULAR, 'b.txt' as FilePath, idB),
        ]);

        // Act
        const result = await materializeTree(ctx, {
          targetTree: treeId,
          currentIndex: EMPTY_INDEX,
        });

        // Assert — exact ascending order, not descending, not unsorted.
        expect(result.newIndexEntries.map((e) => e.path)).toEqual(['a.txt', 'b.txt', 'c.txt']);
      });
    });
  });

  describe('Given a preserved out-of-scope entry that sorts before a restored path', () => {
    describe('When materializeTree runs', () => {
      it('Then the merged result stays ascending', async () => {
        // Arrange — the merged list is `[out-of-scope..., target...]`. When an
        // out-of-scope path sorts AFTER a restored path, only a real sort produces
        // ascending order. This drives the comparator's `1` (greater-than) branch
        // and the descending-detection: a dropped/inverted sort would put 'z.txt'
        // first.
        const ctx = await buildSeededContext();
        const idM = await writeBlob(ctx, 'M');
        const idZ = await writeBlob(ctx, 'Z');
        const treeId = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'm.txt' as FilePath, idM),
        ]);
        const index: GitIndex = {
          ...EMPTY_INDEX,
          entries: [makeIndexEntry('z.txt', idZ)],
        };

        // Act — restore only 'm.txt'; 'z.txt' is preserved out of scope.
        const result = await materializeTree(ctx, {
          targetTree: treeId,
          currentIndex: index,
          paths: new Set(['m.txt' as FilePath]),
        });

        // Assert — out-of-scope 'z.txt' is sorted after the restored 'm.txt'.
        expect(result.newIndexEntries.map((e) => e.path)).toEqual(['m.txt', 'z.txt']);
      });
    });
  });

  describe('Given an add entry clashing with an untracked working-tree file and force omitted', () => {
    describe('When materializeTree runs', () => {
      it('Then it throws CHECKOUT_OVERWRITE_DIRTY', async () => {
        // Arrange — `opts.force ?? false`: when `force` is omitted it must default
        // to `false`, so the dirty-tree guard runs. An untracked file already on
        // disk at a target `add` path triggers CHECKOUT_OVERWRITE_DIRTY. If the
        // nullish-coalescing default were mutated to `true`, the guard would be
        // skipped and no error thrown.
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'incoming');
        await ctx.fs.write(`${ctx.layout.workDir}/a.txt`, new TextEncoder().encode('untracked'));
        const treeId = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'a.txt' as FilePath, blobId),
        ]);

        // Act / Assert
        let captured: unknown;
        try {
          await materializeTree(ctx, { targetTree: treeId, currentIndex: EMPTY_INDEX });
        } catch (error) {
          captured = error;
        }
        // Assert
        expect(captured).toBeInstanceOf(Error);
        const data = (
          captured as {
            data: {
              code: string;
              localChanges: ReadonlyArray<string>;
              untracked: ReadonlyArray<string>;
            };
          }
        ).data;
        expect(data.code).toBe('CHECKOUT_OVERWRITE_DIRTY');
        expect(data.untracked).toEqual(['a.txt']);
        expect(data.localChanges).toEqual([]);
        expect((captured as Error).message).toBe(
          'CHECKOUT_OVERWRITE_DIRTY: checkout would overwrite uncommitted changes: 1 files',
        );
      });
    });
  });

  describe('Given the same add/untracked clash but force: true', () => {
    describe('When materializeTree runs', () => {
      it('Then the dirty guard is bypassed and the file is overwritten', async () => {
        // Arrange — companion to the previous test: with `force: true` explicitly
        // set, the guard is skipped and the write proceeds. This proves the guard
        // is gated on the force value, not unconditional.
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'incoming');
        await ctx.fs.write(`${ctx.layout.workDir}/a.txt`, new TextEncoder().encode('untracked'));
        const treeId = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'a.txt' as FilePath, blobId),
        ]);

        // Act
        const result = await materializeTree(ctx, {
          targetTree: treeId,
          currentIndex: EMPTY_INDEX,
          force: true,
        });

        // Assert
        expect(result.written).toBe(1);
        const onDisk = new TextDecoder().decode(await ctx.fs.read(`${ctx.layout.workDir}/a.txt`));
        expect(onDisk).toBe('incoming');
      });
    });
  });

  describe('Given paths filter', () => {
    describe('When materializeTree runs', () => {
      it('Then only the filtered path is affected', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const idA = await writeBlob(ctx, 'A');
        const idB = await writeBlob(ctx, 'B');
        const treeId = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'a.txt' as FilePath, idA),
          treeEntry(FILE_MODE.REGULAR, 'b.txt' as FilePath, idB),
        ]);

        // Act — restore only 'a.txt'
        const result = await materializeTree(ctx, {
          targetTree: treeId,
          currentIndex: EMPTY_INDEX,
          paths: new Set(['a.txt' as FilePath]),
        });

        // Assert
        expect(result.written).toBe(1);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/a.txt`)).toBe(true);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/b.txt`)).toBe(false);
      });
    });
  });

  describe('Given a sparse matcher excluding one target path', () => {
    describe('When materializeTree runs', () => {
      it('Then the excluded path is a skip-worktree index entry with no file on disk', async () => {
        // Arrange — target tree has an in-pattern `src/a.txt` and an out-of-pattern
        // `docs/b.txt`; the sparse matcher selects only `src/`.
        const ctx = await buildSeededContext();
        const idA = await writeBlob(ctx, 'A');
        const idB = await writeBlob(ctx, 'B');
        const treeId = await writeNestedTree(ctx, [
          { dir: 'docs', name: 'b.txt', id: idB },
          { dir: 'src', name: 'a.txt', id: idA },
        ]);

        // Act
        const result = await materializeTree(ctx, {
          targetTree: treeId,
          currentIndex: EMPTY_INDEX,
          sparse: (path) => path.startsWith('src/'),
        });

        // Assert — only the in-pattern file is on disk; the excluded file is not.
        expect(result.written).toBe(1);
        expect(result.deleted).toBe(0);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/src/a.txt`)).toBe(true);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/docs/b.txt`)).toBe(false);
        // The index keeps BOTH paths — the excluded one synthesised skip-worktree.
        expect(result.newIndexEntries.map((e) => e.path)).toEqual(['docs/b.txt', 'src/a.txt']);
        const excluded = result.newIndexEntries.find((e) => e.path === 'docs/b.txt');
        expect(excluded).toEqual({
          ctimeSeconds: 0,
          ctimeNanoseconds: 0,
          mtimeSeconds: 0,
          mtimeNanoseconds: 0,
          dev: 0,
          ino: 0,
          mode: FILE_MODE.REGULAR,
          uid: 0,
          gid: 0,
          fileSize: 0,
          id: idB,
          flags: { ...STAGE0_FLAGS, skipWorktree: true },
          path: 'docs/b.txt',
        });
        const included = result.newIndexEntries.find((e) => e.path === 'src/a.txt');
        expect(included?.flags.skipWorktree).toBe(false);
      });
    });
  });

  describe('Given a sparse matcher excluding a path git would refuse to add', () => {
    const refusalOf = async (run: () => Promise<unknown>): Promise<TsgitError['data']> => {
      try {
        await run();
      } catch (error) {
        if (error instanceof TsgitError) return error.data;
        throw error;
      }
      throw new Error('expected materializeTree to refuse');
    };

    describe('When the excluded path sits under .git', () => {
      it('Then it throws INVALID_INDEX_ENTRY, writes nothing and returns no index', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, 'x');
        const treeId = await writeNestedTree(ctx, [
          { dir: '.git', name: 'post-checkout', id },
          { dir: 'keep', name: 'a.txt', id },
        ]);

        // Act
        const data = await refusalOf(() =>
          materializeTree(ctx, {
            targetTree: treeId,
            currentIndex: EMPTY_INDEX,
            sparse: (path) => path.startsWith('keep/'),
          }),
        );

        // Assert
        expect(data).toMatchObject({
          code: 'INVALID_INDEX_ENTRY',
          reason: "'.git' component rejected",
        });
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/keep/a.txt`)).toBe(false);
      });
    });

    describe('When the excluded path holds a backslash under windows path rules', () => {
      it('Then it throws INVALID_INDEX_ENTRY with the backslash reason', async () => {
        // Arrange
        const seeded = await buildSeededContext();
        const ctx = { ...seeded, windowsPathSyntax: true };
        const id = await writeBlob(ctx, 'x');
        const treeId = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, '\\.git\\hooks\\post-checkout' as FilePath, id),
          treeEntry(FILE_MODE.REGULAR, 'keep' as FilePath, id),
        ]);

        // Act
        const data = await refusalOf(() =>
          materializeTree(ctx, {
            targetTree: treeId,
            currentIndex: EMPTY_INDEX,
            sparse: (path) => path === 'keep',
          }),
        );

        // Assert
        expect(data).toMatchObject({
          code: 'INVALID_INDEX_ENTRY',
          reason: 'backslash rejected under Windows path syntax',
        });
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/keep`)).toBe(false);
      });
    });

    describe('When the excluded path is legitimate', () => {
      it('Then it becomes a skip-worktree entry', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, 'x');
        const treeId = await writeNestedTree(ctx, [{ dir: 'docs', name: 'b.txt', id }]);

        // Act
        const result = await materializeTree(ctx, {
          targetTree: treeId,
          currentIndex: EMPTY_INDEX,
          sparse: () => false,
        });

        // Assert
        expect(result.newIndexEntries.map((e) => [e.path, e.flags.skipWorktree])).toEqual([
          ['docs/b.txt', true],
        ]);
      });
    });
  });

  describe('Given a sparse matcher excluding a path whose file is currently on disk', () => {
    describe('When materializeTree runs', () => {
      it('Then the file is deleted and its entry becomes skip-worktree', async () => {
        // Arrange — `docs/b.txt` is materialised (index entry + file on disk); the
        // new sparse matcher puts it out of pattern.
        const ctx = await buildSeededContext();
        const idA = await writeBlob(ctx, 'A');
        const idB = await writeBlob(ctx, 'B');
        await ctx.fs.write(`${ctx.layout.workDir}/docs/b.txt`, new TextEncoder().encode('B'));
        const treeId = await writeNestedTree(ctx, [
          { dir: 'docs', name: 'b.txt', id: idB },
          { dir: 'src', name: 'a.txt', id: idA },
        ]);
        const index: GitIndex = { ...EMPTY_INDEX, entries: [makeIndexEntry('docs/b.txt', idB)] };

        // Act
        const result = await materializeTree(ctx, {
          targetTree: treeId,
          currentIndex: index,
          sparse: (path) => path.startsWith('src/'),
        });

        // Assert — the now-excluded file is removed from the working tree.
        expect(result.deleted).toBe(1);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/docs/b.txt`)).toBe(false);
        expect(
          result.newIndexEntries.find((e) => e.path === 'docs/b.txt')?.flags.skipWorktree,
        ).toBe(true);
      });
    });
  });

  describe('Given a skip-worktree index entry for a now-in-pattern path', () => {
    describe('When materializeTree runs', () => {
      it('Then the absent file is materialised even though its id matches', async () => {
        // Arrange — the index records `src/a.txt` with the target tree's id but as
        // skip-worktree (the file is absent). A naive index→target diff would call
        // this a `noop`; the sparse path drops skip-worktree entries from the diff
        // base, so it classifies as `add` and the file IS written.
        const ctx = await buildSeededContext();
        const idA = await writeBlob(ctx, 'A');
        const treeId = await writeNestedTree(ctx, [{ dir: 'src', name: 'a.txt', id: idA }]);
        const skipped = makeIndexEntry('src/a.txt', idA);
        const index: GitIndex = {
          ...EMPTY_INDEX,
          entries: [{ ...skipped, flags: { ...STAGE0_FLAGS, skipWorktree: true } }],
        };

        // Act
        const result = await materializeTree(ctx, {
          targetTree: treeId,
          currentIndex: index,
          sparse: (path) => path.startsWith('src/'),
        });

        // Assert — the file is written and its entry is no longer skip-worktree.
        expect(result.written).toBe(1);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/src/a.txt`)).toBe(true);
        expect(result.newIndexEntries.find((e) => e.path === 'src/a.txt')?.flags.skipWorktree).toBe(
          false,
        );
      });
    });
  });

  describe('Given a sparse matcher that includes every path', () => {
    describe('When materializeTree runs', () => {
      it('Then it behaves like a plain materialize (all written, no skip-worktree)', async () => {
        // Arrange — an all-true matcher exercises the sparse branch with an empty
        // `excluded` set; the result must match the no-sparse behaviour.
        const ctx = await buildSeededContext();
        const idA = await writeBlob(ctx, 'A');
        const idB = await writeBlob(ctx, 'B');
        const treeId = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'a.txt' as FilePath, idA),
          treeEntry(FILE_MODE.REGULAR, 'b.txt' as FilePath, idB),
        ]);

        // Act
        const result = await materializeTree(ctx, {
          targetTree: treeId,
          currentIndex: EMPTY_INDEX,
          sparse: () => true,
        });

        // Assert
        expect(result.written).toBe(2);
        expect(result.newIndexEntries.every((e) => e.flags.skipWorktree === false)).toBe(true);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/a.txt`)).toBe(true);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/b.txt`)).toBe(true);
      });
    });
  });

  describe('Given both a paths filter and a sparse matcher', () => {
    describe('When materializeTree runs', () => {
      it('Then paths mode wins and sparse is ignored', async () => {
        // Arrange — `sparse` is honoured ONLY when `paths` is undefined. With both
        // set, path-restore semantics apply: the sparse matcher (which would
        // exclude `b.txt`) must have no effect, and `b.txt` is simply out of the
        // path scope rather than a synthesised skip-worktree entry.
        const ctx = await buildSeededContext();
        const idA = await writeBlob(ctx, 'A');
        const idB = await writeBlob(ctx, 'B');
        const treeId = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'a.txt' as FilePath, idA),
          treeEntry(FILE_MODE.REGULAR, 'b.txt' as FilePath, idB),
        ]);

        // Act
        const result = await materializeTree(ctx, {
          targetTree: treeId,
          currentIndex: EMPTY_INDEX,
          paths: new Set(['a.txt' as FilePath]),
          sparse: () => false,
        });

        // Assert — only the path-scoped `a.txt`; no skip-worktree `b.txt` synthesised.
        expect(result.newIndexEntries.map((e) => e.path)).toEqual(['a.txt']);
        expect(result.written).toBe(1);
      });
    });
  });

  describe('Given a target tree with a `.`-named entry, reachable now that the parse tier accepts it', () => {
    describe('When materializeTree runs', () => {
      it("Then throws INVALID_INDEX_ENTRY with the '.' segment reason", async () => {
        // Arrange — the parse tier no longer refuses this name shape; the
        // refusal moves to this boundary, the layer git itself refuses it at.
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'hostile');
        const treeId = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, '.' as FilePath, blobId),
        ]);

        // Act
        let caught: unknown;
        try {
          await materializeTree(ctx, { targetTree: treeId, currentIndex: EMPTY_INDEX });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data).toEqual({
          code: 'INVALID_INDEX_ENTRY',
          offset: -1,
          reason: "'.' segment rejected",
        });
      });
    });
  });

  describe('Given a target tree with a `..`-named entry, reachable now that the parse tier accepts it', () => {
    describe('When materializeTree runs', () => {
      it("Then throws INVALID_INDEX_ENTRY with the '..' segment reason", async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'hostile');
        const treeId = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, '..' as FilePath, blobId),
        ]);

        // Act
        let caught: unknown;
        try {
          await materializeTree(ctx, { targetTree: treeId, currentIndex: EMPTY_INDEX });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data).toEqual({
          code: 'INVALID_INDEX_ENTRY',
          offset: -1,
          reason: "'..' segment rejected",
        });
      });
    });
  });

  describe('Given a process filter driver and checkout metadata', () => {
    describe('When materializeTree checks out a file', () => {
      it('Then the process is told the pathname, ref, commit and blob in git’s order', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'HELLO');
        const treeId = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'a.y' as FilePath, blobId),
        ]);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '*.y filter=myf\n');
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[filter "myf"]\n\tprocess = proc\n');
        const pkt = (text: string): string =>
          `${(text.length + 4).toString(16).padStart(4, '0')}${text}`;
        const { runner, requests } = scriptedCommandRunner(
          new TextEncoder().encode(
            `${pkt('git-filter-server\n')}${pkt('version=2\n')}0000${pkt('capability=smudge\n')}0000` +
              `${pkt('status=success\n')}0000${pkt('hello')}00000000`,
          ),
        );
        const treeish = 'c'.repeat(40) as ObjectId;
        const sut = materializeTree;

        // Act
        await sut(
          { ...ctx, command: runner },
          {
            targetTree: treeId,
            currentIndex: EMPTY_INDEX,
            checkoutMetadata: { ref: 'refs/heads/other', treeish },
          },
        );

        // Assert
        expect(new TextDecoder().decode(requests[0]?.stdin)).toContain(
          `${pkt('command=smudge\n')}${pkt('pathname=a.y\n')}${pkt('ref=refs/heads/other\n')}${pkt(`treeish=${treeish}\n`)}${pkt(`blob=${blobId}\n`)}0000`,
        );
      });
    });
  });

  describe('Given the index records .gitattributes eol=crlf and the work tree records eol=lf', () => {
    const setup = async () => {
      const ctx = await buildSeededContext();
      const crlfRules = await writeBlob(ctx, '*.txt eol=crlf\n');
      const fileBlob = await writeBlob(ctx, 'a\nb\n');
      const treeId = await writeTree(ctx, [
        treeEntry(FILE_MODE.REGULAR, '.gitattributes' as FilePath, crlfRules),
        treeEntry(FILE_MODE.REGULAR, 'f.txt' as FilePath, fileBlob),
      ]);
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '*.txt eol=lf\n');
      const currentIndex: GitIndex = {
        ...EMPTY_INDEX,
        entries: [makeIndexEntry('.gitattributes', crlfRules)],
      };
      return { ctx, treeId, currentIndex };
    };
    const decode = async (ctx: Awaited<ReturnType<typeof buildSeededContext>>): Promise<string> =>
      new TextDecoder().decode(await ctx.fs.read(`${ctx.layout.workDir}/f.txt`));

    describe('When materializeTree rewrites f.txt for a target tree', () => {
      it('Then f.txt is CRLF', async () => {
        // Arrange
        const { ctx, treeId, currentIndex } = await setup();
        const sut = materializeTree;

        // Act
        await sut(ctx, { targetTree: treeId, currentIndex });

        // Assert
        expect(await decode(ctx)).toBe('a\r\nb\r\n');
      });
    });

    describe('When restoring paths [f.txt]', () => {
      it('Then f.txt is LF', async () => {
        // Arrange
        const { ctx, treeId, currentIndex } = await setup();
        const sut = materializeTree;

        // Act
        await sut(ctx, {
          targetTree: treeId,
          currentIndex,
          paths: new Set(['f.txt' as FilePath]),
        });

        // Assert
        expect(await decode(ctx)).toBe('a\nb\n');
      });
    });
  });

  describe('Given the current index records .gitattributes eol=crlf only at the unmerged stage 2', () => {
    describe('When restoring paths [f.txt] with no work-tree .gitattributes', () => {
      it('Then f.txt is CRLF, git reading ours for an unmerged .gitattributes', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const rules = await writeBlob(ctx, '*.txt eol=crlf\n');
        const fileBlob = await writeBlob(ctx, 'a\nb\n');
        const treeId = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'f.txt' as FilePath, fileBlob),
        ]);
        const currentIndex: GitIndex = {
          ...EMPTY_INDEX,
          entries: [makeIndexEntry('.gitattributes', rules, 2)],
        };
        const sut = materializeTree;

        // Act
        await sut(ctx, {
          targetTree: treeId,
          currentIndex,
          paths: new Set(['f.txt' as FilePath]),
        });

        // Assert
        const bytes = await ctx.fs.read(`${ctx.layout.workDir}/f.txt`);
        expect(new TextDecoder().decode(bytes)).toBe('a\r\nb\r\n');
      });
    });
  });

  describe('Given a target tree whose .gitattributes eol=crlf the sparse matcher excludes', () => {
    describe('When materializeTree switches to it', () => {
      it('Then the excluded rules still govern the included f.txt', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const rules = await writeBlob(ctx, '*.txt eol=crlf\n');
        const fileBlob = await writeBlob(ctx, 'a\nb\n');
        const treeId = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, '.gitattributes' as FilePath, rules),
          treeEntry(FILE_MODE.REGULAR, 'f.txt' as FilePath, fileBlob),
        ]);
        const sut = materializeTree;

        // Act
        await sut(ctx, {
          targetTree: treeId,
          currentIndex: EMPTY_INDEX,
          sparse: (path) => path === 'f.txt',
        });

        // Assert
        const bytes = await ctx.fs.read(`${ctx.layout.workDir}/f.txt`);
        expect(new TextDecoder().decode(bytes)).toBe('a\r\nb\r\n');
      });
    });
  });

  describe('Given the current index records .gitattributes eol=crlf that the restored paths name but the target lacks', () => {
    describe('When restoring paths [.gitattributes, f.txt]', () => {
      it('Then the deleted rules no longer apply to f.txt', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const rules = await writeBlob(ctx, '*.txt eol=crlf\n');
        const fileBlob = await writeBlob(ctx, 'a\nb\n');
        const treeId = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'f.txt' as FilePath, fileBlob),
        ]);
        const currentIndex: GitIndex = {
          ...EMPTY_INDEX,
          entries: [makeIndexEntry('.gitattributes', rules)],
        };
        const sut = materializeTree;

        // Act
        await sut(ctx, {
          targetTree: treeId,
          currentIndex,
          paths: new Set(['.gitattributes' as FilePath, 'f.txt' as FilePath]),
        });

        // Assert
        const bytes = await ctx.fs.read(`${ctx.layout.workDir}/f.txt`);
        expect(new TextDecoder().decode(bytes)).toBe('a\nb\n');
      });
    });
  });

  describe("Given a target tree that introduces '*.txt eol=crlf' over an empty index", () => {
    describe('When materializeTree switches to it', () => {
      it('Then the switch writes f.txt CRLF', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const rules = await writeBlob(ctx, '*.txt eol=crlf\n');
        const fileBlob = await writeBlob(ctx, 'a\nb\n');
        const treeId = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, '.gitattributes' as FilePath, rules),
          treeEntry(FILE_MODE.REGULAR, 'f.txt' as FilePath, fileBlob),
        ]);
        const sut = materializeTree;

        // Act
        await sut(ctx, { targetTree: treeId, currentIndex: EMPTY_INDEX });

        // Assert
        const bytes = await ctx.fs.read(`${ctx.layout.workDir}/f.txt`);
        expect(new TextDecoder().decode(bytes)).toBe('a\r\nb\r\n');
      });
    });
  });

  describe('Given the current index records .gitattributes eol=crlf that the target tree deletes', () => {
    describe('When materializeTree switches to the target', () => {
      it('Then f.txt is written as stored, the deleted rules no longer apply', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const rules = await writeBlob(ctx, '*.txt eol=crlf\n');
        const fileBlob = await writeBlob(ctx, 'a\nb\n');
        const treeId = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'f.txt' as FilePath, fileBlob),
        ]);
        const currentIndex: GitIndex = {
          ...EMPTY_INDEX,
          entries: [makeIndexEntry('.gitattributes', rules)],
        };
        const sut = materializeTree;

        // Act
        await sut(ctx, { targetTree: treeId, currentIndex, force: true });

        // Assert
        const bytes = await ctx.fs.read(`${ctx.layout.workDir}/f.txt`);
        expect(new TextDecoder().decode(bytes)).toBe('a\nb\n');
      });
    });
  });

  describe('Given only an untracked work-tree .gitattributes eol=crlf', () => {
    describe('When materializeTree rewrites every path reset-style', () => {
      it('Then the work-tree file is the fallback and f.txt is CRLF', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const fileBlob = await writeBlob(ctx, 'a\nb\n');
        const treeId = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'f.txt' as FilePath, fileBlob),
        ]);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '*.txt eol=crlf\n');
        const sut = materializeTree;

        // Act
        await sut(ctx, {
          targetTree: treeId,
          currentIndex: EMPTY_INDEX,
          forceRewriteAll: true,
          force: true,
        });

        // Assert
        const bytes = await ctx.fs.read(`${ctx.layout.workDir}/f.txt`);
        expect(new TextDecoder().decode(bytes)).toBe('a\r\nb\r\n');
      });
    });
  });

  describe('Given a nested dir/.gitattributes eol=crlf introduced by the target tree', () => {
    describe('When materializeTree switches to it', () => {
      it('Then dir/f.txt is CRLF', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const rules = await writeBlob(ctx, '*.txt eol=crlf\n');
        const fileBlob = await writeBlob(ctx, 'a\nb\n');
        const subTree = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, '.gitattributes' as FilePath, rules),
          treeEntry(FILE_MODE.REGULAR, 'f.txt' as FilePath, fileBlob),
        ]);
        const treeId = await writeTree(ctx, [
          treeEntry(FILE_MODE.DIRECTORY, 'dir' as FilePath, subTree),
        ]);
        const sut = materializeTree;

        // Act
        await sut(ctx, { targetTree: treeId, currentIndex: EMPTY_INDEX });

        // Assert
        const bytes = await ctx.fs.read(`${ctx.layout.workDir}/dir/f.txt`);
        expect(new TextDecoder().decode(bytes)).toBe('a\r\nb\r\n');
      });
    });
  });

  describe('Given a target tree holding d/\xff and d/y', () => {
    describe('When materializeTree runs on an empty index', () => {
      it('Then the raw name keeps its bytes and the plain name has none', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'x');
        const rawName = Uint8Array.of(0xff);
        const sub = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'y' as FilePath, blobId),
          treeEntry(FILE_MODE.REGULAR, rawName, blobId),
        ]);
        const treeId = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'd' as FilePath, sub)]);

        // Act
        const result = await materializeTree(ctx, {
          targetTree: treeId,
          currentIndex: EMPTY_INDEX,
        });

        // Assert
        expect(result.newIndexEntries).toHaveLength(2);
        const plain = result.newIndexEntries.find((e) => e.path === 'd/y');
        expect(plain !== undefined && 'pathBytes' in plain).toBe(false);
        const raw = result.newIndexEntries.find((e) => e.pathBytes !== undefined);
        expect(raw?.pathBytes).toStrictEqual(Uint8Array.of(0x64, 0x2f, 0xff));
      });
    });
  });

  describe('Given a target tree holding raw \xff.txt and literal U+FFFD .txt', () => {
    describe('When materializeTree runs on an empty index', () => {
      it('Then two index entries come back, one carrying the raw bytes', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'x');
        const raw = Uint8Array.of(0xff, 0x2e, 0x74, 0x78, 0x74);
        const treeId = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, raw, blobId),
          treeEntry(FILE_MODE.REGULAR, '\uFFFD.txt' as FilePath, blobId),
        ]);

        // Act
        const result = await materializeTree(ctx, {
          targetTree: treeId,
          currentIndex: EMPTY_INDEX,
        });

        // Assert
        expect(result.newIndexEntries).toHaveLength(2);
        expect(result.newIndexEntries.filter((e) => e.pathBytes !== undefined)).toHaveLength(1);
        expect(
          result.newIndexEntries.find((e) => e.pathBytes !== undefined)?.pathBytes,
        ).toStrictEqual(raw);
      });
    });
  });

  describe('Given an index and a target tree both holding raw \xff.txt and literal U+FFFD .txt', () => {
    describe('When materializeTree runs scoped to the well-formed U+FFFD .txt path', () => {
      it('Then the raw entry keeps its id and bytes while the literal one is updated', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const oldBlob = await writeBlob(ctx, 'old');
        const rawBlob = await writeBlob(ctx, 'raw-new');
        const literalBlob = await writeBlob(ctx, 'literal-new');
        const raw = Uint8Array.of(0xff, 0x2e, 0x74, 0x78, 0x74);
        const targetTree = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, raw, rawBlob),
          treeEntry(FILE_MODE.REGULAR, '\uFFFD.txt' as FilePath, literalBlob),
        ]);
        const currentIndex: GitIndex = {
          ...EMPTY_INDEX,
          entries: [
            { ...makeIndexEntry('\uFFFD.txt', oldBlob), pathBytes: raw },
            makeIndexEntry('\uFFFD.txt', oldBlob),
          ],
        };

        // Act
        const result = await materializeTree(ctx, {
          targetTree,
          currentIndex,
          force: true,
          forceRewriteAll: true,
          paths: new Set(['\uFFFD.txt' as FilePath]),
        });

        // Assert
        const lossy = result.newIndexEntries.find((e) => e.pathBytes !== undefined);
        const literal = result.newIndexEntries.find((e) => e.pathBytes === undefined);
        expect(result.newIndexEntries).toHaveLength(2);
        expect(lossy?.id).toBe(oldBlob);
        expect(lossy?.pathBytes).toStrictEqual(raw);
        expect(literal?.id).toBe(literalBlob);
      });
    });
  });
});

describe('materializeTree carrying staged changes (headTree)', () => {
  type SeededContext = Awaited<ReturnType<typeof buildSeededContext>>;

  const flatTree = (
    ctx: SeededContext,
    files: Readonly<Record<string, ObjectId>>,
  ): Promise<ObjectId> =>
    writeTree(
      ctx,
      Object.entries(files).map(([name, id]) => treeEntry(FILE_MODE.REGULAR, name as FilePath, id)),
    );

  const writeWork = async (ctx: SeededContext, name: string, body: string): Promise<void> => {
    await ctx.fs.write(`${ctx.layout.workDir}/${name}`, new TextEncoder().encode(body));
  };

  const readWork = async (ctx: SeededContext, name: string): Promise<string | undefined> =>
    (await ctx.fs.exists(`${ctx.layout.workDir}/${name}`))
      ? new TextDecoder().decode(await ctx.fs.read(`${ctx.layout.workDir}/${name}`))
      : undefined;

  interface Fixture {
    readonly ctx: SeededContext;
    readonly blobs: Readonly<Record<string, ObjectId>>;
    readonly headTree: ObjectId;
    readonly targetTree: ObjectId;
  }

  /** head: b=old c=same; target: b=new c=same z=zed. The work tree is checked out at head. */
  const buildFixture = async (): Promise<Fixture> => {
    const ctx = await buildSeededContext();
    const names = ['old', 'new', 'same', 'zed', 'staged'];
    const blobs: Record<string, ObjectId> = {};
    for (const name of names) blobs[name] = await writeBlob(ctx, name);
    const headTree = await flatTree(ctx, { b: blobs.old as ObjectId, c: blobs.same as ObjectId });
    const targetTree = await flatTree(ctx, {
      b: blobs.new as ObjectId,
      c: blobs.same as ObjectId,
      z: blobs.zed as ObjectId,
    });
    await writeWork(ctx, 'b', 'old');
    await writeWork(ctx, 'c', 'same');
    return { ctx, blobs, headTree, targetTree };
  };

  const indexOf = (entries: ReadonlyArray<IndexEntry>): GitIndex => ({
    ...EMPTY_INDEX,
    entries,
  });

  const refusalOf = async (run: () => Promise<unknown>): Promise<TsgitError['data']> => {
    try {
      await run();
    } catch (e) {
      return (e as TsgitError).data;
    }
    return expect.unreachable('expected a refusal');
  };

  describe('Given c staged to a blob and unchanged between head and target', () => {
    describe('When the branch switch materialises', () => {
      it('Then c keeps the staged index entry and its work file', async () => {
        // Arrange
        const { ctx, blobs, headTree, targetTree } = await buildFixture();
        await writeWork(ctx, 'c', 'staged');
        const currentIndex = indexOf([
          makeIndexEntry('b', blobs.old as ObjectId),
          makeIndexEntry('c', blobs.staged as ObjectId),
        ]);

        // Act
        const result = await materializeTree(ctx, { targetTree, currentIndex, headTree });

        // Assert
        const byPath = new Map(result.newIndexEntries.map((e) => [e.path, e.id]));
        expect(byPath.get('c' as FilePath)).toBe(blobs.staged);
        expect(byPath.get('b' as FilePath)).toBe(blobs.new);
        expect(byPath.get('z' as FilePath)).toBe(blobs.zed);
        expect(await readWork(ctx, 'c')).toBe('staged');
        expect(await readWork(ctx, 'b')).toBe('new');
      });
    });

    describe('When the same switch runs without a head tree', () => {
      it('Then the staged entry is overwritten by the target', async () => {
        // Arrange
        const { ctx, blobs, targetTree } = await buildFixture();
        await writeWork(ctx, 'c', 'staged');
        const currentIndex = indexOf([
          makeIndexEntry('b', blobs.old as ObjectId),
          makeIndexEntry('c', blobs.staged as ObjectId),
        ]);

        // Act
        const result = await materializeTree(ctx, { targetTree, currentIndex, force: true });

        // Assert
        const byPath = new Map(result.newIndexEntries.map((e) => [e.path, e.id]));
        expect(byPath.get('c' as FilePath)).toBe(blobs.same);
      });
    });
  });

  describe('Given a new path staged that neither head nor target has', () => {
    describe('When the branch switch materialises', () => {
      it('Then the entry and the work file are kept', async () => {
        // Arrange
        const { ctx, blobs, headTree, targetTree } = await buildFixture();
        await writeWork(ctx, 'n', 'staged');
        const currentIndex = indexOf([
          makeIndexEntry('b', blobs.old as ObjectId),
          makeIndexEntry('c', blobs.same as ObjectId),
          makeIndexEntry('n', blobs.staged as ObjectId),
        ]);

        // Act
        const result = await materializeTree(ctx, { targetTree, currentIndex, headTree });

        // Assert
        const byPath = new Map(result.newIndexEntries.map((e) => [e.path, e.id]));
        expect(byPath.get('n' as FilePath)).toBe(blobs.staged);
        expect(await readWork(ctx, 'n')).toBe('staged');
      });
    });
  });

  describe('Given c deleted from the index and unchanged between head and target', () => {
    describe('When the branch switch materialises', () => {
      it('Then the deletion is kept: no entry, no work file', async () => {
        // Arrange
        const { ctx, blobs, headTree, targetTree } = await buildFixture();
        await ctx.fs.rm(`${ctx.layout.workDir}/c`);
        const currentIndex = indexOf([makeIndexEntry('b', blobs.old as ObjectId)]);

        // Act
        const result = await materializeTree(ctx, { targetTree, currentIndex, headTree });

        // Assert
        expect(result.newIndexEntries.some((e) => e.path === ('c' as FilePath))).toBe(false);
        expect(await readWork(ctx, 'c')).toBeUndefined();
      });
    });
  });

  describe('Given the sparse patterns select b only', () => {
    const sparse = (path: string): boolean => path === 'b';

    describe('When c, outside the patterns, is deleted from the index and unchanged between head and target', () => {
      it('Then the deletion is kept: no entry for c', async () => {
        // Arrange
        const { ctx, blobs, headTree, targetTree } = await buildFixture();
        await ctx.fs.rm(`${ctx.layout.workDir}/c`);
        const currentIndex = indexOf([makeIndexEntry('b', blobs.old as ObjectId)]);

        // Act
        const result = await materializeTree(ctx, { targetTree, currentIndex, headTree, sparse });

        // Assert
        expect(result.newIndexEntries.some((e) => e.path === ('c' as FilePath))).toBe(false);
        expect(await readWork(ctx, 'c')).toBeUndefined();
      });
    });

    describe('When n, outside the patterns, is staged although neither head nor target has it', () => {
      it('Then n stays in the index as skip-worktree and its work file goes', async () => {
        // Arrange
        const { ctx, blobs, headTree, targetTree } = await buildFixture();
        await writeWork(ctx, 'n', 'staged');
        const currentIndex = indexOf([
          makeIndexEntry('b', blobs.old as ObjectId),
          makeIndexEntry('c', blobs.same as ObjectId),
          makeIndexEntry('n', blobs.staged as ObjectId),
        ]);

        // Act
        const result = await materializeTree(ctx, { targetTree, currentIndex, headTree, sparse });

        // Assert
        const staged = result.newIndexEntries.find((e) => e.path === ('n' as FilePath));
        expect(staged?.id).toBe(blobs.staged);
        expect(staged?.flags.skipWorktree).toBe(true);
        expect(await readWork(ctx, 'n')).toBeUndefined();
      });
    });
  });

  describe('Given a target that only flips the mode of b to executable', () => {
    describe('When the index still equals head', () => {
      it('Then b takes the target mode in the index', async () => {
        // Arrange
        const { ctx, blobs } = await buildFixture();
        const entry = (mode: string) =>
          treeEntry(mode as typeof FILE_MODE.REGULAR, 'b' as FilePath, blobs.old as ObjectId);
        const headTree = await writeTree(ctx, [entry(FILE_MODE.REGULAR)]);
        const targetTree = await writeTree(ctx, [entry(FILE_MODE.EXECUTABLE)]);
        const currentIndex = indexOf([makeIndexEntry('b', blobs.old as ObjectId)]);

        // Act
        const result = await materializeTree(ctx, { targetTree, currentIndex, headTree });

        // Assert
        const modes = new Map(result.newIndexEntries.map((e) => [e.path, e.mode]));
        expect(modes.get('b' as FilePath)).toBe(FILE_MODE.EXECUTABLE);
      });
    });
  });

  describe('Given b staged to a blob that is neither the head nor the target version', () => {
    describe('When the branch switch materialises', () => {
      it.each([
        ['the work file still holds the staged content', 'staged'],
        ['the work file already holds the target content', 'new'],
      ])('Then it refuses with b and touches nothing when %s', async (_title, body) => {
        // Arrange
        const { ctx, blobs, headTree, targetTree } = await buildFixture();
        await writeWork(ctx, 'b', body);
        const currentIndex = indexOf([
          makeIndexEntry('b', blobs.staged as ObjectId),
          makeIndexEntry('c', blobs.same as ObjectId),
        ]);

        // Act
        const data = await refusalOf(() =>
          materializeTree(ctx, { targetTree, currentIndex, headTree }),
        );

        // Assert
        expect(data).toEqual({
          code: 'CHECKOUT_OVERWRITE_DIRTY',
          localChanges: ['b'],
          untracked: [],
        });
        expect(await readWork(ctx, 'b')).toBe(body);
        expect(await readWork(ctx, 'z')).toBeUndefined();
      });
    });
  });

  describe('Given b staged to the target version', () => {
    describe('When the branch switch materialises', () => {
      it('Then it switches', async () => {
        // Arrange
        const { ctx, blobs, headTree, targetTree } = await buildFixture();
        await writeWork(ctx, 'b', 'new');
        const currentIndex = indexOf([
          makeIndexEntry('b', blobs.new as ObjectId),
          makeIndexEntry('c', blobs.same as ObjectId),
        ]);

        // Act
        const result = await materializeTree(ctx, { targetTree, currentIndex, headTree });

        // Assert
        const byPath = new Map(result.newIndexEntries.map((e) => [e.path, e.id]));
        expect(byPath.get('b' as FilePath)).toBe(blobs.new);
        expect(byPath.get('z' as FilePath)).toBe(blobs.zed);
      });
    });
  });

  describe('Given b deleted from the index where the target changes b', () => {
    describe('When the branch switch materialises', () => {
      it('Then it refuses with b', async () => {
        // Arrange
        const { ctx, blobs, headTree, targetTree } = await buildFixture();
        const currentIndex = indexOf([makeIndexEntry('c', blobs.same as ObjectId)]);

        // Act
        const data = await refusalOf(() =>
          materializeTree(ctx, { targetTree, currentIndex, headTree }),
        );

        // Assert
        expect(data).toEqual({
          code: 'CHECKOUT_OVERWRITE_DIRTY',
          localChanges: ['b'],
          untracked: [],
        });
      });
    });
  });

  describe('Given z staged where the target adds a different z', () => {
    describe('When the branch switch materialises', () => {
      it('Then it refuses with z and touches nothing', async () => {
        // Arrange
        const { ctx, blobs, headTree, targetTree } = await buildFixture();
        await writeWork(ctx, 'z', 'staged');
        const currentIndex = indexOf([
          makeIndexEntry('b', blobs.old as ObjectId),
          makeIndexEntry('c', blobs.same as ObjectId),
          makeIndexEntry('z', blobs.staged as ObjectId),
        ]);

        // Act
        const data = await refusalOf(() =>
          materializeTree(ctx, { targetTree, currentIndex, headTree }),
        );

        // Assert
        expect(data).toEqual({
          code: 'CHECKOUT_OVERWRITE_DIRTY',
          localChanges: ['z'],
          untracked: [],
        });
        expect(await readWork(ctx, 'z')).toBe('staged');
        expect(await readWork(ctx, 'b')).toBe('old');
      });
    });
  });

  describe('Given several paths staged away from head and target', () => {
    describe('When the branch switch materialises', () => {
      it('Then every refused path is listed, sorted', async () => {
        // Arrange
        const { ctx, blobs, headTree, targetTree } = await buildFixture();
        const currentIndex = indexOf([
          makeIndexEntry('b', blobs.staged as ObjectId),
          makeIndexEntry('c', blobs.same as ObjectId),
          makeIndexEntry('z', blobs.staged as ObjectId),
        ]);

        // Act
        const data = await refusalOf(() =>
          materializeTree(ctx, { targetTree, currentIndex, headTree }),
        );

        // Assert
        expect(data).toMatchObject({ localChanges: ['b', 'z'] });
      });
    });
  });

  describe('Given a sparse switch and c staged inside the pattern', () => {
    describe('When the branch switch materialises', () => {
      it('Then c keeps the staged entry', async () => {
        // Arrange
        const { ctx, blobs, headTree, targetTree } = await buildFixture();
        await writeWork(ctx, 'c', 'staged');
        const currentIndex = indexOf([
          makeIndexEntry('b', blobs.old as ObjectId),
          makeIndexEntry('c', blobs.staged as ObjectId),
        ]);

        // Act
        const result = await materializeTree(ctx, {
          targetTree,
          currentIndex,
          headTree,
          sparse: () => true,
        });

        // Assert
        const kept = result.newIndexEntries.find((e) => e.path === ('c' as FilePath));
        expect(kept?.id).toBe(blobs.staged);
        expect(await readWork(ctx, 'c')).toBe('staged');
      });
    });
  });

  describe('Given a sparse switch and c outside the pattern, unchanged', () => {
    describe('When the branch switch materialises', () => {
      it('Then c becomes skip-worktree at the target version', async () => {
        // Arrange
        const { ctx, blobs, headTree, targetTree } = await buildFixture();
        const currentIndex = indexOf([
          makeIndexEntry('b', blobs.old as ObjectId),
          makeIndexEntry('c', blobs.same as ObjectId),
        ]);

        // Act
        const result = await materializeTree(ctx, {
          targetTree,
          currentIndex,
          headTree,
          sparse: (path) => path !== 'c',
        });

        // Assert
        const moved = result.newIndexEntries.find((e) => e.path === ('c' as FilePath));
        expect(moved?.id).toBe(blobs.same);
        expect(moved?.flags.skipWorktree).toBe(true);
      });
    });
  });

  describe('Given a sparse switch and c skip-worktree in the index, now inside the pattern', () => {
    describe('When the branch switch materialises', () => {
      it('Then c is materialised', async () => {
        // Arrange
        const { ctx, blobs, headTree, targetTree } = await buildFixture();
        await ctx.fs.rm(`${ctx.layout.workDir}/c`);
        const hidden = makeIndexEntry('c', blobs.same as ObjectId);
        const currentIndex = indexOf([
          makeIndexEntry('b', blobs.old as ObjectId),
          { ...hidden, flags: { ...hidden.flags, skipWorktree: true } },
        ]);

        // Act
        await materializeTree(ctx, { targetTree, currentIndex, headTree, sparse: () => true });

        // Assert
        expect(await readWork(ctx, 'c')).toBe('same');
      });
    });
  });
});
