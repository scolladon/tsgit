import { describe, expect, it, vi } from 'vitest';
import {
  applyMergeToWorktree,
  conflictResultTree,
  createMergeResultWriter,
  mergeTreesToTree,
  removeChangedOutcome,
  removeDisplacedFile,
  survivingPathsOf,
  writeMarkedConflict,
} from '../../../../src/application/primitives/apply-merge-to-worktree.js';
import { invalidateConfigCache } from '../../../../src/application/primitives/config-read.js';
import {
  flattenEscapedTree,
  flattenTree,
} from '../../../../src/application/primitives/flatten-tree.js';
import { survivingDirectoriesOf } from '../../../../src/application/primitives/internal/prune-emptied-directories.js';
import { createLeadingPathScanner } from '../../../../src/application/primitives/internal/symlinked-leading-path.js';
import * as writeFileMod from '../../../../src/application/primitives/internal/write-working-tree-file.js';
import * as streamBlobMod from '../../../../src/application/primitives/stream-blob.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { GitIndex, IndexEntry } from '../../../../src/domain/git-index/index.js';
import { STAGE0_FLAGS } from '../../../../src/domain/git-index/index.js';
import type { MergeConflict, MergeOutcome } from '../../../../src/domain/merge/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type {
  FileMode,
  FilePath,
  ObjectId,
  TreeEntry,
} from '../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from '../../../../src/ports/command-runner.js';
import { type Context, createSession } from '../../../../src/ports/context.js';
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

const conflictAt = (path: string): MergeConflict => ({ path: path as FilePath }) as MergeConflict;

