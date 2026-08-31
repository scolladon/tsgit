import { describe, expect, it, vi } from 'vitest';
import {
  applyMergeToWorktree,
  writeMarkedConflict,
} from '../../../../src/application/primitives/apply-merge-to-worktree.js';
import * as writeFileMod from '../../../../src/application/primitives/internal/write-working-tree-file.js';
import * as streamBlobMod from '../../../../src/application/primitives/stream-blob.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { GitIndex, IndexEntry } from '../../../../src/domain/git-index/index.js';
import { STAGE0_FLAGS } from '../../../../src/domain/git-index/index.js';
import type { MergeConflict } from '../../../../src/domain/merge/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type {
  FileMode,
  FilePath,
  ObjectId,
  TreeEntry,
} from '../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
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
        const base = await treeWith(ctx, [treeEntry(FILE_MODE.REGULAR, 'a' as FilePath, v1)]);
        const ours = base;
        const theirs = await treeWith(ctx, [treeEntry(FILE_MODE.REGULAR, 'a' as FilePath, v2)]);
        await ctx.fs.write(`${ctx.layout.workDir}/a`, new TextEncoder().encode('one\n'));

        // Act
        const result = await applyMergeToWorktree(ctx, {
          baseTree: base,
          oursTree: ours,
          theirsTree: theirs,
          currentIndex: index([indexEntry('a', v1)]),
        });

        // Assert
        expect(result.kind).toBe('clean');
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
        const base = await treeWith(ctx, [treeEntry(FILE_MODE.REGULAR, 'f' as FilePath, b)]);
        const ours = await treeWith(ctx, [treeEntry(FILE_MODE.REGULAR, 'f' as FilePath, o)]);
        const theirs = await treeWith(ctx, [treeEntry(FILE_MODE.REGULAR, 'f' as FilePath, t)]);
        await ctx.fs.write(`${ctx.layout.workDir}/f`, new TextEncoder().encode('A\nb\nc\n'));

        // Act
        const result = await applyMergeToWorktree(ctx, {
          baseTree: base,
          oursTree: ours,
          theirsTree: theirs,
          currentIndex: index([indexEntry('f', o)]),
        });

        // Assert
        expect(result.kind).toBe('clean');
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
          treeEntry(FILE_MODE.REGULAR, 'a' as FilePath, x),
          treeEntry(FILE_MODE.REGULAR, 'b' as FilePath, y),
        ]);
        const theirs = await treeWith(ctx, [treeEntry(FILE_MODE.REGULAR, 'a' as FilePath, x)]);
        await ctx.fs.write(`${ctx.layout.workDir}/a`, new TextEncoder().encode('x\n'));
        await ctx.fs.write(`${ctx.layout.workDir}/b`, new TextEncoder().encode('y\n'));

        // Act
        const result = await applyMergeToWorktree(ctx, {
          baseTree: base,
          oursTree: base,
          theirsTree: theirs,
          currentIndex: index([indexEntry('a', x), indexEntry('b', y)]),
        });

        // Assert
        expect(result.kind).toBe('clean');
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
        const base = await treeWith(ctx, [treeEntry(FILE_MODE.REGULAR, 'a' as FilePath, v1)]);
        await ctx.fs.write(`${ctx.layout.workDir}/a`, new TextEncoder().encode('one\n'));

        // Act
        const result = await applyMergeToWorktree(ctx, {
          baseTree: base,
          oursTree: base,
          theirsTree: base,
          currentIndex: index([indexEntry('a', v1)]),
        });

        // Assert
        expect(result.kind).toBe('clean');
        if (result.kind === 'clean') expect(result.result.written).toBe(0);
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
        const base = await treeWith(ctx, [treeEntry(FILE_MODE.REGULAR, 'a' as FilePath, b)]);
        const ours = await treeWith(ctx, [treeEntry(FILE_MODE.REGULAR, 'a' as FilePath, o)]);
        const theirs = await treeWith(ctx, [treeEntry(FILE_MODE.REGULAR, 'a' as FilePath, t)]);
        await ctx.fs.write(`${ctx.layout.workDir}/a`, new TextEncoder().encode('ours\n'));

        // Act
        const result = await applyMergeToWorktree(ctx, {
          baseTree: base,
          oursTree: ours,
          theirsTree: theirs,
          currentIndex: index([indexEntry('a', o)]),
        });

        // Assert
        expect(result.kind).toBe('conflict');
        if (result.kind !== 'conflict') return;
        expect(result.conflicts.map((c) => c.path)).toEqual(['a']);
        expect(result.conflicts[0]?.type).toBe('content');
        const onDisk = await readWork(ctx, 'a');
        expect(onDisk).toContain('<<<<<<<');
        expect(onDisk).toContain('ours');
        expect(onDisk).toContain('theirs');
        const stages = result.indexEntries.filter((e) => e.path === 'a').map((e) => e.flags.stage);
        expect(stages).toEqual([1, 2, 3]);
      });
    });
  });

  describe('Given supplied labels and a content conflict', () => {
    describe('When the merge is applied', () => {
      it('Then the working-tree markers carry the ours / theirs labels', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const b = await writeBlob(ctx, 'base\n');
        const o = await writeBlob(ctx, 'ours\n');
        const t = await writeBlob(ctx, 'theirs\n');
        const base = await treeWith(ctx, [treeEntry(FILE_MODE.REGULAR, 'a' as FilePath, b)]);
        const ours = await treeWith(ctx, [treeEntry(FILE_MODE.REGULAR, 'a' as FilePath, o)]);
        const theirs = await treeWith(ctx, [treeEntry(FILE_MODE.REGULAR, 'a' as FilePath, t)]);
        await ctx.fs.write(`${ctx.layout.workDir}/a`, new TextEncoder().encode('ours\n'));

        // Act
        const result = await applyMergeToWorktree(ctx, {
          baseTree: base,
          oursTree: ours,
          theirsTree: theirs,
          currentIndex: index([indexEntry('a', o)]),
          labels: { ours: 'HEAD', theirs: 'topic', base: 'main' },
        });

        // Assert
        expect(result.kind).toBe('conflict');
        const onDisk = await readWork(ctx, 'a');
        expect(onDisk).toContain('<<<<<<< HEAD\n');
        expect(onDisk).toContain('>>>>>>> topic\n');
      });
    });
  });

  // Once flatten-raw stops refusing `.`/`..` at parse, a merged tree carrying
  // such a name reaches this writer for the first time — it must refuse
  // before any conflict marker touches the working tree. Nested under
  // `sub/` (rather than top-level) so the conflicting path never collides
  // with the work directory's own root, which the top-level case would.
  describe('Given ours and theirs both changed a "sub/."-named path differently', () => {
    describe('When the merge is applied', () => {
      it('Then throws INVALID_INDEX_ENTRY and writes no conflict marker', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const b = await writeBlob(ctx, 'base\n');
        const o = await writeBlob(ctx, 'ours\n');
        const t = await writeBlob(ctx, 'theirs\n');
        const dotEntry = (id: ObjectId): TreeEntry =>
          treeEntry(FILE_MODE.REGULAR, '.' as FilePath, id);
        const base = await treeWith(ctx, [
          treeEntry(FILE_MODE.DIRECTORY, 'sub' as FilePath, await treeWith(ctx, [dotEntry(b)])),
        ]);
        const ours = await treeWith(ctx, [
          treeEntry(FILE_MODE.DIRECTORY, 'sub' as FilePath, await treeWith(ctx, [dotEntry(o)])),
        ]);
        const theirs = await treeWith(ctx, [
          treeEntry(FILE_MODE.DIRECTORY, 'sub' as FilePath, await treeWith(ctx, [dotEntry(t)])),
        ]);
        const writeSpy = vi.spyOn(writeFileMod, 'writeWorkingTreeEntry');

        // Act
        let caught: unknown;
        let writeCallCount: number;
        try {
          await applyMergeToWorktree(ctx, {
            baseTree: base,
            oursTree: ours,
            theirsTree: theirs,
            currentIndex: index([indexEntry('sub/.', o)]),
          });
        } catch (err) {
          caught = err;
        } finally {
          writeCallCount = writeSpy.mock.calls.length;
          writeSpy.mockRestore();
        }

        // Assert
        const data = (caught as { data?: { code?: string; reason?: string; offset?: number } })
          ?.data;
        expect(data?.code).toBe('INVALID_INDEX_ENTRY');
        expect(data?.reason).toBe("'.' segment rejected");
        expect(writeCallCount).toBe(0);
      });
    });
  });

  describe('Given ours and theirs both changed a ".."-named path differently', () => {
    describe('When the merge is applied', () => {
      it('Then throws INVALID_INDEX_ENTRY and writes no conflict marker', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const b = await writeBlob(ctx, 'base\n');
        const o = await writeBlob(ctx, 'ours\n');
        const t = await writeBlob(ctx, 'theirs\n');
        const base = await treeWith(ctx, [treeEntry(FILE_MODE.REGULAR, '..' as FilePath, b)]);
        const ours = await treeWith(ctx, [treeEntry(FILE_MODE.REGULAR, '..' as FilePath, o)]);
        const theirs = await treeWith(ctx, [treeEntry(FILE_MODE.REGULAR, '..' as FilePath, t)]);
        const writeSpy = vi.spyOn(writeFileMod, 'writeWorkingTreeEntry');

        // Act
        let caught: unknown;
        let writeCallCount: number;
        try {
          await applyMergeToWorktree(ctx, {
            baseTree: base,
            oursTree: ours,
            theirsTree: theirs,
            currentIndex: index([indexEntry('..', o)]),
          });
        } catch (err) {
          caught = err;
        } finally {
          writeCallCount = writeSpy.mock.calls.length;
          writeSpy.mockRestore();
        }

        // Assert
        const data = (caught as { data?: { code?: string; reason?: string; offset?: number } })
          ?.data;
        expect(data?.code).toBe('INVALID_INDEX_ENTRY');
        expect(data?.reason).toBe("'..' segment rejected");
        expect(writeCallCount).toBe(0);
      });
    });
  });

  // A `resolved-deleted` outcome's path is sourced from the merge's `ours`
  // tree flatten, never from a parsed index — the path has NOT already
  // passed validation anywhere upstream, so it must be validated like every
  // other outcome. A genuine content conflict on a sibling path forces the
  // conflict-write route (a clean merge never reaches `writeChangedOutcome`).
  describe('Given theirs deletes a ".."-named path while a sibling genuinely conflicts', () => {
    describe('When the merge is applied', () => {
      it('Then throws INVALID_INDEX_ENTRY and does not remove the working-tree file', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const dotdot = await writeBlob(ctx, 'dotdot\n');
        const cb = await writeBlob(ctx, 'base\n');
        const co = await writeBlob(ctx, 'ours\n');
        const ct = await writeBlob(ctx, 'theirs\n');
        const dotdotEntry = treeEntry(FILE_MODE.REGULAR, '..' as FilePath, dotdot);
        const base = await treeWith(ctx, [
          dotdotEntry,
          treeEntry(FILE_MODE.REGULAR, 'c.txt' as FilePath, cb),
        ]);
        const ours = await treeWith(ctx, [
          dotdotEntry,
          treeEntry(FILE_MODE.REGULAR, 'c.txt' as FilePath, co),
        ]);
        const theirs = await treeWith(ctx, [treeEntry(FILE_MODE.REGULAR, 'c.txt' as FilePath, ct)]);
        await ctx.fs.write(`${ctx.layout.workDir}/c.txt`, new TextEncoder().encode('ours\n'));
        const removeSpy = vi.spyOn(writeFileMod, 'removeWorkingTreeFile');

        // Act
        let caught: unknown;
        let removeCallCount: number;
        try {
          await applyMergeToWorktree(ctx, {
            baseTree: base,
            oursTree: ours,
            theirsTree: theirs,
            currentIndex: index([indexEntry('..', dotdot), indexEntry('c.txt', co)]),
          });
        } catch (err) {
          caught = err;
        } finally {
          removeCallCount = removeSpy.mock.calls.length;
          removeSpy.mockRestore();
        }

        // Assert
        const data = (caught as { data?: { code?: string; reason?: string } })?.data;
        expect(data?.code).toBe('INVALID_INDEX_ENTRY');
        expect(data?.reason).toBe("'..' segment rejected");
        expect(removeCallCount).toBe(0);
      });
    });
  });

  // Multi-entry atomicity: under the previous per-outcome-inside-the-write-
  // loop guard, `clean.txt`'s batch ran and completed to disk BEFORE the
  // conflicts batch ever reached the hostile path's refusal. The hoisted
  // whole-set gate must refuse before either path is written.
  describe('Given a conflicting merge where one changed path is hostile and a sibling path is clean', () => {
    describe('When the merge is applied', () => {
      it('Then throws INVALID_INDEX_ENTRY and the clean sibling is never written', async () => {
        // Arrange — `sub/.` conflicts (both sides change it differently from
        // base); `clean.txt` is changed by theirs only and resolves cleanly.
        const ctx = await buildSeededContext();
        const cleanBase = await writeBlob(ctx, 'base-clean\n');
        const cleanTheirs = await writeBlob(ctx, 'THEIRS-CLEAN\n');
        const dotBase = await writeBlob(ctx, 'base\n');
        const dotOurs = await writeBlob(ctx, 'ours\n');
        const dotTheirs = await writeBlob(ctx, 'theirs\n');
        const dotEntry = (id: ObjectId): TreeEntry =>
          treeEntry(FILE_MODE.REGULAR, '.' as FilePath, id);
        const base = await treeWith(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'clean.txt' as FilePath, cleanBase),
          treeEntry(
            FILE_MODE.DIRECTORY,
            'sub' as FilePath,
            await treeWith(ctx, [dotEntry(dotBase)]),
          ),
        ]);
        const ours = await treeWith(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'clean.txt' as FilePath, cleanBase),
          treeEntry(
            FILE_MODE.DIRECTORY,
            'sub' as FilePath,
            await treeWith(ctx, [dotEntry(dotOurs)]),
          ),
        ]);
        const theirs = await treeWith(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'clean.txt' as FilePath, cleanTheirs),
          treeEntry(
            FILE_MODE.DIRECTORY,
            'sub' as FilePath,
            await treeWith(ctx, [dotEntry(dotTheirs)]),
          ),
        ]);

        // Act
        let caught: unknown;
        try {
          await applyMergeToWorktree(ctx, {
            baseTree: base,
            oursTree: ours,
            theirsTree: theirs,
            currentIndex: index([indexEntry('clean.txt', cleanBase), indexEntry('sub/.', dotOurs)]),
          });
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = (caught as { data?: { code?: string; reason?: string } })?.data;
        expect(data?.code).toBe('INVALID_INDEX_ENTRY');
        expect(data?.reason).toBe("'.' segment rejected");
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/clean.txt`)).toBe(false);
      });
    });
  });

  // The counterpart to the test above: THERE the hostile name was the
  // conflict and the clean sibling was innocuous; HERE the hostile name is
  // itself the CLEAN (`resolved-known`) outcome, reached only through
  // `validateConflictWorktreePaths`'s `outcomes` loop, never its `conflicts`
  // loop — a gap neither existing hostile-name test exercises, since both
  // arrange `sub/.`/`..` as the conflict itself.
  describe('Given only theirs changes a "sub/."-named path while a sibling genuinely conflicts', () => {
    describe('When the merge is applied', () => {
      it('Then throws INVALID_INDEX_ENTRY before any working-tree write', async () => {
        // Arrange — `sub/.` is unchanged by ours (clean, resolved-known to
        // theirs' value); `x` conflicts (both sides change it differently).
        const ctx = await buildSeededContext();
        const dotBase = await writeBlob(ctx, 'base\n');
        const dotTheirs = await writeBlob(ctx, 'theirs\n');
        const dotEntry = (id: ObjectId): TreeEntry =>
          treeEntry(FILE_MODE.REGULAR, '.' as FilePath, id);
        const xBase = await writeBlob(ctx, 'x-base\n');
        const xOurs = await writeBlob(ctx, 'x-ours\n');
        const xTheirs = await writeBlob(ctx, 'x-theirs\n');
        const base = await treeWith(ctx, [
          treeEntry(
            FILE_MODE.DIRECTORY,
            'sub' as FilePath,
            await treeWith(ctx, [dotEntry(dotBase)]),
          ),
          treeEntry(FILE_MODE.REGULAR, 'x' as FilePath, xBase),
        ]);
        const ours = await treeWith(ctx, [
          treeEntry(
            FILE_MODE.DIRECTORY,
            'sub' as FilePath,
            await treeWith(ctx, [dotEntry(dotBase)]),
          ),
          treeEntry(FILE_MODE.REGULAR, 'x' as FilePath, xOurs),
        ]);
        const theirs = await treeWith(ctx, [
          treeEntry(
            FILE_MODE.DIRECTORY,
            'sub' as FilePath,
            await treeWith(ctx, [dotEntry(dotTheirs)]),
          ),
          treeEntry(FILE_MODE.REGULAR, 'x' as FilePath, xTheirs),
        ]);
        const streamSpy = vi.spyOn(writeFileMod, 'writeWorkingTreeFileStream');
        const entrySpy = vi.spyOn(writeFileMod, 'writeWorkingTreeEntry');

        // Act
        let caught: unknown;
        try {
          await applyMergeToWorktree(ctx, {
            baseTree: base,
            oursTree: ours,
            theirsTree: theirs,
            currentIndex: index([indexEntry('sub/.', dotBase), indexEntry('x', xOurs)]),
          });
        } catch (err) {
          caught = err;
        } finally {
          streamSpy.mockRestore();
          entrySpy.mockRestore();
        }

        // Assert
        const data = (caught as { data?: { code?: string; reason?: string } })?.data;
        expect(data?.code).toBe('INVALID_INDEX_ENTRY');
        expect(data?.reason).toBe("'.' segment rejected");
        expect(streamSpy).not.toHaveBeenCalled();
        expect(entrySpy).not.toHaveBeenCalled();
      });
    });
  });

  // No test exercised a `distinct-types` conflict at a hostile path: the
  // dispatch to `writeDistinctTypesSides` writes at the conflict's renamed
  // `ourPath`/`theirPath` (e.g. `..~ours`), which are themselves NOT
  // hostile — only the un-renamed `conflict.path` carries the hostile name,
  // so this pins that a distinct-types conflict is refused there too, the
  // same as every other conflict type.
  describe('Given a distinct-types conflict at a ".."-named path', () => {
    describe('When the merge is applied', () => {
      it('Then throws INVALID_INDEX_ENTRY before writing either side', async () => {
        // Arrange — ours turns '..' into a symlink while theirs edits its
        // content differently, both away from base: a distinct-types
        // conflict whose recorded `path` is the hostile name itself.
        const ctx = await buildSeededContext();
        const b = await writeBlob(ctx, 'base\n');
        const symlinkTarget = await writeBlob(ctx, 'target');
        const t = await writeBlob(ctx, 'theirs\n');
        const base = await treeWith(ctx, [treeEntry(FILE_MODE.REGULAR, '..' as FilePath, b)]);
        const ours = await treeWith(ctx, [
          treeEntry(FILE_MODE.SYMLINK, '..' as FilePath, symlinkTarget),
        ]);
        const theirs = await treeWith(ctx, [treeEntry(FILE_MODE.REGULAR, '..' as FilePath, t)]);
        const entrySpy = vi.spyOn(writeFileMod, 'writeWorkingTreeEntry');

        // Act
        let caught: unknown;
        try {
          await applyMergeToWorktree(ctx, {
            baseTree: base,
            oursTree: ours,
            theirsTree: theirs,
            currentIndex: index([indexEntry('..', symlinkTarget, FILE_MODE.SYMLINK)]),
          });
        } catch (err) {
          caught = err;
        } finally {
          entrySpy.mockRestore();
        }

        // Assert
        const data = (caught as { data?: { code?: string; reason?: string } })?.data;
        expect(data?.code).toBe('INVALID_INDEX_ENTRY');
        expect(data?.reason).toBe("'..' segment rejected");
        expect(entrySpy).not.toHaveBeenCalled();
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
        const base = await treeWith(ctx, [treeEntry(FILE_MODE.REGULAR, 'a' as FilePath, v1)]);
        const theirs = await treeWith(ctx, [treeEntry(FILE_MODE.REGULAR, 'a' as FilePath, v2)]);
        await ctx.fs.write(`${ctx.layout.workDir}/a`, new TextEncoder().encode('local edit\n'));

        // Act
        const result = await applyMergeToWorktree(ctx, {
          baseTree: base,
          oursTree: base,
          theirsTree: theirs,
          currentIndex: index([indexEntry('a', v1)]),
        });

        // Assert
        expect(result.kind).toBe('would-overwrite');
        if (result.kind === 'would-overwrite') {
          expect(result.localChanges).toEqual(['a']);
          expect(result.untracked).toEqual([]);
        }
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
        const theirs = await treeWith(ctx, [treeEntry(FILE_MODE.REGULAR, 'new' as FilePath, v1)]);
        await ctx.fs.write(`${ctx.layout.workDir}/new`, new TextEncoder().encode('in the way\n'));

        // Act
        const result = await applyMergeToWorktree(ctx, {
          baseTree: base,
          oursTree: base,
          theirsTree: theirs,
          currentIndex: index([]),
        });

        // Assert
        expect(result.kind).toBe('would-overwrite');
        if (result.kind === 'would-overwrite') {
          expect(result.untracked).toEqual(['new']);
          expect(result.localChanges).toEqual([]);
        }
        expect(await readWork(ctx, 'new')).toBe('in the way\n');
      });
    });
  });

  describe('Given ours deleted a file that theirs modified', () => {
    describe('When the merge is applied', () => {
      it('Then it is a modify-delete conflict that restores the surviving (theirs) content', async () => {
        // Arrange — ours deletes `a` (so it is absent on disk); theirs modifies it.
        // The surviving content must be WRITTEN, which is only observable because the
        // working file starts absent.
        const ctx = await buildSeededContext();
        const b = await writeBlob(ctx, 'base\n');
        const t = await writeBlob(ctx, 'theirs\n');
        const base = await treeWith(ctx, [treeEntry(FILE_MODE.REGULAR, 'a' as FilePath, b)]);
        const ours = await treeWith(ctx, []);
        const theirs = await treeWith(ctx, [treeEntry(FILE_MODE.REGULAR, 'a' as FilePath, t)]);
        // ours deleted `a`, so the working tree has no `a`.

        // Act
        const result = await applyMergeToWorktree(ctx, {
          baseTree: base,
          oursTree: ours,
          theirsTree: theirs,
          currentIndex: index([]),
        });

        // Assert
        expect(result.kind).toBe('conflict');
        if (result.kind !== 'conflict') return;
        expect(result.conflicts[0]?.type).toBe('modify-delete');
        expect(await readWork(ctx, 'a')).toBe('theirs\n');
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
        // d is a clean line-merge (ours edits line 1, theirs edits line 3) → resolved-merged.
        const dBase = await writeBlob(ctx, 'd1\nd2\nd3\n');
        const dOurs = await writeBlob(ctx, 'D1\nd2\nd3\n');
        const dTheirs = await writeBlob(ctx, 'd1\nd2\nD3\n');
        const reg = FILE_MODE.REGULAR;
        const base = await treeWith(ctx, [
          treeEntry(reg, 'a' as FilePath, aBase),
          treeEntry(reg, 'b' as FilePath, bId),
          treeEntry(reg, 'c' as FilePath, cId),
          treeEntry(reg, 'd' as FilePath, dBase),
        ]);
        const ours = await treeWith(ctx, [
          treeEntry(reg, 'a' as FilePath, aOurs),
          treeEntry(reg, 'b' as FilePath, bId),
          treeEntry(reg, 'c' as FilePath, cId),
          treeEntry(reg, 'd' as FilePath, dOurs),
        ]);
        const theirs = await treeWith(ctx, [
          treeEntry(reg, 'a' as FilePath, aTheirs),
          treeEntry(reg, 'b' as FilePath, bNew),
          treeEntry(reg, 'd' as FilePath, dTheirs),
        ]);
        for (const [p, c] of [
          ['a', 'a-ours\n'],
          ['b', 'b\n'],
          ['c', 'c\n'],
          ['d', 'D1\nd2\nd3\n'],
        ] as const) {
          await ctx.fs.write(`${ctx.layout.workDir}/${p}`, new TextEncoder().encode(c));
        }

        // Act
        const result = await applyMergeToWorktree(ctx, {
          baseTree: base,
          oursTree: ours,
          theirsTree: theirs,
          currentIndex: index([
            indexEntry('a', aOurs),
            indexEntry('b', bId),
            indexEntry('c', cId),
            indexEntry('d', dOurs),
          ]),
        });

        // Assert
        expect(result.kind).toBe('conflict');
        if (result.kind !== 'conflict') return;
        expect(await readWork(ctx, 'a')).toContain('<<<<<<<');
        expect(await readWork(ctx, 'b')).toBe('b-new\n');
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/c`)).toBe(false);
        // d cleanly line-merged in the conflict path (resolved-merged → bytes written).
        expect(await readWork(ctx, 'd')).toBe('D1\nd2\nD3\n');
        // Index: a unmerged (1/2/3), b staged (0), sorted a-before-b.
        const aStages = result.indexEntries.filter((e) => e.path === 'a').map((e) => e.flags.stage);
        expect(aStages).toEqual([1, 2, 3]);
        const paths = result.indexEntries.map((e) => e.path);
        const posA = paths.indexOf('a' as FilePath);
        const posB = paths.indexOf('b' as FilePath);
        expect(posA).toBeLessThan(posB);
      });
    });
  });

  describe('Given both sides add the same regular-file path (no base entry) with diverging content', () => {
    describe('When the merge is applied', () => {
      it('Then the worktree file contains per-region conflict markers (not ours bytes) and the index has stages 2/3 only', async () => {
        // Arrange — no base tree; ours adds `f` with "shared\nours\n", theirs adds `f` with "shared\ntheirs\n"
        const ctx = await buildSeededContext();
        const oursId = await writeBlob(ctx, 'shared\nours\n');
        const theirsId = await writeBlob(ctx, 'shared\ntheirs\n');
        const emptyBase = await treeWith(ctx, []);
        const oursTree = await treeWith(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'f' as FilePath, oursId),
        ]);
        const theirsTree = await treeWith(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'f' as FilePath, theirsId),
        ]);
        await ctx.fs.write(`${ctx.layout.workDir}/f`, new TextEncoder().encode('shared\nours\n'));

        // Act
        const result = await applyMergeToWorktree(ctx, {
          baseTree: emptyBase,
          oursTree,
          theirsTree,
          currentIndex: index([indexEntry('f', oursId)]),
          labels: { ours: 'HEAD', theirs: 'side', base: 'base' },
        });

        // Assert
        expect(result.kind).toBe('conflict');
        if (result.kind !== 'conflict') return;
        expect(result.conflicts[0]?.type).toBe('add-add');
        const onDisk = await readWork(ctx, 'f');
        // Must contain conflict markers — not just ours bytes
        expect(onDisk).toContain('<<<<<<<');
        expect(onDisk).toContain('shared');
        expect(onDisk).toContain('ours');
        expect(onDisk).toContain('theirs');
        // The marker bytes must differ from ours' raw content
        expect(onDisk).not.toBe('shared\nours\n');
        const stages = result.indexEntries.filter((e) => e.path === 'f').map((e) => e.flags.stage);
        // Only stages 2/3 (no base → no stage 1)
        expect(stages).toEqual([2, 3]);
      });
    });
  });

  describe('Given both sides add the same symlink path (no base entry) with different targets', () => {
    describe('When the merge is applied', () => {
      it('Then the worktree keeps ours as a symlink (not a regular file) and the index has stages 2/3', async () => {
        // Arrange — no base tree; both sides add `f` as a symlink with different targets
        const ctx = await buildSeededContext();
        const oursId = await writeBlob(ctx, 'target-ours');
        const theirsId = await writeBlob(ctx, 'target-theirs');
        const emptyBase = await treeWith(ctx, []);
        const oursTree = await treeWith(ctx, [
          treeEntry(FILE_MODE.SYMLINK, 'f' as FilePath, oursId),
        ]);
        const theirsTree = await treeWith(ctx, [
          treeEntry(FILE_MODE.SYMLINK, 'f' as FilePath, theirsId),
        ]);
        await ctx.fs.symlink('target-ours', `${ctx.layout.workDir}/f`);

        // Act
        const result = await applyMergeToWorktree(ctx, {
          baseTree: emptyBase,
          oursTree,
          theirsTree,
          currentIndex: index([indexEntry('f', oursId, FILE_MODE.SYMLINK)]),
          labels: { ours: 'HEAD', theirs: 'side', base: 'base' },
        });

        // Assert
        expect(result.kind).toBe('conflict');
        if (result.kind !== 'conflict') return;
        expect(result.conflicts[0]?.type).toBe('add-add');
        expect(result.conflicts[0]?.contentVerdict).toBeUndefined();
        const linkTarget = await ctx.fs.readlink(`${ctx.layout.workDir}/f`);
        expect(linkTarget).toBe('target-ours');
        const stages = result.indexEntries.filter((e) => e.path === 'f').map((e) => e.flags.stage);
        expect(stages).toEqual([2, 3]);
      });
    });
  });

  describe('Given both sides add the same path as distinct types (regular ours, symlink theirs)', () => {
    describe('When the merge is applied', () => {
      it('Then both recorded paths are written: regular file at ourPath and symlink at theirPath, index has stage 2/3 at recorded paths', async () => {
        // Arrange — ours adds `f` as regular file; theirs adds `f` as symlink
        const ctx = await buildSeededContext();
        const fileContent = new TextEncoder().encode('file content\n');
        const linkTarget = new TextEncoder().encode('/etc/target');
        const oursId = await writeObject(ctx, {
          type: 'blob',
          content: fileContent,
          id: '' as ObjectId,
        });
        const theirsId = await writeObject(ctx, {
          type: 'blob',
          content: linkTarget,
          id: '' as ObjectId,
        });
        const emptyBase = await treeWith(ctx, []);
        const oursTree = await treeWith(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'f' as FilePath, oursId),
        ]);
        const theirsTree = await treeWith(ctx, [
          treeEntry(FILE_MODE.SYMLINK, 'f' as FilePath, theirsId),
        ]);
        await ctx.fs.write(`${ctx.layout.workDir}/f`, fileContent);

        // Act
        const result = await applyMergeToWorktree(ctx, {
          baseTree: emptyBase,
          oursTree,
          theirsTree,
          currentIndex: index([indexEntry('f', oursId)]),
          labels: { ours: 'HEAD', theirs: 'side', base: 'base' },
        });

        // Assert
        expect(result.kind).toBe('conflict');
        if (result.kind !== 'conflict') return;
        expect(result.conflicts[0]?.type).toBe('distinct-types');
        const conflict = result.conflicts[0];
        if (conflict?.type !== 'distinct-types') return;
        // Regular file written at ourPath (~HEAD); symlink written at theirPath (f keeps symlink)
        const ourPath = conflict.ourPath;
        const theirPath = conflict.theirPath;
        expect(ourPath).toBeDefined();
        expect(theirPath).toBeDefined();
        // The regular-file side gets renamed to f~HEAD
        const ourContent = new TextDecoder().decode(
          await ctx.fs.read(`${ctx.layout.workDir}/${ourPath}`),
        );
        expect(ourContent).toBe('file content\n');
        // The symlink side keeps f (theirPath = f)
        const linkActualTarget = await ctx.fs.readlink(`${ctx.layout.workDir}/${theirPath}`);
        expect(linkActualTarget).toBe('/etc/target');
        // Index: stage 2 at ourPath, stage 3 at theirPath
        const stage2 = result.indexEntries.find((e) => e.path === ourPath && e.flags.stage === 2);
        const stage3 = result.indexEntries.find((e) => e.path === theirPath && e.flags.stage === 3);
        expect(stage2).toBeDefined();
        expect(stage3).toBeDefined();
      });
    });
  });

  describe('Given both sides add the same path as distinct types (symlink ours, regular theirs)', () => {
    describe('When the merge is applied', () => {
      it('Then both recorded paths are written: symlink at ourPath (f) and regular file at theirPath (f~side)', async () => {
        // Arrange — ours adds `f` as symlink; theirs adds `f` as regular file
        const ctx = await buildSeededContext();
        const linkTarget = new TextEncoder().encode('/etc/ours-target');
        const fileContent = new TextEncoder().encode('theirs file\n');
        const oursId = await writeObject(ctx, {
          type: 'blob',
          content: linkTarget,
          id: '' as ObjectId,
        });
        const theirsId = await writeObject(ctx, {
          type: 'blob',
          content: fileContent,
          id: '' as ObjectId,
        });
        const emptyBase = await treeWith(ctx, []);
        const oursTree = await treeWith(ctx, [
          treeEntry(FILE_MODE.SYMLINK, 'f' as FilePath, oursId),
        ]);
        const theirsTree = await treeWith(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'f' as FilePath, theirsId),
        ]);
        // ours is a symlink; working tree has no regular file at 'f'

        // Act
        const result = await applyMergeToWorktree(ctx, {
          baseTree: emptyBase,
          oursTree,
          theirsTree,
          currentIndex: index([]),
          labels: { ours: 'HEAD', theirs: 'side', base: 'base' },
        });

        // Assert
        expect(result.kind).toBe('conflict');
        if (result.kind !== 'conflict') return;
        expect(result.conflicts[0]?.type).toBe('distinct-types');
        const conflict = result.conflicts[0];
        if (conflict?.type !== 'distinct-types') return;
        // The symlink keeps `f` (ourPath=f); the regular file is renamed (theirPath=f~side)
        const ourPath = conflict.ourPath;
        const theirPath = conflict.theirPath;
        expect(ourPath).toBe('f');
        expect(theirPath).toBe('f~side');
        // Symlink written at f
        const linkActualTarget = await ctx.fs.readlink(`${ctx.layout.workDir}/${ourPath}`);
        expect(linkActualTarget).toBe('/etc/ours-target');
        // Regular file written at f~side
        const theirContent = new TextDecoder().decode(
          await ctx.fs.read(`${ctx.layout.workDir}/${theirPath}`),
        );
        expect(theirContent).toBe('theirs file\n');
      });
    });
  });

  // The distinct-types mode-selection chain (mergedMode ?? ourMode ??
  // theirMode) must pick ours over theirs when mergedMode is absent (only
  // `content` conflicts carry one) — otherwise a hostile ".gitmodules"
  // symlink from ours could be validated against theirs' (safe) mode
  // instead, or a safe ours mode could be wrongly rejected using theirs'.
  // This case pins the "wrongly rejected" direction: ours is the safe,
  // regular side and must be the one validateIndexPath sees.
  describe('Given a distinct-types conflict at ".gitmodules" (regular ours, symlink theirs)', () => {
    describe('When the merge is applied', () => {
      it('Then it does not refuse the write — ours (regular) is the mode validateIndexPath sees', async () => {
        // Arrange — no base entry; ours adds `.gitmodules` as a regular
        // file, theirs adds it as a symlink.
        const ctx = await buildSeededContext();
        const fileContent = new TextEncoder().encode('[submodule "x"]\n');
        const linkTarget = new TextEncoder().encode('/etc/target');
        const oursId = await writeBlob(ctx, new TextDecoder().decode(fileContent));
        const theirsId = await writeBlob(ctx, new TextDecoder().decode(linkTarget));
        const emptyBase = await treeWith(ctx, []);
        const oursTree = await treeWith(ctx, [
          treeEntry(FILE_MODE.REGULAR, '.gitmodules' as FilePath, oursId),
        ]);
        const theirsTree = await treeWith(ctx, [
          treeEntry(FILE_MODE.SYMLINK, '.gitmodules' as FilePath, theirsId),
        ]);

        // Act
        const result = await applyMergeToWorktree(ctx, {
          baseTree: emptyBase,
          oursTree,
          theirsTree,
          currentIndex: index([]),
          labels: { ours: 'HEAD', theirs: 'side', base: 'base' },
        });

        // Assert
        expect(result.kind).toBe('conflict');
        if (result.kind !== 'conflict') return;
        expect(result.conflicts[0]?.type).toBe('distinct-types');
      });
    });
  });

  describe('Given an untracked file sits at the distinct-types rename target', () => {
    describe('When the merge is applied', () => {
      it('Then it refuses with would-overwrite naming the rename target path, nothing is written', async () => {
        // Arrange — ours adds `f` as regular, theirs as symlink → ourPath becomes f~HEAD
        // An untracked `f~HEAD` already exists on disk
        const ctx = await buildSeededContext();
        const fileContent = new TextEncoder().encode('file content\n');
        const linkTarget = new TextEncoder().encode('/etc/target');
        const oursId = await writeObject(ctx, {
          type: 'blob',
          content: fileContent,
          id: '' as ObjectId,
        });
        const theirsId = await writeObject(ctx, {
          type: 'blob',
          content: linkTarget,
          id: '' as ObjectId,
        });
        const emptyBase = await treeWith(ctx, []);
        const oursTree = await treeWith(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'f' as FilePath, oursId),
        ]);
        const theirsTree = await treeWith(ctx, [
          treeEntry(FILE_MODE.SYMLINK, 'f' as FilePath, theirsId),
        ]);
        // The rename target f~HEAD is already occupied by an untracked file
        await ctx.fs.write(
          `${ctx.layout.workDir}/f~HEAD`,
          new TextEncoder().encode('in the way\n'),
        );
        await ctx.fs.write(`${ctx.layout.workDir}/f`, fileContent);

        // Act
        const result = await applyMergeToWorktree(ctx, {
          baseTree: emptyBase,
          oursTree,
          theirsTree,
          currentIndex: index([indexEntry('f', oursId)]),
          labels: { ours: 'HEAD', theirs: 'side', base: 'base' },
        });

        // Assert
        expect(result.kind).toBe('would-overwrite');
        if (result.kind !== 'would-overwrite') return;
        expect(result.untracked).toContain('f~HEAD');
        // The obstructing file is untouched
        const onDisk = new TextDecoder().decode(await ctx.fs.read(`${ctx.layout.workDir}/f~HEAD`));
        expect(onDisk).toBe('in the way\n');
      });
    });
  });

  describe('Given a dirty tracked file sits at the distinct-types rename target', () => {
    describe('When the merge is applied', () => {
      it('Then it refuses with would-overwrite naming the rename target path', async () => {
        // Arrange — ours adds `f` as regular, theirs as symlink → ourPath becomes f~HEAD
        // `f~HEAD` is tracked (in currentIndex) but dirty (working file differs from index)
        const ctx = await buildSeededContext();
        const fileContent = new TextEncoder().encode('file content\n');
        const linkTarget = new TextEncoder().encode('/etc/target');
        const trackedId = await writeBlob(ctx, 'tracked content\n');
        const oursId = await writeObject(ctx, {
          type: 'blob',
          content: fileContent,
          id: '' as ObjectId,
        });
        const theirsId = await writeObject(ctx, {
          type: 'blob',
          content: linkTarget,
          id: '' as ObjectId,
        });
        const emptyBase = await treeWith(ctx, []);
        const oursTree = await treeWith(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'f' as FilePath, oursId),
        ]);
        const theirsTree = await treeWith(ctx, [
          treeEntry(FILE_MODE.SYMLINK, 'f' as FilePath, theirsId),
        ]);
        // f~HEAD is tracked but the working file is dirty
        await ctx.fs.write(
          `${ctx.layout.workDir}/f~HEAD`,
          new TextEncoder().encode('dirty local\n'),
        );
        await ctx.fs.write(`${ctx.layout.workDir}/f`, fileContent);

        // Act
        const result = await applyMergeToWorktree(ctx, {
          baseTree: emptyBase,
          oursTree,
          theirsTree,
          currentIndex: index([indexEntry('f', oursId), indexEntry('f~HEAD', trackedId)]),
          labels: { ours: 'HEAD', theirs: 'side', base: 'base' },
        });

        // Assert
        expect(result.kind).toBe('would-overwrite');
        if (result.kind !== 'would-overwrite') return;
        expect(result.localChanges).toContain('f~HEAD');
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
        const base = await treeWith(ctx, [treeEntry(FILE_MODE.GITLINK, 'm' as FilePath, g0)]);
        const ours = await treeWith(ctx, [treeEntry(FILE_MODE.GITLINK, 'm' as FilePath, g1)]);
        const theirs = await treeWith(ctx, [treeEntry(FILE_MODE.GITLINK, 'm' as FilePath, g2)]);

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

describe('applyMergeToWorktree — writeConflictWorktree (site C) streaming', () => {
  // These tests exercise the resolved-known arm inside writeConflictWorktree via
  // applyMergeToWorktree in the conflict path (conflict + clean resolved-known side).

  describe('Given a conflict merge where the clean side is resolved-known', () => {
    describe('When the merge is applied', () => {
      it('Then the clean side routes through streamBlob + writeWorkingTreeFileStream', async () => {
        // Arrange — a conflicts (content), b is cleanly taken from theirs (resolved-known)
        const ctx = await buildSeededContext();
        const aBase = await writeBlob(ctx, 'a-base\n');
        const aOurs = await writeBlob(ctx, 'a-ours\n');
        const aTheirs = await writeBlob(ctx, 'a-theirs\n');
        const bId = await writeBlob(ctx, 'b-original\n');
        const bNew = await writeBlob(ctx, 'b-new\n');
        const reg = FILE_MODE.REGULAR;
        const base = await treeWith(ctx, [
          treeEntry(reg, 'a' as FilePath, aBase),
          treeEntry(reg, 'b' as FilePath, bId),
        ]);
        const ours = await treeWith(ctx, [
          treeEntry(reg, 'a' as FilePath, aOurs),
          treeEntry(reg, 'b' as FilePath, bId),
        ]);
        const theirs = await treeWith(ctx, [
          treeEntry(reg, 'a' as FilePath, aTheirs),
          treeEntry(reg, 'b' as FilePath, bNew),
        ]);
        await ctx.fs.write(`${ctx.layout.workDir}/a`, new TextEncoder().encode('a-ours\n'));
        await ctx.fs.write(`${ctx.layout.workDir}/b`, new TextEncoder().encode('b-original\n'));
        const streamBlobSpy = vi.spyOn(streamBlobMod, 'streamBlob');
        const writeStreamSpy = vi.spyOn(writeFileMod, 'writeWorkingTreeFileStream');

        // Act
        const result = await applyMergeToWorktree(ctx, {
          baseTree: base,
          oursTree: ours,
          theirsTree: theirs,
          currentIndex: index([indexEntry('a', aOurs), indexEntry('b', bId)]),
        });

        // Assert — conflict path reached; b's clean side used streaming
        expect(result.kind).toBe('conflict');
        expect(streamBlobSpy).toHaveBeenCalled();
        expect(writeStreamSpy).toHaveBeenCalled();
        expect(await readWork(ctx, 'b')).toBe('b-new\n');

        streamBlobSpy.mockRestore();
        writeStreamSpy.mockRestore();
      });
    });
  });

  describe('Given a conflict merge where the clean side is resolved-known (uncapped write)', () => {
    describe('When the merge is applied', () => {
      it('Then streamBlob is invoked with no maxBytes arg and the full blob is written', async () => {
        // Arrange — a conflicts; b is resolved-known (theirs changed it from bBase to bNew;
        // ours unchanged). The bNew content is large enough that a small cap would throw.
        const ctx = await buildSeededContext();
        const aBase = await writeBlob(ctx, 'a-base\n');
        const aOurs = await writeBlob(ctx, 'a-ours\n');
        const aTheirs = await writeBlob(ctx, 'a-theirs\n');
        const bBaseContent = new TextEncoder().encode('b-base\n');
        const bNewContent = new Uint8Array(512).fill(0x43); // 512 B; a small cap would throw
        const bBaseId = await writeObject(ctx, {
          type: 'blob',
          content: bBaseContent,
          id: '' as ObjectId,
        });
        const bNewId = await writeObject(ctx, {
          type: 'blob',
          content: bNewContent,
          id: '' as ObjectId,
        });
        const reg = FILE_MODE.REGULAR;
        // base: b=bBase; ours: b=bBase (unchanged); theirs: b=bNew → resolved-known at bNew
        const base = await treeWith(ctx, [
          treeEntry(reg, 'a' as FilePath, aBase),
          treeEntry(reg, 'b' as FilePath, bBaseId),
        ]);
        const ours = await treeWith(ctx, [
          treeEntry(reg, 'a' as FilePath, aOurs),
          treeEntry(reg, 'b' as FilePath, bBaseId),
        ]);
        const theirs = await treeWith(ctx, [
          treeEntry(reg, 'a' as FilePath, aTheirs),
          treeEntry(reg, 'b' as FilePath, bNewId),
        ]);
        await ctx.fs.write(`${ctx.layout.workDir}/a`, new TextEncoder().encode('a-ours\n'));
        await ctx.fs.write(`${ctx.layout.workDir}/b`, bBaseContent);
        const streamBlobSpy = vi.spyOn(streamBlobMod, 'streamBlob');

        // Act — must not throw (no maxBytes cap applied)
        await applyMergeToWorktree(ctx, {
          baseTree: base,
          oursTree: ours,
          theirsTree: theirs,
          currentIndex: index([indexEntry('a', aOurs), indexEntry('b', bBaseId)]),
        });

        // Assert — streamBlob called without a third options arg (no maxBytes)
        const blobCalls = streamBlobSpy.mock.calls;
        // At least one call for the resolved-known b side (bNewId)
        expect(blobCalls.length).toBeGreaterThanOrEqual(1);
        for (const call of blobCalls) {
          const [, , thirdArg] = call;
          expect(thirdArg).toBeUndefined();
        }
        const written = await ctx.fs.read(`${ctx.layout.workDir}/b`);
        expect(written).toEqual(bNewContent);

        streamBlobSpy.mockRestore();
      });
    });
  });

  describe('Given a conflict merge where the resolved-merged side has synthesised bytes', () => {
    describe('When the merge is applied', () => {
      it('Then resolved-merged routes through buffered writeWorkingTreeFile (not streamBlob)', async () => {
        // Arrange — a conflicts; d is a clean line-merge (resolved-merged)
        const ctx = await buildSeededContext();
        const aBase = await writeBlob(ctx, 'a-base\n');
        const aOurs = await writeBlob(ctx, 'a-ours\n');
        const aTheirs = await writeBlob(ctx, 'a-theirs\n');
        const dBase = await writeBlob(ctx, 'd1\nd2\nd3\n');
        const dOurs = await writeBlob(ctx, 'D1\nd2\nd3\n');
        const dTheirs = await writeBlob(ctx, 'd1\nd2\nD3\n');
        const reg = FILE_MODE.REGULAR;
        const base = await treeWith(ctx, [
          treeEntry(reg, 'a' as FilePath, aBase),
          treeEntry(reg, 'd' as FilePath, dBase),
        ]);
        const ours = await treeWith(ctx, [
          treeEntry(reg, 'a' as FilePath, aOurs),
          treeEntry(reg, 'd' as FilePath, dOurs),
        ]);
        const theirs = await treeWith(ctx, [
          treeEntry(reg, 'a' as FilePath, aTheirs),
          treeEntry(reg, 'd' as FilePath, dTheirs),
        ]);
        await ctx.fs.write(`${ctx.layout.workDir}/a`, new TextEncoder().encode('a-ours\n'));
        await ctx.fs.write(`${ctx.layout.workDir}/d`, new TextEncoder().encode('D1\nd2\nd3\n'));
        const streamBlobSpy = vi.spyOn(streamBlobMod, 'streamBlob');
        const writeStreamSpy = vi.spyOn(writeFileMod, 'writeWorkingTreeFileStream');

        // Act
        const result = await applyMergeToWorktree(ctx, {
          baseTree: base,
          oursTree: ours,
          theirsTree: theirs,
          currentIndex: index([indexEntry('a', aOurs), indexEntry('d', dOurs)]),
        });

        // Assert — d is resolved-merged (synthesised bytes); stream path must NOT be taken
        expect(result.kind).toBe('conflict');
        expect(writeStreamSpy).not.toHaveBeenCalled();
        // streamBlob may have been called for other paths but NOT for d (resolved-merged)
        // Verify d was written via buffered path with merged bytes
        expect(await readWork(ctx, 'd')).toBe('D1\nd2\nD3\n');

        streamBlobSpy.mockRestore();
        writeStreamSpy.mockRestore();
      });
    });
  });
});

describe('writeMarkedConflict (direct)', () => {
  const seedBlob = (ctx: Context, text: string): Promise<ObjectId> =>
    writeObject(ctx, {
      type: 'blob',
      content: new TextEncoder().encode(text),
      id: '' as ObjectId,
    });
  const conflictOf = (over: Partial<MergeConflict>): MergeConflict =>
    ({ path: 'p' as FilePath, ...over }) as MergeConflict;

  // Bare content symlink-pair / modify-delete survivor / bare type-change —
  // whichever side survives, its symlink is re-created verbatim at the path.
  describe('Given a conflict whose surviving side is a symlink', () => {
    describe('When writeMarkedConflict runs', () => {
      it.each([
        {
          label:
            'a bare content conflict with symlink modes on both sides re-creates ours (not target bytes as a regular file)',
          build: async (ctx: Context): Promise<MergeConflict> => {
            const oursId = await seedBlob(ctx, 'ours-target');
            const theirsId = await seedBlob(ctx, 'theirs-target');
            const baseId = await seedBlob(ctx, 'base-file-content');
            return conflictOf({
              type: 'content',
              ourId: oursId,
              theirId: theirsId,
              baseId,
              ourMode: FILE_MODE.SYMLINK,
              theirMode: FILE_MODE.SYMLINK,
              baseMode: FILE_MODE.REGULAR,
            });
          },
          expectedTarget: 'ours-target',
        },
        {
          label:
            'a modify-delete conflict whose surviving theirs side is a symlink re-creates theirs',
          build: async (ctx: Context): Promise<MergeConflict> => {
            const theirsId = await seedBlob(ctx, 'survivor-target');
            // ourId/ourMode are absent: ours deleted the path
            return conflictOf({
              type: 'modify-delete',
              theirId: theirsId,
              theirMode: FILE_MODE.SYMLINK,
            });
          },
          expectedTarget: 'survivor-target',
        },
        {
          label: 'a bare type-change conflict with symlink ourMode re-creates ours',
          build: async (ctx: Context): Promise<MergeConflict> => {
            const oursId = await seedBlob(ctx, 'symlink-target');
            return conflictOf({ type: 'type-change', ourId: oursId, ourMode: FILE_MODE.SYMLINK });
          },
          expectedTarget: 'symlink-target',
        },
      ])('Then $label', async ({ build, expectedTarget }) => {
        // Arrange
        const ctx = await buildSeededContext();
        const conflict = await build(ctx);

        // Act
        await writeMarkedConflict(ctx, conflict);

        // Assert — lstat reveals a symlink; readlink returns the survivor's target
        const stat = await ctx.fs.lstat(`${ctx.layout.workDir}/p`);
        expect(stat.isSymbolicLink).toBe(true);
        const target = await ctx.fs.readlink(`${ctx.layout.workDir}/p`);
        expect(target).toBe(expectedTarget);
      });
    });
  });

  // conflictContent + executable ourMode — exec bit preserved
  describe('Given a content conflict with conflictContent and executable ourMode', () => {
    describe('When writeMarkedConflict runs', () => {
      it('Then the marker file is written with exec mode (chmod 0o755 called)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const chmodSpy = vi.spyOn(ctx.fs, 'chmod');
        const conflict = conflictOf({
          type: 'content',
          conflictContent: new TextEncoder().encode(
            '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> side\n',
          ),
          ourMode: FILE_MODE.EXECUTABLE,
        });

        // Act
        await writeMarkedConflict(ctx, conflict);

        // Assert
        expect(chmodSpy).toHaveBeenCalledWith(`${ctx.layout.workDir}/p`, 0o755);
      });
    });
  });

  // Marker bytes carry the three-way-merged mode, not ours' stage mode
  describe('Given a content conflict where mergedMode is executable but ourMode is regular', () => {
    describe('When writeMarkedConflict runs', () => {
      it('Then the marker file is written with the merged exec mode', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const chmodSpy = vi.spyOn(ctx.fs, 'chmod');
        const conflict = conflictOf({
          type: 'content',
          conflictContent: new TextEncoder().encode(
            '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> side\n',
          ),
          ourMode: FILE_MODE.REGULAR,
          theirMode: FILE_MODE.EXECUTABLE,
          mergedMode: FILE_MODE.EXECUTABLE,
        });

        // Act
        await writeMarkedConflict(ctx, conflict);

        // Assert — merged mode wins over ours' stage mode
        expect(chmodSpy).toHaveBeenCalledWith(`${ctx.layout.workDir}/p`, 0o755);
      });
    });
  });

  // Refusal seam: no mode at all — nothing is written, no blob is read
  describe('Given a conflict carrying conflictContent but no mode on any field', () => {
    describe('When writeMarkedConflict runs', () => {
      it('Then nothing is written at the path', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const conflict = conflictOf({
          type: 'content',
          conflictContent: new TextEncoder().encode('marker-bytes\n'),
        });

        // Act
        await writeMarkedConflict(ctx, conflict);

        // Assert — no file materialised
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/p`)).toBe(false);
      });
    });
  });

  // Refusal seam: mode defined but no derivable bytes — no write, no throw
  describe('Given a bare add-add conflict with only theirId and theirMode', () => {
    describe('When writeMarkedConflict runs', () => {
      it('Then nothing is written at the path', async () => {
        // Arrange — conflictContent absent and ourId absent, so no bytes can be derived
        // while the theirs mode is present
        const ctx = await buildSeededContext();
        const theirsId = await seedBlob(ctx, 'theirs-only');
        const conflict = conflictOf({
          type: 'add-add',
          theirId: theirsId,
          theirMode: FILE_MODE.REGULAR,
        });

        // Act
        await writeMarkedConflict(ctx, conflict);

        // Assert — no file materialised
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/p`)).toBe(false);
      });
    });
  });
});
