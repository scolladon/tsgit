import { describe, expect, it } from 'vitest';
import { applyMergeToWorktree } from '../../../../src/application/primitives/apply-merge-to-worktree.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { GitIndex, IndexEntry } from '../../../../src/domain/git-index/index.js';
import { STAGE0_FLAGS } from '../../../../src/domain/git-index/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type {
  FileMode,
  FilePath,
  ObjectId,
  TreeEntry,
} from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { buildSeededContext } from './fixtures.js';

const writeBlob = (ctx: Context, content: string): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'blob',
    content: new TextEncoder().encode(content),
    id: '' as ObjectId,
  });

const treeWith = (ctx: Context, entries: ReadonlyArray<TreeEntry>): Promise<ObjectId> =>
  writeTree(ctx, [...entries]);

const indexEntry = (
  path: string,
  id: ObjectId,
  mode: FileMode = FILE_MODE.REGULAR,
): IndexEntry => ({
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: 0,
  mtimeNanoseconds: 0,
  dev: 0,
  ino: 0,
  mode,
  uid: 0,
  gid: 0,
  fileSize: 0,
  id,
  flags: STAGE0_FLAGS,
  path: path as FilePath,
});

const index = (entries: ReadonlyArray<IndexEntry>): GitIndex => ({
  version: 2,
  entries,
  extensions: [],
  trailerSha: new Uint8Array(0),
});

const readWork = async (ctx: Context, path: string): Promise<string> =>
  new TextDecoder().decode(await ctx.fs.read(`${ctx.layout.workDir}/${path}`));