describe('applyMergeToWorktree', () => {
  describe('Given a conflict beside paths holding �.txt and 😀.txt', () => {
    describe('When the merge is applied', () => {
      it('Then the index entries are in git byte order with stages 1, 2, 3 kept', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const b = await writeBlob(ctx, 'base\n');
        const o = await writeBlob(ctx, 'ours\n');
        const t = await writeBlob(ctx, 'theirs\n');
        const entry = (name: string, id: ObjectId) =>
          treeEntry(FILE_MODE.REGULAR, name as FilePath, id);
        const base = await treeWith(ctx, [entry('�.txt', b)]);
        const ours = await treeWith(ctx, [entry('�.txt', o), entry('\u{1F600}.txt', b)]);
        const theirs = await treeWith(ctx, [entry('�.txt', t), entry('\u{1F600}.txt', b)]);
        await ctx.fs.write(`${ctx.layout.workDir}/�.txt`, new TextEncoder().encode('ours\n'));

        // Act
        const sut = applyMergeToWorktree;
        const result = await sut(ctx, {
          baseTree: base,
          oursTree: ours,
          theirsTree: theirs,
          currentIndex: index([indexEntry('�.txt', o), indexEntry('\u{1F600}.txt', b)]),
        });

        // Assert
        expect(result.kind).toBe('conflict');
        if (result.kind !== 'conflict') return;
        expect(result.indexEntries.map((e) => [e.path, e.flags.stage])).toEqual([
          ['�.txt', 1],
          ['�.txt', 2],
          ['�.txt', 3],
          ['\u{1F600}.txt', 0],
        ]);
      });
    });
  });

  /** A file whose merge histogram, myers and patience each settle differently. */
  const algorithmSensitive = async (ctx: Context) => {
    const blob = (lines: string) => writeBlob(ctx, `${lines.split(' ').join('\n')}\n`);
    const tree = async (lines: string) =>
      treeWith(ctx, [treeEntry(FILE_MODE.REGULAR, 'f' as FilePath, await blob(lines))]);
    await ctx.fs.write(`${ctx.layout.workDir}/f`, new TextEncoder().encode('b\na\na\nc\na\nb\n'));
    return {
      baseTree: await tree('b a c a b'),
      oursTree: await tree('b a a c a b'),
      theirsTree: await tree('a a a b c'),
      currentIndex: index([indexEntry('f', await blob('b a a c a b'))]),
    };
  };

  describe('Given each side renames the same file to a different path', () => {
    describe('When the merge is applied', () => {
      it('Then the source path, holding only its base stage, leaves the working tree', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blob = await writeBlob(ctx, 'one\ntwo\nthree\nfour\n');
        const at = (name: string) =>
          treeWith(ctx, [treeEntry(FILE_MODE.REGULAR, name as FilePath, blob)]);
        await ctx.fs.write(
          `${ctx.layout.workDir}/a`,
          new TextEncoder().encode('one\ntwo\nthree\nfour\n'),
        );
        const input = {
          baseTree: await at('f'),
          oursTree: await at('a'),
          theirsTree: await at('b'),
          currentIndex: index([indexEntry('a', blob)]),
        };

        // Act
        const result = await applyMergeToWorktree(ctx, input);

        // Assert
        expect(result.kind).toBe('conflict');
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/f`)).toBe(false);
        expect(await readWork(ctx, 'b')).toBe('one\ntwo\nthree\nfour\n');
      });
    });
  });

  describe('Given diff.algorithm names patience', () => {
    describe('When a content merge is applied', () => {
      it('Then the line diffs follow patience over ort’s histogram', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[diff]\n\talgorithm = patience\n');
        const input = await algorithmSensitive(ctx);

        // Act
        await applyMergeToWorktree(ctx, input);

        // Assert
        const result = (await readWork(ctx, 'f')).split('\n').slice(0, 5);
        expect(result).toEqual(['a', 'a', 'a', 'b', '<<<<<<< ours']);
      });
    });
  });

  describe('Given diff.algorithm names no algorithm', () => {
    describe('When a merge is applied', () => {
      it('Then it refuses naming the key and value', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[diff]\n\talgorithm = bogus\n');
        const input = await algorithmSensitive(ctx);

        // Act
        const result = await applyMergeToWorktree(ctx, input).catch((e: unknown) => e);

        // Assert
        expect((result as TsgitError).data).toEqual({
          code: 'CONFIG_UNKNOWN_VALUE',
          key: 'diff.algorithm',
          value: 'bogus',
          source: `${ctx.layout.gitDir}/config`,
          line: 2,
        });
      });
    });
  });

  describe('Given a staged change on a path the merge leaves as ours has it', () => {
    describe('When the merge is applied', () => {
      it('Then the index keeps the staged entry and the tree to commit carries it', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const v1 = await writeBlob(ctx, 'one\n');
        const v2 = await writeBlob(ctx, 'two\n');
        const staged = await writeBlob(ctx, 'staged\n');
        const base = await treeWith(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'a' as FilePath, v1),
          treeEntry(FILE_MODE.REGULAR, 's' as FilePath, v1),
        ]);
        const theirs = await treeWith(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'a' as FilePath, v2),
          treeEntry(FILE_MODE.REGULAR, 's' as FilePath, v1),
        ]);
        await ctx.fs.write(`${ctx.layout.workDir}/a`, new TextEncoder().encode('one\n'));
        await ctx.fs.write(`${ctx.layout.workDir}/s`, new TextEncoder().encode('staged\n'));
        const sut = applyMergeToWorktree;

        // Act
        const result = await sut(ctx, {
          baseTree: base,
          oursTree: base,
          theirsTree: theirs,
          currentIndex: index([indexEntry('a', v1), indexEntry('s', staged)]),
        });

        // Assert
        if (result.kind !== 'clean') throw new Error(result.kind);
        expect(result.result.newIndexEntries.find((entry) => entry.path === 's')?.id).toBe(staged);
        expect(
          (await flattenEscapedTree(ctx, result.indexTree)).entries.get('s' as FilePath)?.id,
        ).toBe(staged);
        expect(
          (await flattenEscapedTree(ctx, result.mergedTree)).entries.get('s' as FilePath)?.id,
        ).toBe(v1);
        expect(await readWork(ctx, 's')).toBe('staged\n');
      });
    });
  });

  describe('Given a staged removal of a path the merge leaves as ours has it', () => {
    describe('When the merge is applied', () => {
      it('Then the index keeps the path removed and the tree to commit lacks it', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const v1 = await writeBlob(ctx, 'one\n');
        const v2 = await writeBlob(ctx, 'two\n');
        const base = await treeWith(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'a' as FilePath, v1),
          treeEntry(FILE_MODE.REGULAR, 's' as FilePath, v1),
        ]);
        const theirs = await treeWith(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'a' as FilePath, v2),
          treeEntry(FILE_MODE.REGULAR, 's' as FilePath, v1),
        ]);
        await ctx.fs.write(`${ctx.layout.workDir}/a`, new TextEncoder().encode('one\n'));
        const sut = applyMergeToWorktree;

        // Act
        const result = await sut(ctx, {
          baseTree: base,
          oursTree: base,
          theirsTree: theirs,
          currentIndex: index([indexEntry('a', v1)]),
        });

        // Assert
        if (result.kind !== 'clean') throw new Error(result.kind);
        expect(result.result.newIndexEntries.map((entry) => entry.path)).toEqual(['a']);
        expect((await flattenEscapedTree(ctx, result.indexTree)).entries.has('s' as FilePath)).toBe(
          false,
        );
      });
    });
  });

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

  describe('Given non-overlapping edits on both sides and an AUTO_MERGE state file', () => {
    const cleanMerge = async (ctx: Context) => {
      const b = await writeBlob(ctx, 'a\nb\nc\n');
      const o = await writeBlob(ctx, 'A\nb\nc\n');
      const t = await writeBlob(ctx, 'a\nb\nC\n');
      const tree = (id: ObjectId) =>
        treeWith(ctx, [treeEntry(FILE_MODE.REGULAR, 'f' as FilePath, id)]);
      await ctx.fs.write(`${ctx.layout.workDir}/f`, new TextEncoder().encode('A\nb\nc\n'));
      return {
        baseTree: await tree(b),
        oursTree: await tree(o),
        theirsTree: await tree(t),
        currentIndex: index([indexEntry('f', o)]),
      };
    };

    describe('When the clean merge is applied', () => {
      it('Then AUTO_MERGE names the merged tree', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const input = await cleanMerge(ctx);
        const sut = applyMergeToWorktree;

        // Act
        const result = await sut(ctx, input);

        // Assert
        if (result.kind !== 'clean') throw new Error('expected a clean merge');
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/AUTO_MERGE`)).toBe(
          `${result.mergedTree}\n`,
        );
      });
    });

    describe('When AUTO_MERGE holds no object id', () => {
      it('Then it refuses with INVALID_REF and leaves AUTO_MERGE as it was', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const input = await cleanMerge(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/AUTO_MERGE`, 'garbage\n');
        const sut = applyMergeToWorktree;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, input);
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'INVALID_REF',
          reason: 'AUTO_MERGE is broken',
        });
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/AUTO_MERGE`)).toBe('garbage\n');
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

  describe('Given a deleted outcome that is the last file in its directory', () => {
    describe('When removeChangedOutcome runs', () => {
      it('Then the emptied directory is removed with it', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.write(`${ctx.layout.workDir}/d/e/y`, new TextEncoder().encode('y\n'));

        // Act
        await removeChangedOutcome(
          ctx,
          { status: 'resolved-deleted', path: 'd/e/y' as FilePath },
          createLeadingPathScanner(ctx),
          survivingDirectoriesOf([]),
        );

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/d`)).toBe(false);
      });
    });
  });

  describe('Given a deleted outcome whose directory keeps a merged entry', () => {
    describe('When removeChangedOutcome runs', () => {
      it('Then only the file is removed and the directory is not probed', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.write(`${ctx.layout.workDir}/d/e/y`, new TextEncoder().encode('y\n'));
        await ctx.fs.write(`${ctx.layout.workDir}/d/e/z`, new TextEncoder().encode('z\n'));
        const rm = vi.spyOn(ctx.fs, 'rm');
        const surviving = survivingDirectoriesOf(
          survivingPathsOf(
            [
              {
                status: 'unchanged',
                path: 'd/e/z' as FilePath,
                id: '' as ObjectId,
                mode: FILE_MODE.REGULAR,
              },
            ],
            [],
          ),
        );

        // Act
        await removeChangedOutcome(
          ctx,
          { status: 'resolved-deleted', path: 'd/e/y' as FilePath },
          createLeadingPathScanner(ctx),
          surviving,
        );

        // Assert
        expect(rm.mock.calls.map(([path]) => path)).toEqual([`${ctx.layout.workDir}/d/e/y`]);
      });
    });
  });

  describe('Given outcomes and conflicts of a merge', () => {
    describe('When the surviving paths are listed', () => {
      it('Then deletions are left out and clean and conflicted paths are kept', () => {
        // Arrange
        const id = '' as ObjectId;
        const outcomes: ReadonlyArray<MergeOutcome> = [
          { status: 'resolved-deleted', path: 'gone' as FilePath },
          { status: 'resolved-known', path: 'known' as FilePath, id, mode: FILE_MODE.REGULAR },
          { status: 'conflict', conflict: conflictAt('clash') },
        ];

        // Act
        const result = [...survivingPathsOf(outcomes, [conflictAt('clash')])];

        // Assert
        expect(result).toEqual(['known', 'clash']);
      });
    });
  });

  describe('Given a deleted outcome whose leading directory is a symlink', () => {
    describe('When removeChangedOutcome runs', () => {
      it('Then the link and the file behind it both stay', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.write(`${ctx.layout.workDir}/real/x`, new TextEncoder().encode('x\n'));
        await ctx.fs.symlink('real', `${ctx.layout.workDir}/a`);

        // Act
        await removeChangedOutcome(
          ctx,
          { status: 'resolved-deleted', path: 'a/x' as FilePath },
          createLeadingPathScanner(ctx),
          survivingDirectoriesOf([]),
        );

        // Assert
        expect((await ctx.fs.lstat(`${ctx.layout.workDir}/a`)).isSymbolicLink).toBe(true);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/real/x`)).toBe(true);
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

  describe('Given a path that line-merges cleanly beside a conflicting one', () => {
    describe('When the merge is applied', () => {
      it('Then the merged blob is written and staged at stage 0', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const conflictBase = await writeBlob(ctx, 'base\n');
        const conflictOurs = await writeBlob(ctx, 'ours\n');
        const conflictTheirs = await writeBlob(ctx, 'theirs\n');
        const mergeBase = await writeBlob(ctx, 'a\nb\nc\n');
        const mergeOurs = await writeBlob(ctx, 'A\nb\nc\n');
        const mergeTheirs = await writeBlob(ctx, 'a\nb\nC\n');
        const merged = await writeBlob(ctx, 'A\nb\nC\n');
        const tree = (conflict: ObjectId, clean: ObjectId) =>
          treeWith(ctx, [
            treeEntry(FILE_MODE.REGULAR, 'a' as FilePath, conflict),
            treeEntry(FILE_MODE.REGULAR, 'm' as FilePath, clean),
          ]);
        const oursTree = await tree(conflictOurs, mergeOurs);
        await ctx.fs.write(`${ctx.layout.workDir}/a`, new TextEncoder().encode('ours\n'));
        await ctx.fs.write(`${ctx.layout.workDir}/m`, new TextEncoder().encode('A\nb\nc\n'));

        // Act
        const result = await applyMergeToWorktree(ctx, {
          baseTree: await tree(conflictBase, mergeBase),
          oursTree,
          theirsTree: await tree(conflictTheirs, mergeTheirs),
          currentIndex: index([indexEntry('a', conflictOurs), indexEntry('m', mergeOurs)]),
        });

        // Assert
        if (result.kind !== 'conflict') throw new Error(`expected conflict, got ${result.kind}`);
        expect(result.indexEntries.map((e) => [e.path, e.flags.stage, e.id])).toEqual([
          ['a', 1, conflictBase],
          ['a', 2, conflictOurs],
          ['a', 3, conflictTheirs],
          ['m', 0, merged],
        ]);
      });
    });
  });

  describe('Given a content conflict beside a path that line-merges cleanly', () => {
    describe('When the merge is applied', () => {
      it("Then AUTO_MERGE names the result tree: the merged blob and the conflicted file's marked bytes", async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobs = await Promise.all(
          ['base\n', 'ours\n', 'theirs\n', 'a\nb\nc\n', 'A\nb\nc\n', 'a\nb\nC\n'].map((content) =>
            writeBlob(ctx, content),
          ),
        );
        const [aBase, aOurs, aTheirs, mBase, mOurs, mTheirs] = blobs as [
          ObjectId,
          ObjectId,
          ObjectId,
          ObjectId,
          ObjectId,
          ObjectId,
        ];
        const tree = (conflict: ObjectId, clean: ObjectId) =>
          treeWith(ctx, [
            treeEntry(FILE_MODE.REGULAR, 'a' as FilePath, conflict),
            treeEntry(FILE_MODE.REGULAR, 'm' as FilePath, clean),
          ]);
        await ctx.fs.write(`${ctx.layout.workDir}/a`, new TextEncoder().encode('ours\n'));
        await ctx.fs.write(`${ctx.layout.workDir}/m`, new TextEncoder().encode('A\nb\nc\n'));
        const sut = applyMergeToWorktree;

        // Act
        await sut(ctx, {
          baseTree: await tree(aBase, mBase),
          oursTree: await tree(aOurs, mOurs),
          theirsTree: await tree(aTheirs, mTheirs),
          currentIndex: index([indexEntry('a', aOurs), indexEntry('m', mOurs)]),
        });

        // Assert
        const marked = await writeBlob(ctx, await readWork(ctx, 'a'));
        const expected = await tree(marked, await writeBlob(ctx, 'A\nb\nC\n'));
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/AUTO_MERGE`)).toBe(`${expected}\n`);
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

  describe('Given a conflicting merge where a backslash path conflicts and a sibling path is clean', () => {
    const seed = async () => {
      const ctx = await buildSeededContext();
      const cleanBase = await writeBlob(ctx, 'base-clean\n');
      const cleanTheirs = await writeBlob(ctx, 'THEIRS-CLEAN\n');
      const baseId = await writeBlob(ctx, 'base\n');
      const oursId = await writeBlob(ctx, 'ours\n');
      const theirsId = await writeBlob(ctx, 'theirs\n');
      const treeOf = (clean: ObjectId, hostile: ObjectId) =>
        treeWith(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'clean.txt' as FilePath, clean),
          treeEntry(FILE_MODE.REGULAR, 'x\\y' as FilePath, hostile),
        ]);
      const input = {
        baseTree: await treeOf(cleanBase, baseId),
        oursTree: await treeOf(cleanBase, oursId),
        theirsTree: await treeOf(cleanTheirs, theirsId),
        currentIndex: index([indexEntry('clean.txt', cleanBase), indexEntry('x\\y', oursId)]),
      };
      return { ctx, input };
    };

    describe('When the merge is applied under Windows path syntax', () => {
      it('Then throws the backslash reason and the clean sibling is never written', async () => {
        // Arrange
        const { ctx, input } = await seed();
        const sut = applyMergeToWorktree;

        // Act
        let caught: unknown;
        try {
          await sut({ ...ctx, windowsPathSyntax: true }, input);
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = (caught as { data?: { code?: string; reason?: string } })?.data;
        expect(data?.code).toBe('INVALID_INDEX_ENTRY');
        expect(data?.reason).toBe('backslash rejected under Windows path syntax');
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/clean.txt`)).toBe(false);
      });
    });

    describe('When the merge is applied under POSIX path syntax', () => {
      it('Then it reports a conflict', async () => {
        // Arrange
        const { ctx, input } = await seed();
        const sut = applyMergeToWorktree;

        // Act
        const result = await sut(ctx, input);

        // Assert
        expect(result.kind).toBe('conflict');
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
        const streamSpy = vi.spyOn(writeFileMod, 'writeWorkingTreeEntryStream');
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

  describe('Given a conflict beside a path unchanged on both sides but locally modified', () => {
    describe('When the merge is applied', () => {
      it('Then the locally modified path and an untracked file keep their bytes', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const reg = FILE_MODE.REGULAR;
        const aBase = await writeBlob(ctx, 'a-base\n');
        const aOurs = await writeBlob(ctx, 'a-ours\n');
        const aTheirs = await writeBlob(ctx, 'a-theirs\n');
        const eId = await writeBlob(ctx, 'e\n');
        const treeOf = (a: ObjectId) =>
          treeWith(ctx, [treeEntry(reg, 'a' as FilePath, a), treeEntry(reg, 'e' as FilePath, eId)]);
        const enc = new TextEncoder();
        await ctx.fs.write(`${ctx.layout.workDir}/a`, enc.encode('a-ours\n'));
        await ctx.fs.write(`${ctx.layout.workDir}/e`, enc.encode('e-local\n'));
        await ctx.fs.write(`${ctx.layout.workDir}/untracked`, enc.encode('mine\n'));

        // Act
        const result = await applyMergeToWorktree(ctx, {
          baseTree: await treeOf(aBase),
          oursTree: await treeOf(aOurs),
          theirsTree: await treeOf(aTheirs),
          currentIndex: index([indexEntry('a', aOurs), indexEntry('e', eId)]),
        });

        // Assert
        expect(result.kind).toBe('conflict');
        expect(await readWork(ctx, 'a')).toContain('<<<<<<<');
        expect(await readWork(ctx, 'e')).toBe('e-local\n');
        expect(await readWork(ctx, 'untracked')).toBe('mine\n');
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

  describe('Given a file on one side meets a directory of the same name on the other', () => {
    const blobOf = (ctx: Awaited<ReturnType<typeof buildSeededContext>>, text: string) =>
      writeObject(ctx, {
        type: 'blob',
        content: new TextEncoder().encode(text),
        id: '' as ObjectId,
      });

    describe('When the merge is applied with the file on our side', () => {
      it('Then the work tree file is moved to f~HEAD and the index holds it at stage 2', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const fileId = await blobOf(ctx, 'file\n');
        const innerId = await blobOf(ctx, 'inner\n');
        const emptyBase = await treeWith(ctx, []);
        const oursTree = await treeWith(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'f' as FilePath, fileId),
        ]);
        const theirsTree = await treeWith(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'f/x' as FilePath, innerId),
        ]);
        await ctx.fs.write(`${ctx.layout.workDir}/f`, new TextEncoder().encode('file\n'));

        // Act
        const result = await applyMergeToWorktree(ctx, {
          baseTree: emptyBase,
          oursTree,
          theirsTree,
          currentIndex: index([indexEntry('f', fileId)]),
          labels: { ours: 'HEAD', theirs: 'side', base: 'base' },
        });

        // Assert
        expect(result.kind).toBe('conflict');
        if (result.kind !== 'conflict') return;
        expect(result.indexEntries.map((e) => [e.path, e.flags.stage])).toEqual([
          ['f/x', 0],
          ['f~HEAD', 2],
        ]);
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/f~HEAD`)).toBe('file\n');
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/f/x`)).toBe('inner\n');
      });
    });

    describe('When the merge is applied with the file on their side', () => {
      it('Then the file is written to f~side and the index holds it at stage 3', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const fileId = await blobOf(ctx, 'file\n');
        const innerId = await blobOf(ctx, 'inner\n');
        const emptyBase = await treeWith(ctx, []);
        const oursTree = await treeWith(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'f/x' as FilePath, innerId),
        ]);
        const theirsTree = await treeWith(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'f' as FilePath, fileId),
        ]);
        await ctx.fs.mkdir(`${ctx.layout.workDir}/f`);
        await ctx.fs.write(`${ctx.layout.workDir}/f/x`, new TextEncoder().encode('inner\n'));

        // Act
        const result = await applyMergeToWorktree(ctx, {
          baseTree: emptyBase,
          oursTree,
          theirsTree,
          currentIndex: index([indexEntry('f/x', innerId)]),
          labels: { ours: 'HEAD', theirs: 'side', base: 'base' },
        });

        // Assert
        expect(result.kind).toBe('conflict');
        if (result.kind !== 'conflict') return;
        expect(result.indexEntries.map((e) => [e.path, e.flags.stage])).toEqual([
          ['f/x', 0],
          ['f~side', 3],
        ]);
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/f~side`)).toBe('file\n');
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

  // git validates each written path with the mode it is written with: theirs
  // writes a symlink at ".gitmodules", so the whole merge is refused.
  describe('Given a distinct-types conflict at ".gitmodules" (regular ours, symlink theirs)', () => {
    describe('When the merge is applied', () => {
      it('Then it refuses the write because theirs is written as a symlink at ".gitmodules"', async () => {
        // Arrange — no base entry; ours adds `.gitmodules` as a regular
        // file, theirs adds it as a symlink.
        const ctx = await buildSeededContext();
        const oursId = await writeBlob(ctx, '[submodule "x"]\n');
        const theirsId = await writeBlob(ctx, '/etc/target');
        const emptyBase = await treeWith(ctx, []);
        const oursTree = await treeWith(ctx, [
          treeEntry(FILE_MODE.REGULAR, '.gitmodules' as FilePath, oursId),
        ]);
        const theirsTree = await treeWith(ctx, [
          treeEntry(FILE_MODE.SYMLINK, '.gitmodules' as FilePath, theirsId),
        ]);
        const sut = applyMergeToWorktree;

        // Act
        const caught = await sut(ctx, {
          baseTree: emptyBase,
          oursTree,
          theirsTree,
          currentIndex: index([]),
          labels: { ours: 'HEAD', theirs: 'side', base: 'base' },
        }).then(
          () => undefined,
          (err: unknown) => (err as TsgitError).data,
        );

        // Assert
        expect(caught).toMatchObject({
          code: 'INVALID_INDEX_ENTRY',
          reason: "'.gitmodules' must not be a symlink",
        });
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/.gitmodules~HEAD`)).toBe(false);
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

  describe('Given twin paths \\xff.txt and its U+FFFD view where theirs modifies only the raw one', () => {
    describe('When the merge is applied', () => {
      it('Then the raw path takes the new blob by its bytes and the twin keeps its own, with no fs call naming either', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const raw = Uint8Array.from([0xff, 0x2e, 0x74, 0x78, 0x74]);
        const [baseBlob, newBlob, twinBlob] = [
          await writeBlob(ctx, 'l\n'),
          await writeBlob(ctx, 'l2\n'),
          await writeBlob(ctx, 'u\n'),
        ];
        const side = (lossy: ObjectId) =>
          treeWith(ctx, [
            treeEntry(FILE_MODE.REGULAR, raw, lossy),
            treeEntry(FILE_MODE.REGULAR, '\uFFFD.txt', twinBlob),
          ]);
        const [base, ours, theirs] = [
          await side(baseBlob),
          await side(baseBlob),
          await side(newBlob),
        ];
        await ctx.fs.write(`${ctx.layout.workDir}/\uFFFD.txt`, new TextEncoder().encode('u\n'));
        const spies = [
          vi.spyOn(ctx.fs, 'write'),
          vi.spyOn(ctx.fs, 'writeUtf8'),
          vi.spyOn(ctx.fs, 'rm'),
          vi.spyOn(ctx.fs, 'mkdir'),
          vi.spyOn(ctx.fs, 'lstat'),
          vi.spyOn(ctx.fs, 'read'),
        ];
        const lossyEntry: IndexEntry = { ...indexEntry('\uFFFD.txt', baseBlob), pathBytes: raw };

        // Act
        const sut = applyMergeToWorktree;
        const result = await sut(ctx, {
          baseTree: base,
          oursTree: ours,
          theirsTree: theirs,
          currentIndex: index([lossyEntry, indexEntry('\uFFFD.txt', twinBlob)]),
        });

        // Assert
        expect(result.kind).toBe('clean');
        if (result.kind !== 'clean') return;
        const lossy = result.result.newIndexEntries.filter((e) => e.pathBytes !== undefined);
        expect(lossy.map((e) => [Array.from(e.pathBytes ?? []), e.id, e.fileSize])).toEqual([
          [Array.from(raw), newBlob, 0],
        ]);
        const twins = result.result.newIndexEntries.filter((e) => e.pathBytes === undefined);
        expect(twins.map((e) => [e.path, e.id])).toEqual([['\uFFFD.txt', twinBlob]]);
        const touched = spies.flatMap((spy) => spy.mock.calls.map(([path]) => String(path)));
        expect(touched.filter((path) => /[\uDC80-\uDCFF]/.test(path))).toEqual([]);
        expect(touched.filter((path) => path.endsWith('\uFFFD.txt')).length).toBe(0);
      });
    });
  });

  describe('Given a gitlink that diverges on both sides at a non-UTF-8 path', () => {
    describe('When the merge is applied', () => {
      it('Then it rejects naming the U+FFFD view of the path', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const raw = Uint8Array.from([0xff, 0x2e, 0x74, 0x78, 0x74]);
        const at = (id: string) =>
          treeWith(ctx, [treeEntry(FILE_MODE.GITLINK, raw, id.repeat(40) as ObjectId)]);
        const [base, ours, theirs] = [await at('0'), await at('1'), await at('2')];

        // Act
        const act = applyMergeToWorktree(ctx, {
          baseTree: base,
          oursTree: ours,
          theirsTree: theirs,
          currentIndex: index([]),
        });

        // Assert
        const failure = await act.catch((err: TsgitError) => err);
        expect((failure as TsgitError).data).toMatchObject({
          code: 'UNSUPPORTED_OPERATION',
          operation: 'apply-merge',
          reason: "conflict type 'gitlink' not supported (path=\uFFFD.txt)",
        });
      });
    });
  });
});

describe('applyMergeToWorktree — writeConflictWorktree (site C) streaming', () => {
  // These tests exercise the resolved-known arm inside writeConflictWorktree via
  // applyMergeToWorktree in the conflict path (conflict + clean resolved-known side).

  describe('Given a conflict merge where the clean side is resolved-known', () => {
    describe('When the merge is applied', () => {
      it('Then the clean side routes through writeWorkingTreeEntryStream', async () => {
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
        const writeStreamSpy = vi.spyOn(writeFileMod, 'writeWorkingTreeEntryStream');

        // Act
        const result = await applyMergeToWorktree(ctx, {
          baseTree: base,
          oursTree: ours,
          theirsTree: theirs,
          currentIndex: index([indexEntry('a', aOurs), indexEntry('b', bId)]),
        });

        // Assert — conflict path reached; b's clean side used streaming
        expect(result.kind).toBe('conflict');
        expect(writeStreamSpy).toHaveBeenCalled();
        expect(await readWork(ctx, 'b')).toBe('b-new\n');

        writeStreamSpy.mockRestore();
      });
    });
  });

  describe('Given a conflict merge where the clean side is resolved-known (uncapped write)', () => {
    describe('When the merge is applied', () => {
      it('Then the full blob is written with no size cap', async () => {
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

        // Act — must not throw (no maxBytes cap applied)
        await applyMergeToWorktree(ctx, {
          baseTree: base,
          oursTree: ours,
          theirsTree: theirs,
          currentIndex: index([indexEntry('a', aOurs), indexEntry('b', bBaseId)]),
        });

        // Assert
        const written = await ctx.fs.read(`${ctx.layout.workDir}/b`);
        expect(written).toEqual(bNewContent);
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
        const writeStreamSpy = vi.spyOn(writeFileMod, 'writeWorkingTreeEntryStream');

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
        await writeMarkedConflict(ctx, conflict, await createMergeResultWriter(ctx, [], []));

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
      it('Then the marker file is written with exec mode (created with 0o777, no chmod)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const chmodSpy = vi.spyOn(ctx.fs, 'chmod');
        const writeSpy = vi.spyOn(ctx.fs, 'write');
        const conflict = conflictOf({
          type: 'content',
          conflictContent: new TextEncoder().encode(
            '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> side\n',
          ),
          ourMode: FILE_MODE.EXECUTABLE,
        });

        // Act
        await writeMarkedConflict(ctx, conflict, await createMergeResultWriter(ctx, [], []));

        // Assert
        expect(chmodSpy).not.toHaveBeenCalled();
        expect(writeSpy).toHaveBeenCalledWith(`${ctx.layout.workDir}/p`, expect.anything(), {
          mode: 0o777,
        });
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
        const writeSpy = vi.spyOn(ctx.fs, 'write');
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
        await writeMarkedConflict(ctx, conflict, await createMergeResultWriter(ctx, [], []));

        // Assert — merged mode wins over ours' stage mode
        expect(chmodSpy).not.toHaveBeenCalled();
        expect(writeSpy).toHaveBeenCalledWith(`${ctx.layout.workDir}/p`, expect.anything(), {
          mode: 0o777,
        });
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
        await writeMarkedConflict(ctx, conflict, await createMergeResultWriter(ctx, [], []));

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
        await writeMarkedConflict(ctx, conflict, await createMergeResultWriter(ctx, [], []));

        // Assert — no file materialised
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/p`)).toBe(false);
      });
    });
  });
});

describe('applyMergeToWorktree — a clean side the alternate refuses to serve', () => {
  const ALT_OBJECTS = '/repo/alt/objects';
  const FLIPPED_SIGNATURE_MIDX = Uint8Array.from([
    0x00,
    0x49,
    0x44,
    0x58,
    1,
    1,
    1,
    0,
    ...new Array(8).fill(0),
  ]);
  const ABSENT_BLOB = 'b'.repeat(40) as ObjectId;

  describe('Given an unreadable alternate and a conflict merge whose clean side is a small packed blob', () => {
    describe('When applied', () => {
      it("Then the path exists with size 0 and the call rejects with the alternate's error", async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const reg = FILE_MODE.REGULAR;
        const aBase = await writeBlob(ctx, 'a-base\n');
        const aOurs = await writeBlob(ctx, 'a-ours\n');
        const aTheirs = await writeBlob(ctx, 'a-theirs\n');
        const bId = await writeBlob(ctx, 'b-original\n');
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
          treeEntry(reg, 'b' as FilePath, ABSENT_BLOB),
        ]);
        await ctx.fs.write(`${ctx.layout.workDir}/a`, new TextEncoder().encode('a-ours\n'));
        await ctx.fs.write(`${ctx.layout.workDir}/b`, new TextEncoder().encode('b-original\n'));
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/objects/info/alternates`, `${ALT_OBJECTS}\n`);
        await ctx.fs.write(`${ALT_OBJECTS}/pack/multi-pack-index`, FLIPPED_SIGNATURE_MIDX);
        const write = vi.spyOn(ctx.fs, 'write');

        // Act
        let failure: unknown;
        try {
          await applyMergeToWorktree(
            { ...ctx, session: createSession() },
            {
              baseTree: base,
              oursTree: ours,
              theirsTree: theirs,
              currentIndex: index([indexEntry('a', aOurs), indexEntry('b', bId)]),
            },
          );
        } catch (error) {
          failure = error;
        }

        // Assert
        expect((failure as TsgitError).data).toMatchObject({ code: 'INVALID_MULTI_PACK_INDEX' });
        expect((await ctx.fs.read(`${ctx.layout.workDir}/b`)).length).toBe(0);
        expect(
          write.mock.calls
            .filter(([, , options]) => options?.mode !== undefined)
            .map(([path]) => path),
        ).toEqual([`${ctx.layout.workDir}/b`]);
      });
    });
  });
});