describe('applyMergeToWorktree', () => {
  describe('Given a stash that changes a clean tracked file', () => {
    describe('When the merge is applied', () => {
      it('Then it is clean and the working tree takes the stashed content', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const v1 = await writeBlob(ctx, 'one\n');
        const v2 = await writeBlob(ctx, 'two\n');
        const base = await treeWith(ctx, [
          { name: 'a' as FilePath, id: v1, mode: FILE_MODE.REGULAR },
        ]);
        const ours = base;
        const theirs = await treeWith(ctx, [
          { name: 'a' as FilePath, id: v2, mode: FILE_MODE.REGULAR },
        ]);
        await ctx.fs.write(`${ctx.layout.workDir}/a`, new TextEncoder().encode('one\n'));

        // Act
        const sut = await applyMergeToWorktree(ctx, {
          baseTree: base,
          oursTree: ours,
          theirsTree: theirs,
          currentIndex: index([indexEntry('a', v1)]),
        });

        // Assert
        expect(sut.kind).toBe('clean');
        expect(await readWork(ctx, 'a')).toBe('two\n');
      });
    });
  });

  describe('Given non-overlapping edits on both sides', () => {
    describe('When the merge is applied', () => {
      it('Then it cleanly line-merges and writes the combined content', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const b = await writeBlob(ctx, 'a\nb\nc\n');
        const o = await writeBlob(ctx, 'A\nb\nc\n');
        const t = await writeBlob(ctx, 'a\nb\nC\n');
        const base = await treeWith(ctx, [
          { name: 'f' as FilePath, id: b, mode: FILE_MODE.REGULAR },
        ]);
        const ours = await treeWith(ctx, [
          { name: 'f' as FilePath, id: o, mode: FILE_MODE.REGULAR },
        ]);
        const theirs = await treeWith(ctx, [
          { name: 'f' as FilePath, id: t, mode: FILE_MODE.REGULAR },
        ]);
        await ctx.fs.write(`${ctx.layout.workDir}/f`, new TextEncoder().encode('A\nb\nc\n'));

        // Act
        const sut = await applyMergeToWorktree(ctx, {
          baseTree: base,
          oursTree: ours,
          theirsTree: theirs,
          currentIndex: index([indexEntry('f', o)]),
        });

        // Assert
        expect(sut.kind).toBe('clean');
        expect(await readWork(ctx, 'f')).toBe('A\nb\nC\n');
      });
    });
  });

  describe('Given a file the stash deletes', () => {
    describe('When the merge is applied', () => {
      it('Then it cleanly removes the file from the working tree', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const x = await writeBlob(ctx, 'x\n');
        const y = await writeBlob(ctx, 'y\n');
        const base = await treeWith(ctx, [
          { name: 'a' as FilePath, id: x, mode: FILE_MODE.REGULAR },
          { name: 'b' as FilePath, id: y, mode: FILE_MODE.REGULAR },
        ]);
        const theirs = await treeWith(ctx, [
          { name: 'a' as FilePath, id: x, mode: FILE_MODE.REGULAR },
        ]);
        await ctx.fs.write(`${ctx.layout.workDir}/a`, new TextEncoder().encode('x\n'));
        await ctx.fs.write(`${ctx.layout.workDir}/b`, new TextEncoder().encode('y\n'));

        // Act
        const sut = await applyMergeToWorktree(ctx, {
          baseTree: base,
          oursTree: base,
          theirsTree: theirs,
          currentIndex: index([indexEntry('a', x), indexEntry('b', y)]),
        });

        // Assert
        expect(sut.kind).toBe('clean');
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/b`)).toBe(false);
      });
    });
  });

  describe('Given a stash whose tree equals ours', () => {
    describe('When the merge is applied', () => {
      it('Then it is clean and nothing is written', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const v1 = await writeBlob(ctx, 'one\n');
        const base = await treeWith(ctx, [
          { name: 'a' as FilePath, id: v1, mode: FILE_MODE.REGULAR },
        ]);
        await ctx.fs.write(`${ctx.layout.workDir}/a`, new TextEncoder().encode('one\n'));

        // Act
        const sut = await applyMergeToWorktree(ctx, {
          baseTree: base,
          oursTree: base,
          theirsTree: base,
          currentIndex: index([indexEntry('a', v1)]),
        });

        // Assert
        expect(sut.kind).toBe('clean');
        if (sut.kind === 'clean') expect(sut.result.written).toBe(0);
      });
    });
  });

  describe('Given ours and theirs both changed the same file differently', () => {
    describe('When the merge is applied', () => {
      it('Then it conflicts, writes markers, and yields stage 1/2/3 index entries', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const b = await writeBlob(ctx, 'base\n');
        const o = await writeBlob(ctx, 'ours\n');
        const t = await writeBlob(ctx, 'theirs\n');
        const base = await treeWith(ctx, [
          { name: 'a' as FilePath, id: b, mode: FILE_MODE.REGULAR },
        ]);
        const ours = await treeWith(ctx, [
          { name: 'a' as FilePath, id: o, mode: FILE_MODE.REGULAR },
        ]);
        const theirs = await treeWith(ctx, [
          { name: 'a' as FilePath, id: t, mode: FILE_MODE.REGULAR },
        ]);
        await ctx.fs.write(`${ctx.layout.workDir}/a`, new TextEncoder().encode('ours\n'));

        // Act
        const sut = await applyMergeToWorktree(ctx, {
          baseTree: base,
          oursTree: ours,
          theirsTree: theirs,
          currentIndex: index([indexEntry('a', o)]),
        });

        // Assert
        expect(sut.kind).toBe('conflict');
        if (sut.kind !== 'conflict') return;
        expect(sut.conflicts.map((c) => c.path)).toEqual(['a']);
        expect(sut.conflicts[0]?.type).toBe('content');
        const onDisk = await readWork(ctx, 'a');
        expect(onDisk).toContain('<<<<<<<');
        expect(onDisk).toContain('ours');
        expect(onDisk).toContain('theirs');
        const stages = sut.indexEntries.filter((e) => e.path === 'a').map((e) => e.flags.stage);
        expect(stages).toEqual([1, 2, 3]);
      });
    });
  });

  describe('Given a changed path that is dirty in the working tree', () => {
    describe('When the merge is applied', () => {
      it('Then it refuses with would-overwrite and writes nothing', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const v1 = await writeBlob(ctx, 'one\n');
        const v2 = await writeBlob(ctx, 'two\n');
        const base = await treeWith(ctx, [
          { name: 'a' as FilePath, id: v1, mode: FILE_MODE.REGULAR },
        ]);
        const theirs = await treeWith(ctx, [
          { name: 'a' as FilePath, id: v2, mode: FILE_MODE.REGULAR },
        ]);
        await ctx.fs.write(`${ctx.layout.workDir}/a`, new TextEncoder().encode('local edit\n'));

        // Act
        const sut = await applyMergeToWorktree(ctx, {
          baseTree: base,
          oursTree: base,
          theirsTree: theirs,
          currentIndex: index([indexEntry('a', v1)]),
        });

        // Assert
        expect(sut.kind).toBe('would-overwrite');
        if (sut.kind === 'would-overwrite') expect(sut.paths).toEqual(['a']);
        expect(await readWork(ctx, 'a')).toBe('local edit\n');
      });
    });
  });

  describe('Given an untracked working file at a path the merge adds', () => {
    describe('When the merge is applied', () => {
      it('Then it refuses with would-overwrite (clobber guard)', async () => {
        // Arrange — theirs adds `new`; an untracked `new` already sits on disk.
        const ctx = await buildSeededContext();
        const v1 = await writeBlob(ctx, 'added\n');
        const base = await treeWith(ctx, []);
        const theirs = await treeWith(ctx, [
          { name: 'new' as FilePath, id: v1, mode: FILE_MODE.REGULAR },
        ]);
        await ctx.fs.write(`${ctx.layout.workDir}/new`, new TextEncoder().encode('in the way\n'));

        // Act
        const sut = await applyMergeToWorktree(ctx, {
          baseTree: base,
          oursTree: base,
          theirsTree: theirs,
          currentIndex: index([]),
        });

        // Assert
        expect(sut.kind).toBe('would-overwrite');
        if (sut.kind === 'would-overwrite') expect(sut.paths).toEqual(['new']);
        expect(await readWork(ctx, 'new')).toBe('in the way\n');
      });
    });
  });

  describe('Given ours modified a file that theirs deleted', () => {
    describe('When the merge is applied', () => {
      it('Then it is a modify-delete conflict keeping the surviving content', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const b = await writeBlob(ctx, 'base\n');
        const o = await writeBlob(ctx, 'mine\n');
        const base = await treeWith(ctx, [
          { name: 'a' as FilePath, id: b, mode: FILE_MODE.REGULAR },
        ]);
        const ours = await treeWith(ctx, [
          { name: 'a' as FilePath, id: o, mode: FILE_MODE.REGULAR },
        ]);
        const theirs = await treeWith(ctx, []);
        await ctx.fs.write(`${ctx.layout.workDir}/a`, new TextEncoder().encode('mine\n'));

        // Act
        const sut = await applyMergeToWorktree(ctx, {
          baseTree: base,
          oursTree: ours,
          theirsTree: theirs,
          currentIndex: index([indexEntry('a', o)]),
        });

        // Assert
        expect(sut.kind).toBe('conflict');
        if (sut.kind !== 'conflict') return;
        expect(sut.conflicts[0]?.type).toBe('modify-delete');
        expect(await readWork(ctx, 'a')).toBe('mine\n');
      });
    });
  });

  describe('Given a conflict alongside a clean change and a clean deletion', () => {
    describe('When the merge is applied', () => {
      it('Then markers + clean writes + deletion all land and the index sorts by path', async () => {
        // Arrange — a conflicts; b is cleanly taken from theirs; c is cleanly deleted.
        const ctx = await buildSeededContext();
        const aBase = await writeBlob(ctx, 'a-base\n');
        const aOurs = await writeBlob(ctx, 'a-ours\n');
        const aTheirs = await writeBlob(ctx, 'a-theirs\n');
        const bId = await writeBlob(ctx, 'b\n');
        const bNew = await writeBlob(ctx, 'b-new\n');
        const cId = await writeBlob(ctx, 'c\n');
        const reg = FILE_MODE.REGULAR;
        const base = await treeWith(ctx, [
          { name: 'a' as FilePath, id: aBase, mode: reg },
          { name: 'b' as FilePath, id: bId, mode: reg },
          { name: 'c' as FilePath, id: cId, mode: reg },
        ]);
        const ours = await treeWith(ctx, [
          { name: 'a' as FilePath, id: aOurs, mode: reg },
          { name: 'b' as FilePath, id: bId, mode: reg },
          { name: 'c' as FilePath, id: cId, mode: reg },
        ]);
        const theirs = await treeWith(ctx, [
          { name: 'a' as FilePath, id: aTheirs, mode: reg },
          { name: 'b' as FilePath, id: bNew, mode: reg },
        ]);
        for (const [p, c] of [
          ['a', 'a-ours\n'],
          ['b', 'b\n'],
          ['c', 'c\n'],
        ] as const) {
          await ctx.fs.write(`${ctx.layout.workDir}/${p}`, new TextEncoder().encode(c));
        }

        // Act
        const sut = await applyMergeToWorktree(ctx, {
          baseTree: base,
          oursTree: ours,
          theirsTree: theirs,
          currentIndex: index([indexEntry('a', aOurs), indexEntry('b', bId), indexEntry('c', cId)]),
        });

        // Assert
        expect(sut.kind).toBe('conflict');
        if (sut.kind !== 'conflict') return;
        expect(await readWork(ctx, 'a')).toContain('<<<<<<<');
        expect(await readWork(ctx, 'b')).toBe('b-new\n');
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/c`)).toBe(false);
        // Index: a unmerged (1/2/3), b staged (0), sorted a-before-b.
        const aStages = sut.indexEntries.filter((e) => e.path === 'a').map((e) => e.flags.stage);
        expect(aStages).toEqual([1, 2, 3]);
        const paths = sut.indexEntries.map((e) => e.path);
        const posA = paths.findIndex((p) => p === 'a');
        const posB = paths.findIndex((p) => p === 'b');
        expect(posA).toBeLessThan(posB);
      });
    });
  });

  describe('Given a gitlink that diverges on both sides', () => {
    describe('When the merge is applied', () => {
      it('Then it rejects with UNSUPPORTED_OPERATION naming the gitlink type', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const g0 = '0'.repeat(40) as ObjectId;
        const g1 = '1'.repeat(40) as ObjectId;
        const g2 = '2'.repeat(40) as ObjectId;
        const base = await treeWith(ctx, [
          { name: 'm' as FilePath, id: g0, mode: FILE_MODE.GITLINK },
        ]);
        const ours = await treeWith(ctx, [
          { name: 'm' as FilePath, id: g1, mode: FILE_MODE.GITLINK },
        ]);
        const theirs = await treeWith(ctx, [
          { name: 'm' as FilePath, id: g2, mode: FILE_MODE.GITLINK },
        ]);

        // Act
        const act = applyMergeToWorktree(ctx, {
          baseTree: base,
          oursTree: ours,
          theirsTree: theirs,
          currentIndex: index([indexEntry('m', g1, FILE_MODE.GITLINK)]),
        });

        // Assert — pin code + operation + reason so the reject literals are killed.
        await act.catch((err: TsgitError) => {
          expect(err.data.code).toBe('UNSUPPORTED_OPERATION');
          if (err.data.code === 'UNSUPPORTED_OPERATION') {
            expect(err.data.operation).toBe('apply-merge');
            expect(err.data.reason).toContain('gitlink');
          }
        });
        await expect(act).rejects.toBeInstanceOf(TsgitError);
      });
    });
  });
});