describe('conflictResultTree', () => {
  const treeOf = (ctx: Context, entries: ReadonlyArray<[FileMode, string, ObjectId]>) =>
    treeWith(
      ctx,
      entries.map(([mode, path, id]) => treeEntry(mode, path as FilePath, id)),
    );

  const resultOf = (ctx: Context, conflict: MergeConflict) =>
    conflictResultTree(ctx, [], [conflict], []);

  describe('Given a conflict whose path survives on one side', () => {
    describe('When only their side holds a blob', () => {
      it('Then the path holds their blob', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const theirs = await writeBlob(ctx, 'theirs\n');
        const conflict: MergeConflict = {
          type: 'modify-delete',
          path: 'f' as FilePath,
          theirId: theirs,
          theirMode: FILE_MODE.REGULAR,
          ourMode: FILE_MODE.REGULAR,
        };
        const sut = resultOf;

        // Act
        const result = await sut(ctx, conflict);

        // Assert
        expect(result).toBe(await treeOf(ctx, [[FILE_MODE.REGULAR, 'f', theirs]]));
      });
    });

    describe('When both sides hold a blob', () => {
      it('Then the path holds our blob', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const ours = await writeBlob(ctx, 'ours\n');
        const theirs = await writeBlob(ctx, 'theirs\n');
        const conflict: MergeConflict = {
          type: 'modify-delete',
          path: 'f' as FilePath,
          ourId: ours,
          theirId: theirs,
          ourMode: FILE_MODE.REGULAR,
          theirMode: FILE_MODE.REGULAR,
        };
        const sut = resultOf;

        // Act
        const result = await sut(ctx, conflict);

        // Assert
        expect(result).toBe(await treeOf(ctx, [[FILE_MODE.REGULAR, 'f', ours]]));
      });
    });
  });

  describe('Given a conflict of a type whose path no side survives', () => {
    describe('When only their side holds a blob', () => {
      it('Then the path is left out of the tree', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const theirs = await writeBlob(ctx, 'theirs\n');
        const conflict: MergeConflict = {
          type: 'content',
          path: 'f' as FilePath,
          theirId: theirs,
          theirMode: FILE_MODE.REGULAR,
          ourMode: FILE_MODE.REGULAR,
        };
        const sut = resultOf;

        // Act
        const result = await sut(ctx, conflict);

        // Assert
        expect(result).toBe(await treeOf(ctx, []));
      });
    });
  });

  describe('Given a distinct-types conflict recording a path per side', () => {
    describe('When the result tree is built', () => {
      it('Then each side holds its blob at its own path', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const ours = await writeBlob(ctx, 'ours\n');
        const theirs = await writeBlob(ctx, 'theirs\n');
        const conflict: MergeConflict = {
          type: 'distinct-types',
          path: 'f' as FilePath,
          ourPath: 'f' as FilePath,
          ourId: ours,
          ourMode: FILE_MODE.REGULAR,
          theirPath: 'f~side' as FilePath,
          theirId: theirs,
          theirMode: FILE_MODE.EXECUTABLE,
        };
        const sut = resultOf;

        // Act
        const result = await sut(ctx, conflict);

        // Assert
        expect(result).toBe(
          await treeOf(ctx, [
            [FILE_MODE.REGULAR, 'f', ours],
            [FILE_MODE.EXECUTABLE, 'f~side', theirs],
          ]),
        );
      });
    });

    describe('When only our side is recorded', () => {
      it('Then only our blob is in the tree', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const ours = await writeBlob(ctx, 'ours\n');
        const conflict: MergeConflict = {
          type: 'distinct-types',
          path: 'f' as FilePath,
          ourPath: 'f' as FilePath,
          ourId: ours,
          ourMode: FILE_MODE.REGULAR,
        };
        const sut = resultOf;

        // Act
        const result = await sut(ctx, conflict);

        // Assert
        expect(result).toBe(await treeOf(ctx, [[FILE_MODE.REGULAR, 'f', ours]]));
      });
    });

    describe('When only their side is recorded', () => {
      it('Then only their blob is in the tree', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const theirs = await writeBlob(ctx, 'theirs\n');
        const conflict: MergeConflict = {
          type: 'distinct-types',
          path: 'f' as FilePath,
          theirPath: 'f~side' as FilePath,
          theirId: theirs,
          theirMode: FILE_MODE.REGULAR,
        };
        const sut = resultOf;

        // Act
        const result = await sut(ctx, conflict);

        // Assert
        expect(result).toBe(await treeOf(ctx, [[FILE_MODE.REGULAR, 'f~side', theirs]]));
      });
    });
  });

  describe('Given a content conflict whose sides differ in mode', () => {
    describe('When no merged mode is recorded', () => {
      it('Then the path takes our mode', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const ours = await writeBlob(ctx, 'ours\n');
        const conflict: MergeConflict = {
          type: 'content',
          path: 'f' as FilePath,
          ourId: ours,
          ourMode: FILE_MODE.REGULAR,
          theirMode: FILE_MODE.EXECUTABLE,
        };
        const sut = resultOf;

        // Act
        const result = await sut(ctx, conflict);

        // Assert
        expect(result).toBe(await treeOf(ctx, [[FILE_MODE.REGULAR, 'f', ours]]));
      });
    });
  });
});

describe('applyMergeToWorktree writes through the working-tree writer', () => {
  const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

  const configure = async (ctx: Context, config: string): Promise<void> => {
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, config);
    invalidateConfigCache(ctx);
  };

  const blobTree = async (
    ctx: Context,
    files: Readonly<Record<string, string>>,
  ): Promise<{ readonly tree: ObjectId; readonly ids: Readonly<Record<string, ObjectId>> }> => {
    const ids: Record<string, ObjectId> = {};
    for (const [name, content] of Object.entries(files)) ids[name] = await writeBlob(ctx, content);
    const entries = Object.entries(ids).map(([name, id]) =>
      treeEntry(FILE_MODE.REGULAR, name as FilePath, id),
    );
    return { tree: await treeWith(ctx, entries), ids };
  };

  class RecordingSmudgeRunner implements CommandRunner {
    readonly calls: CommandRequest[] = [];

    async run(request: CommandRequest): Promise<CommandResult> {
      this.calls.push(request);
      return { exitCode: 0, stdout: new TextEncoder().encode('smudged\n') };
    }
  }

  const AUTOCRLF = '[core]\n\tautocrlf = true\n';
  const LABELS = { ours: 'HEAD', theirs: 's', base: 'base' } as const;

  describe('Given core.autocrlf true and a content conflict', () => {
    describe('When the merge is applied', () => {
      it('Then the conflict markers and lines are CRLF in the worktree', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await configure(ctx, AUTOCRLF);
        const base = await blobTree(ctx, { f: 'a\nb\n' });
        const ours = await blobTree(ctx, { f: 'y\nb\n' });
        const theirs = await blobTree(ctx, { f: 'x\nb\n' });
        await ctx.fs.write(`${ctx.layout.workDir}/f`, enc('y\r\nb\r\n'));
        const sut = applyMergeToWorktree;

        // Act
        const result = await sut(ctx, {
          baseTree: base.tree,
          oursTree: ours.tree,
          theirsTree: theirs.tree,
          currentIndex: index([indexEntry('f', ours.ids.f as ObjectId)]),
          labels: LABELS,
        });

        // Assert
        expect(result.kind).toBe('conflict');
        expect(await readWork(ctx, 'f')).toBe(
          '<<<<<<< HEAD\r\ny\r\n=======\r\nx\r\n>>>>>>> s\r\nb\r\n',
        );
      });
    });
  });

  describe('Given core.autocrlf true and a clean content merge', () => {
    describe('When the merge is applied', () => {
      it('Then the worktree is CRLF and the merged blob LF', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await configure(ctx, AUTOCRLF);
        const base = await blobTree(ctx, { f: 'a\nb\nc\n' });
        const ours = await blobTree(ctx, { f: 'x\nb\nc\n' });
        const theirs = await blobTree(ctx, { f: 'a\nb\ny\n' });
        await ctx.fs.write(`${ctx.layout.workDir}/f`, enc('x\r\nb\r\nc\r\n'));
        const sut = applyMergeToWorktree;

        // Act
        const result = await sut(ctx, {
          baseTree: base.tree,
          oursTree: ours.tree,
          theirsTree: theirs.tree,
          currentIndex: index([indexEntry('f', ours.ids.f as ObjectId)]),
        });

        // Assert
        expect(result.kind).toBe('clean');
        expect(await readWork(ctx, 'f')).toBe('x\r\nb\r\ny\r\n');
        if (result.kind !== 'clean') return;
        const merged = result.result.newIndexEntries.find((e) => e.path === 'f');
        expect(merged?.id).toBe(await writeBlob(ctx, 'x\nb\ny\n'));
      });
    });
  });

  describe('Given core.autocrlf true, a conflict and a cleanly merged sibling', () => {
    describe('When the merge is applied', () => {
      it('Then the merged sibling is CRLF in the worktree', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await configure(ctx, AUTOCRLF);
        const base = await blobTree(ctx, { c: 'a\nb\n', m: 'a\nb\nc\n' });
        const ours = await blobTree(ctx, { c: 'y\nb\n', m: 'x\nb\nc\n' });
        const theirs = await blobTree(ctx, { c: 'x\nb\n', m: 'a\nb\ny\n' });
        await ctx.fs.write(`${ctx.layout.workDir}/c`, enc('y\r\nb\r\n'));
        await ctx.fs.write(`${ctx.layout.workDir}/m`, enc('x\r\nb\r\nc\r\n'));
        const sut = applyMergeToWorktree;

        // Act
        await sut(ctx, {
          baseTree: base.tree,
          oursTree: ours.tree,
          theirsTree: theirs.tree,
          currentIndex: index([
            indexEntry('c', ours.ids.c as ObjectId),
            indexEntry('m', ours.ids.m as ObjectId),
          ]),
          labels: LABELS,
        });

        // Assert
        expect(await readWork(ctx, 'm')).toBe('x\r\nb\r\ny\r\n');
      });
    });
  });

  describe('Given a [filter "up"] smudge driver and a merged path beside a conflict', () => {
    describe('When the merge is applied', () => {
      it('Then the smudge driver received the merged bytes', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await configure(ctx, '[filter "up"]\n\tsmudge = up\n');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, 'm filter=up\n');
        const runner = new RecordingSmudgeRunner();
        const base = await blobTree(ctx, { c: 'a\nb\n', m: 'a\nb\nc\n' });
        const ours = await blobTree(ctx, { c: 'y\nb\n', m: 'x\nb\nc\n' });
        const theirs = await blobTree(ctx, { c: 'x\nb\n', m: 'a\nb\ny\n' });
        await ctx.fs.write(`${ctx.layout.workDir}/c`, enc('y\nb\n'));
        await ctx.fs.write(`${ctx.layout.workDir}/m`, enc('x\nb\nc\n'));
        const sut = applyMergeToWorktree;

        // Act
        await sut(
          { ...ctx, command: runner },
          {
            baseTree: base.tree,
            oursTree: ours.tree,
            theirsTree: theirs.tree,
            currentIndex: index([
              indexEntry('c', ours.ids.c as ObjectId),
              indexEntry('m', ours.ids.m as ObjectId),
            ]),
            labels: LABELS,
          },
        );

        // Assert
        expect(runner.calls.map((call) => new TextDecoder().decode(call.stdin))).toEqual([
          'x\nb\ny\n',
        ]);
        expect(await readWork(ctx, 'm')).toBe('smudged\n');
      });
    });
  });

  describe('Given core.autocrlf true and both sides adding a regular file and a symlink at one path', () => {
    describe('When the merge is applied', () => {
      it('Then the regular side is CRLF at its own path', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await configure(ctx, AUTOCRLF);
        const regular = await writeBlob(ctx, 'a\nb\n');
        const link = await writeBlob(ctx, '/etc/target');
        const base = await treeWith(ctx, []);
        const ours = await treeWith(ctx, [treeEntry(FILE_MODE.REGULAR, 'f' as FilePath, regular)]);
        const theirs = await treeWith(ctx, [treeEntry(FILE_MODE.SYMLINK, 'f' as FilePath, link)]);
        await ctx.fs.write(`${ctx.layout.workDir}/f`, enc('a\r\nb\r\n'));
        const sut = applyMergeToWorktree;

        // Act
        const result = await sut(ctx, {
          baseTree: base,
          oursTree: ours,
          theirsTree: theirs,
          currentIndex: index([indexEntry('f', regular)]),
          labels: LABELS,
        });

        // Assert
        expect(result.kind).toBe('conflict');
        if (result.kind !== 'conflict') return;
        const ourPath = result.conflicts[0]?.ourPath;
        expect(await readWork(ctx, ourPath as string)).toBe('a\r\nb\r\n');
      });
    });
  });

  describe('Given a content-conflicted .gitattributes and a sibling merged cleanly', () => {
    describe('When the merge is applied', () => {
      it('Then the marker-bearing .gitattributes governs the sibling conversion', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const base = await blobTree(ctx, { '.gitattributes': '* text\n', m: 'a\nb\nc\n' });
        const ours = await blobTree(ctx, {
          '.gitattributes': '* text eol=lf\n',
          m: 'x\nb\nc\n',
        });
        const theirs = await blobTree(ctx, {
          '.gitattributes': '* text eol=crlf\n',
          m: 'a\nb\ny\n',
        });
        await ctx.fs.write(`${ctx.layout.workDir}/.gitattributes`, enc('* text eol=lf\n'));
        await ctx.fs.write(`${ctx.layout.workDir}/m`, enc('x\nb\nc\n'));
        const sut = applyMergeToWorktree;

        // Act
        await sut(ctx, {
          baseTree: base.tree,
          oursTree: ours.tree,
          theirsTree: theirs.tree,
          currentIndex: index([
            indexEntry('.gitattributes', ours.ids['.gitattributes'] as ObjectId),
            indexEntry('m', ours.ids.m as ObjectId),
          ]),
          labels: LABELS,
        });

        // Assert
        expect(await readWork(ctx, 'm')).toBe('x\r\nb\r\ny\r\n');
      });
    });
  });

  describe('Given a .gitattributes both sides edited on different lines and a path that conflicts', () => {
    describe('When the merge is applied', () => {
      it('Then the cleanly merged .gitattributes governs the sibling conversion', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const comments = (first: string, last = '# l7') =>
          [first, '# l2', '# l3', '# l4', '# l5', '# l6', last, ''].join('\n');
        const base = await blobTree(ctx, {
          '.gitattributes': comments('# l1'),
          c: 'x\n',
          'f.txt': 'a\nb\n',
        });
        const ours = await blobTree(ctx, {
          '.gitattributes': comments('# ours'),
          c: 'o\n',
          'f.txt': 'a\nb\n',
        });
        const theirs = await blobTree(ctx, {
          '.gitattributes': comments('# l1', '*.txt eol=crlf'),
          c: 't\n',
          'f.txt': 'a\nB\n',
        });
        await ctx.fs.write(`${ctx.layout.workDir}/.gitattributes`, enc(comments('# ours')));
        await ctx.fs.write(`${ctx.layout.workDir}/c`, enc('o\n'));
        await ctx.fs.write(`${ctx.layout.workDir}/f.txt`, enc('a\nb\n'));
        const sut = applyMergeToWorktree;

        // Act
        await sut(ctx, {
          baseTree: base.tree,
          oursTree: ours.tree,
          theirsTree: theirs.tree,
          currentIndex: index(
            ['.gitattributes', 'c', 'f.txt'].map((name) =>
              indexEntry(name, ours.ids[name] as ObjectId),
            ),
          ),
          labels: LABELS,
        });

        // Assert
        expect(await readWork(ctx, 'f.txt')).toBe('a\r\nB\r\n');
      });
    });
  });

  describe('Given theirs deletes the .gitattributes that ours still carries and a path conflicts', () => {
    describe('When the merge is applied', () => {
      it('Then the siblings are written without the deleted attributes, whatever their path order', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const text = 'a\nb\nc\n';
        const base = await blobTree(ctx, {
          '-f': text,
          '.gitattributes': '* eol=crlf\n',
          c: 'x\n',
          f: text,
        });
        const ours = await blobTree(ctx, {
          '-f': text,
          '.gitattributes': '* eol=crlf\n',
          c: 'o\n',
          f: text,
        });
        const theirs = await blobTree(ctx, { '-f': 'a\nb\nC\n', c: 't\n', f: 'a\nb\nC\n' });
        for (const name of ['-f', 'f'])
          await ctx.fs.write(`${ctx.layout.workDir}/${name}`, enc('a\r\nb\r\nc\r\n'));
        await ctx.fs.write(`${ctx.layout.workDir}/.gitattributes`, enc('* eol=crlf\n'));
        await ctx.fs.write(`${ctx.layout.workDir}/c`, enc('o\n'));
        const sut = applyMergeToWorktree;

        // Act
        await sut(ctx, {
          baseTree: base.tree,
          oursTree: ours.tree,
          theirsTree: theirs.tree,
          currentIndex: index(
            ['-f', '.gitattributes', 'c', 'f'].map((name) =>
              indexEntry(name, ours.ids[name] as ObjectId),
            ),
          ),
          labels: LABELS,
        });

        // Assert
        expect(await readWork(ctx, 'f')).toBe('a\nb\nC\n');
        expect(await readWork(ctx, '-f')).toBe('a\nb\nC\n');
      });
    });
  });

  const NORMALIZING_ATTRIBUTES = '* text=auto\n';

  /** Base `f` in CRLF; theirs adds `* text=auto` and renormalizes `f` (editing line 1 unless `edit` is false); ours edits line 3 or deletes `f`. */
  const renormalizingTrees = async (
    ctx: Context,
    options: { readonly theirsEdits: boolean; readonly oursDeletes: boolean },
  ) => {
    const file = (name: string, blob: ObjectId) =>
      treeEntry(FILE_MODE.REGULAR, name as FilePath, blob);
    const base = await writeBlob(ctx, 'a\r\nb\r\nc\r\n');
    const ours = await writeBlob(ctx, 'a\r\nb\r\nC\r\n');
    const theirs = await writeBlob(ctx, options.theirsEdits ? 'A\nb\nc\n' : 'a\nb\nc\n');
    const other = await writeBlob(ctx, 'g\n');
    const attributes = await writeBlob(ctx, NORMALIZING_ATTRIBUTES);
    const oursEntries = options.oursDeletes
      ? [file('g', other)]
      : [file('f', ours), file('g', other)];
    await ctx.fs.write(`${ctx.layout.workDir}/g`, new TextEncoder().encode('g\n'));
    if (!options.oursDeletes) {
      await ctx.fs.write(`${ctx.layout.workDir}/f`, new TextEncoder().encode('a\r\nb\r\nC\r\n'));
    }
    return {
      baseTree: await treeWith(ctx, [file('f', base), file('g', other)]),
      oursTree: await treeWith(ctx, oursEntries),
      theirsTree: await treeWith(ctx, [
        file('.gitattributes', attributes),
        file('f', theirs),
        file('g', other),
      ]),
      currentIndex: index([
        ...(options.oursDeletes ? [] : [indexEntry('f', ours)]),
        indexEntry('g', other),
      ]),
    };
  };

  describe('Given merge.renormalize true and the cherry-pick history', () => {
    describe('When applyMergeToWorktree runs', () => {
      it('Then it is clean with f holding the normalized merge', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[merge]\n\trenormalize = true\n');
        const input = await renormalizingTrees(ctx, { theirsEdits: true, oursDeletes: false });
        const sut = applyMergeToWorktree;

        // Act
        const result = await sut(ctx, input);

        // Assert
        expect(result.kind).toBe('clean');
        if (result.kind !== 'clean') return;
        const merged = await flattenTree(ctx, result.mergedTree);
        expect(merged.entries.get('f' as FilePath)?.id).toBe(await writeBlob(ctx, 'A\nb\nC\n'));
      });
    });
  });

  describe('Given no merge.renormalize and the cherry-pick history', () => {
    describe('When applyMergeToWorktree runs', () => {
      it('Then f conflicts', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const input = await renormalizingTrees(ctx, { theirsEdits: true, oursDeletes: false });
        const sut = applyMergeToWorktree;

        // Act
        const result = await sut(ctx, input);

        // Assert
        expect(result.kind).toBe('conflict');
      });
    });
  });

  describe('Given merge.renormalize = foo', () => {
    describe('When applyMergeToWorktree runs', () => {
      it('Then it refuses with CONFIG_BAD_BOOLEAN_VALUE', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[merge]\n\trenormalize = foo\n');
        const input = await renormalizingTrees(ctx, { theirsEdits: true, oursDeletes: false });
        const sut = applyMergeToWorktree;

        // Act
        const result = await sut(ctx, input).catch((e: unknown) => e);

        // Assert
        expect((result as TsgitError).data).toMatchObject({
          code: 'CONFIG_BAD_BOOLEAN_VALUE',
          key: 'merge.renormalize',
          value: 'foo',
        });
      });
    });
  });

  describe('Given merge.renormalize true and the modify/delete history', () => {
    describe('When applyMergeToWorktree runs', () => {
      it('Then the delete merges cleanly', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[merge]\n\trenormalize = true\n');
        const input = await renormalizingTrees(ctx, { theirsEdits: false, oursDeletes: true });
        const sut = applyMergeToWorktree;

        // Act
        const result = await sut(ctx, input);

        // Assert
        expect(result.kind).toBe('clean');
        if (result.kind !== 'clean') return;
        const merged = await flattenTree(ctx, result.mergedTree);
        expect(merged.entries.has('f' as FilePath)).toBe(false);
      });
    });
  });

  describe('Given merge.renormalize true and the cherry-pick history', () => {
    describe('When mergeTreesToTree runs', () => {
      it('Then it is clean with f holding the normalized merge', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[merge]\n\trenormalize = true\n');
        const { baseTree, oursTree, theirsTree } = await renormalizingTrees(ctx, {
          theirsEdits: true,
          oursDeletes: false,
        });
        const sut = mergeTreesToTree;

        // Act
        const result = await sut(ctx, { baseTree, oursTree, theirsTree });

        // Assert
        expect(result.kind).toBe('clean');
        if (result.kind !== 'clean') return;
        const merged = await flattenTree(ctx, result.mergedTree);
        expect(merged.entries.get('f' as FilePath)?.id).toBe(await writeBlob(ctx, 'A\nb\nC\n'));
      });
    });
  });

  describe('Given no merge.renormalize and the cherry-pick history', () => {
    describe('When mergeTreesToTree runs', () => {
      it('Then it conflicts', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const { baseTree, oursTree, theirsTree } = await renormalizingTrees(ctx, {
          theirsEdits: true,
          oursDeletes: false,
        });
        const sut = mergeTreesToTree;

        // Act
        const result = await sut(ctx, { baseTree, oursTree, theirsTree });

        // Assert
        expect(result.kind).toBe('conflict');
      });
    });
  });
});

describe('removeChangedOutcome', () => {
  describe('Given a deleted outcome under a directory whose name is not valid UTF-8', () => {
    describe('When removeChangedOutcome runs', () => {
      it('Then no filesystem call is made', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const spies = (['lstat', 'rm', 'rmdir', 'readdir'] as const).map((method) =>
          vi.spyOn(ctx.fs, method),
        );
        const sut = removeChangedOutcome;

        // Act
        await sut(
          ctx,
          { status: 'resolved-deleted', path: '\uDCFF/f' as FilePath },
          createLeadingPathScanner(ctx),
          survivingDirectoriesOf([]),
        );

        // Assert
        expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0, 0]);
      });
    });
  });
});

describe('removeDisplacedFile', () => {
  describe('Given a distinct-types conflict whose ours side is moved aside', () => {
    describe('When removeDisplacedFile runs', () => {
      it('Then the file at the conflict path stays, as no directory displaces it', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const file = `${ctx.layout.workDir}/p`;
        await ctx.fs.write(file, new TextEncoder().encode('p\n'));
        const conflict: MergeConflict = {
          type: 'distinct-types',
          path: 'p' as FilePath,
          ourId: '' as ObjectId,
          ourMode: FILE_MODE.REGULAR,
          ourPath: 'p~HEAD' as FilePath,
          theirId: '' as ObjectId,
          theirMode: FILE_MODE.SYMLINK,
          theirPath: 'p' as FilePath,
        };
        const sut = removeDisplacedFile;

        // Act
        await sut(ctx, conflict);

        // Assert
        expect(await ctx.fs.exists(file)).toBe(true);
      });
    });
  });

  describe('Given a file-directory conflict at a hostile path', () => {
    describe('When removeDisplacedFile runs', () => {
      it('Then it refuses with INVALID_INDEX_ENTRY before removing anything', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const conflict: MergeConflict = {
          type: 'file-directory',
          path: '.git' as FilePath,
          ourId: '' as ObjectId,
          ourMode: FILE_MODE.REGULAR,
          ourPath: '.git~HEAD' as FilePath,
        };
        const rm = vi.spyOn(ctx.fs, 'rm');
        const sut = removeDisplacedFile;

        // Act
        const failure = await sut(ctx, conflict).catch((err: unknown) => err);

        // Assert
        expect((failure as TsgitError).data).toEqual({
          code: 'INVALID_INDEX_ENTRY',
          offset: -1,
          reason: "'.git' component rejected",
        });
        expect(rm).not.toHaveBeenCalled();
      });
    });
  });
});

describe('Given a conflicting merge that deletes the last file of a directory where theirs adds a non-UTF-8 name', () => {
  describe('When the merge is applied', () => {
    it('Then the directory the unwritable entry is recorded under stays', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const reg = FILE_MODE.REGULAR;
      const [cBase, cOurs, cTheirs, y, lossy] = [
        await writeBlob(ctx, 'base\n'),
        await writeBlob(ctx, 'ours\n'),
        await writeBlob(ctx, 'theirs\n'),
        await writeBlob(ctx, 'y\n'),
        await writeBlob(ctx, 'l\n'),
      ];
      const dOurs = await treeWith(ctx, [treeEntry(reg, 'y', y)]);
      const dTheirs = await treeWith(ctx, [treeEntry(reg, Uint8Array.of(0xff), lossy)]);
      const side = (c: ObjectId, d: ObjectId) =>
        treeWith(ctx, [treeEntry(reg, 'c.txt', c), treeEntry(FILE_MODE.DIRECTORY, 'd', d)]);
      const [base, ours, theirs] = [
        await side(cBase, dOurs),
        await side(cOurs, dOurs),
        await side(cTheirs, dTheirs),
      ];
      await ctx.fs.write(`${ctx.layout.workDir}/c.txt`, new TextEncoder().encode('ours\n'));
      await ctx.fs.write(`${ctx.layout.workDir}/d/y`, new TextEncoder().encode('y\n'));
      const sut = applyMergeToWorktree;

      // Act
      const result = await sut(ctx, {
        baseTree: base,
        oursTree: ours,
        theirsTree: theirs,
        currentIndex: index([indexEntry('c.txt', cOurs), indexEntry('d/y', y)]),
      });

      // Assert
      expect(result.kind).toBe('conflict');
      expect(await ctx.fs.exists(`${ctx.layout.workDir}/d/y`)).toBe(false);
      expect((await ctx.fs.lstat(`${ctx.layout.workDir}/d`)).isDirectory).toBe(true);
    });
  });
});
