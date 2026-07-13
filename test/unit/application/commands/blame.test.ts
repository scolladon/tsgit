import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import {
  type BlameResult,
  blame,
  type CommittedBlameLine,
} from '../../../../src/application/commands/blame.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { mergeRun } from '../../../../src/application/commands/merge.js';
import { mv } from '../../../../src/application/commands/mv.js';
import { createCommit } from '../../../../src/application/primitives/create-commit.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { TsgitError } from '../../../../src/domain/error.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { AuthorIdentity, ObjectId, Tree } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const ident = (name: string, timestamp: number): AuthorIdentity => ({
  name,
  email: `${name}@example.com`,
  timestamp,
  timezoneOffset: '+0000',
});

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** Narrow a committed-rev result to its committed lines, asserting none is uncommitted. */
const committedLines = (result: BlameResult): readonly CommittedBlameLine[] =>
  result.lines.map((line) => {
    if (!line.committed) throw new Error('expected a committed line');
    return line;
  });

let clock = 1_700_000_000;

const commitFile = async (
  ctx: Context,
  name: string,
  path: string,
  content: string,
): Promise<ObjectId> => {
  clock += 60;
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${path}`, content);
  await add(ctx, [path]);
  const result = await commit(ctx, {
    message: `${name} subject\n\nbody`,
    author: ident(name, clock),
    committer: ident(name, clock),
  });
  return result.id;
};

const seed = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  return ctx;
};

describe('Given a linear history that modifies one line and appends another', () => {
  describe('When blaming the file', () => {
    it('Then each line is attributed to the commit that last touched it', async () => {
      // Arrange
      const ctx = await seed();
      const c1 = await commitFile(ctx, 'c1', 'f.txt', 'line1\nline2\nline3\n');
      const c2 = await commitFile(ctx, 'c2', 'f.txt', 'line1\nline2-mod\nline3\nline4\n');

      // Act
      const sut = await blame(ctx, 'f.txt');

      // Assert
      expect(committedLines(sut).map((l) => l.commit)).toEqual([c1, c2, c1, c2]);
      expect(sut.lines.map((l) => l.finalLine)).toEqual([1, 2, 3, 4]);
      expect(sut.lines.map((l) => text(l.content))).toEqual([
        'line1\n',
        'line2-mod\n',
        'line3\n',
        'line4\n',
      ]);
    });

    it('Then root-commit lines are boundaries and later-commit lines carry previous', async () => {
      // Arrange
      const ctx = await seed();
      const c1 = await commitFile(ctx, 'c1', 'f.txt', 'line1\nline2\nline3\n');
      await commitFile(ctx, 'c2', 'f.txt', 'line1\nline2-mod\nline3\nline4\n');

      // Act
      const sut = await blame(ctx, 'f.txt');

      // Assert
      expect(committedLines(sut)[0]!.boundary).toBe(true);
      expect(sut.lines[0]!.previous).toBeUndefined();
      expect(committedLines(sut)[1]!.boundary).toBe(false);
      expect(sut.lines[1]!.previous).toEqual({ commit: c1, path: 'f.txt' });
    });
  });
});

describe('Given a commit that prepends lines above existing content', () => {
  describe('When blaming the file', () => {
    it('Then surviving lines keep their source line but gain a new final line', async () => {
      // Arrange
      const ctx = await seed();
      const c1 = await commitFile(ctx, 'c1', 'f.txt', 'orig1\norig2\n');
      const c2 = await commitFile(ctx, 'c2', 'f.txt', 'new1\nnew2\norig1\norig2\n');

      // Act
      const sut = await blame(ctx, 'f.txt');

      // Assert
      expect(committedLines(sut).map((l) => l.commit)).toEqual([c2, c2, c1, c1]);
      expect(sut.lines.map((l) => l.finalLine)).toEqual([1, 2, 3, 4]);
      expect(sut.lines.map((l) => l.sourceLine)).toEqual([1, 2, 1, 2]);
    });
  });
});

describe('Given a single root commit', () => {
  describe('When blaming the file', () => {
    it('Then the line is a boundary carrying the commit subject', async () => {
      // Arrange
      const ctx = await seed();
      const c1 = await commitFile(ctx, 'c1', 'f.txt', 'only\n');

      // Act
      const sut = await blame(ctx, 'f.txt');

      // Assert
      expect(sut.lines).toHaveLength(1);
      expect(committedLines(sut)[0]!.commit).toBe(c1);
      expect(committedLines(sut)[0]!.boundary).toBe(true);
      expect(committedLines(sut)[0]!.summary).toBe('c1 subject');
      expect(sut.lines[0]!.sourcePath).toBe('f.txt');
    });
  });
});

describe('Given an empty file', () => {
  describe('When blaming it', () => {
    it('Then no lines are reported', async () => {
      // Arrange
      const ctx = await seed();
      await commitFile(ctx, 'c1', 'empty.txt', '');

      // Act
      const sut = await blame(ctx, 'empty.txt');

      // Assert
      expect(sut.lines).toEqual([]);
      expect(sut.path).toBe('empty.txt');
    });
  });
});

describe('Given a path absent from the revision', () => {
  describe('When blaming it', () => {
    it('Then it refuses with PATH_NOT_IN_TREE', async () => {
      // Arrange
      const ctx = await seed();
      await commitFile(ctx, 'c1', 'f.txt', 'a\n');

      // Act + Assert
      try {
        await blame(ctx, 'missing.txt');
        expect.unreachable('blame should refuse an absent path');
      } catch (error) {
        expect(error).toBeInstanceOf(TsgitError);
        expect((error as TsgitError).data).toMatchObject({
          code: 'PATH_NOT_IN_TREE',
          path: 'missing.txt',
        });
      }
    });
  });
});

describe('Given a path that names a directory', () => {
  describe('When blaming it', () => {
    it('Then it refuses with PATH_NOT_IN_TREE', async () => {
      // Arrange
      const ctx = await seed();
      await commitFile(ctx, 'c1', 'dir/a.txt', 'x\n');
      await commitFile(ctx, 'c2', 'dir/b.txt', 'y\n');

      // Act + Assert
      try {
        await blame(ctx, 'dir');
        expect.unreachable('blame should refuse a directory path');
      } catch (error) {
        expect(error).toBeInstanceOf(TsgitError);
        expect((error as TsgitError).data).toMatchObject({
          code: 'PATH_NOT_IN_TREE',
          path: 'dir',
        });
      }
    });
  });
});

describe('Given a path that names a gitlink submodule entry', () => {
  describe('When blaming it', () => {
    it('Then it refuses with PATH_NOT_IN_TREE', async () => {
      // Arrange
      const ctx = await seed();
      const base = await commitFile(ctx, 'c1', 'keep.txt', 'x\n');
      const treeId = await writeObject(ctx, {
        type: 'tree',
        id: '' as ObjectId,
        entries: [{ mode: FILE_MODE.GITLINK, name: 'mysub', id: base }],
      } as Tree);
      clock += 60;
      const rev = await createCommit(ctx, {
        tree: treeId,
        parents: [base],
        author: ident('c2', clock),
        committer: ident('c2', clock),
        message: 'add submodule',
      });

      // Act + Assert
      try {
        await blame(ctx, 'mysub', { rev });
        expect.unreachable('blame should refuse a gitlink path');
      } catch (error) {
        expect(error).toBeInstanceOf(TsgitError);
        expect((error as TsgitError).data).toMatchObject({
          code: 'PATH_NOT_IN_TREE',
          path: 'mysub',
        });
      }
    });
  });
});

describe('Given an explicit older revision', () => {
  describe('When blaming the file as of that revision', () => {
    it('Then only that revision content is blamed', async () => {
      // Arrange
      const ctx = await seed();
      const c1 = await commitFile(ctx, 'c1', 'f.txt', 'line1\nline2\n');
      await commitFile(ctx, 'c2', 'f.txt', 'line1\nline2-mod\n');

      // Act
      const sut = await blame(ctx, 'f.txt', { rev: c1 });

      // Assert
      expect(committedLines(sut).map((l) => l.commit)).toEqual([c1, c1]);
      expect(sut.lines.map((l) => text(l.content))).toEqual(['line1\n', 'line2\n']);
    });
  });
});

describe('Given a clean merge of two branches that changed different lines', () => {
  describe('When blaming the merge tip', () => {
    it('Then each line is blamed to the branch that changed it, never the merge', async () => {
      // Arrange — side changes line 1, main changes line 3, line 2 untouched
      const ctx = await seed();
      const c1 = await commitFile(ctx, 'c1', 'f.txt', 'a\nb\nc\n');
      await branchCreate(ctx, { name: 'side' });
      await checkout(ctx, { rev: 'side' });
      const side = await commitFile(ctx, 'side', 'f.txt', 'a-side\nb\nc\n');
      await checkout(ctx, { rev: 'main' });
      const main = await commitFile(ctx, 'main', 'f.txt', 'a\nb\nc-main\n');
      clock += 60;
      const merged = await mergeRun(ctx, {
        rev: 'side',
        author: ident('merger', clock),
        committer: ident('merger', clock),
      });

      // Act
      const sut = await blame(ctx, 'f.txt');

      // Assert
      expect(merged.kind).toBe('merge');
      expect(committedLines(sut).map((l) => l.commit)).toEqual([side, c1, main]);
      expect(sut.lines.map((l) => text(l.content))).toEqual(['a-side\n', 'b\n', 'c-main\n']);
      expect(committedLines(sut)[1]!.boundary).toBe(true);
      const mergeId = merged.kind === 'merge' ? merged.id : undefined;
      expect(committedLines(sut).some((l) => l.commit === mergeId)).toBe(false);
    });
  });
});

describe('Given a file first added by a non-root commit', () => {
  describe('When blaming it', () => {
    it('Then its lines blame the adding commit, with no boundary and no previous', async () => {
      // Arrange — c1 touches another file; c2 introduces f.txt fresh (no rename)
      const ctx = await seed();
      await commitFile(ctx, 'c1', 'other.txt', 'unrelated\n');
      const c2 = await commitFile(ctx, 'c2', 'f.txt', 'fresh1\nfresh2\n');

      // Act
      const sut = await blame(ctx, 'f.txt');

      // Assert
      expect(committedLines(sut).map((l) => l.commit)).toEqual([c2, c2]);
      expect(committedLines(sut).every((l) => l.boundary)).toBe(false);
      expect(sut.lines.every((l) => l.previous === undefined)).toBe(true);
    });
  });
});

describe('Given a file renamed wholesale by a later commit', () => {
  describe('When blaming the file under its new name', () => {
    it('Then lines are followed across the rename to their originating commits', async () => {
      // Arrange
      const ctx = await seed();
      const c1 = await commitFile(ctx, 'c1', 'f.txt', 'line1\nline2\n');
      const c2 = await commitFile(ctx, 'c2', 'f.txt', 'line1\nline2-mod\n');
      await mv(ctx, ['f.txt'], 'renamed.txt');
      clock += 60;
      const c3 = (
        await commit(ctx, {
          message: 'c3 rename',
          author: ident('c3', clock),
          committer: ident('c3', clock),
        })
      ).id;

      // Act
      const sut = await blame(ctx, 'renamed.txt');

      // Assert
      expect(committedLines(sut).map((l) => l.commit)).toEqual([c1, c2]);
      expect(sut.lines.map((l) => l.sourcePath)).toEqual(['f.txt', 'f.txt']);
      expect(sut.lines.map((l) => l.finalLine)).toEqual([1, 2]);
      expect(committedLines(sut).some((l) => l.commit === c3)).toBe(false);
      expect(sut.lines[1]!.previous).toEqual({ commit: c1, path: 'f.txt' });
    });
  });
});

describe('Given a commit that rewrites every line of the file', () => {
  describe('When blaming the file', () => {
    it('Then all lines are blamed to the rewrite, none to the original', async () => {
      // Arrange
      const ctx = await seed();
      const c1 = await commitFile(ctx, 'c1', 'f.txt', 'a\nb\n');
      const c2 = await commitFile(ctx, 'c2', 'f.txt', 'x\ny\n');

      // Act
      const sut = await blame(ctx, 'f.txt');

      // Assert
      expect(committedLines(sut).map((l) => l.commit)).toEqual([c2, c2]);
      expect(committedLines(sut).some((l) => l.commit === c1)).toBe(false);
    });
  });
});

describe('Given a commit whose parent has a differing blob at the same path', () => {
  describe('When blaming the file', () => {
    it('Then the differing line is blamed at the child, not passed to the parent', async () => {
      // Arrange — c2's f.txt differs from c1's at the parent-entry oid, so the
      // suspect must diff against the parent rather than skip straight through.
      const ctx = await seed();
      const c1 = await commitFile(ctx, 'c1', 'f.txt', 'a\nb\nc\n');
      const c2 = await commitFile(ctx, 'c2', 'f.txt', 'a\nB\nc\n');

      // Act
      const sut = await blame(ctx, 'f.txt');

      // Assert
      expect(committedLines(sut).map((l) => l.commit)).toEqual([c1, c2, c1]);
    });
  });
});

describe('Given a commit whose parent has the identical blob at the same path', () => {
  describe('When blaming the file', () => {
    it('Then every line passes through to the ancestor unchanged', async () => {
      // Arrange — c2 touches an unrelated file, leaving f.txt's tree entry
      // identical (same oid) to c1's — every line must pass straight to c1.
      const ctx = await seed();
      const c1 = await commitFile(ctx, 'c1', 'f.txt', 'a\nb\nc\n');
      await commitFile(ctx, 'c2', 'other.txt', 'unrelated\n');

      // Act
      const sut = await blame(ctx, 'f.txt');

      // Assert
      expect(committedLines(sut).map((l) => l.commit)).toEqual([c1, c1, c1]);
      expect(committedLines(sut).every((l) => l.boundary)).toBe(true);
    });
  });
});

describe('Given a rename of a file inside a subdirectory', () => {
  describe('When blaming it under the new nested name', () => {
    it('Then the rename is followed across the subtree to the originating commit', async () => {
      // Arrange
      const ctx = await seed();
      const c1 = await commitFile(ctx, 'c1', 'dir/a.txt', 'deep1\ndeep2\n');
      await mv(ctx, ['dir/a.txt'], 'dir/b.txt');
      clock += 60;
      const c2 = (
        await commit(ctx, {
          message: 'c2 nested rename',
          author: ident('c2', clock),
          committer: ident('c2', clock),
        })
      ).id;

      // Act
      const sut = await blame(ctx, 'dir/b.txt');

      // Assert
      expect(committedLines(sut).map((l) => l.commit)).toEqual([c1, c1]);
      expect(sut.lines.map((l) => l.sourcePath)).toEqual(['dir/a.txt', 'dir/a.txt']);
      expect(committedLines(sut).some((l) => l.commit === c2)).toBe(false);
    });
  });
});

describe('Given a commit that renames two files at once', () => {
  describe('When blaming each renamed file', () => {
    it('Then each follows to its own source, not the other rename', async () => {
      // Arrange
      const ctx = await seed();
      clock += 60;
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'aa\n');
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'bb\n');
      await add(ctx, ['a.txt', 'b.txt']);
      const c1 = (
        await commit(ctx, {
          message: 'c1 two files',
          author: ident('c1', clock),
          committer: ident('c1', clock),
        })
      ).id;
      await mv(ctx, ['a.txt'], 'x.txt');
      await mv(ctx, ['b.txt'], 'y.txt');
      clock += 60;
      await commit(ctx, {
        message: 'c2 two renames',
        author: ident('c2', clock),
        committer: ident('c2', clock),
      });

      // Act
      const blameX = await blame(ctx, 'x.txt');
      const blameY = await blame(ctx, 'y.txt');

      // Assert
      expect(committedLines(blameX).map((l) => l.commit)).toEqual([c1]);
      expect(blameX.lines[0]!.sourcePath).toBe('a.txt');
      expect(committedLines(blameY).map((l) => l.commit)).toEqual([c1]);
      expect(blameY.lines[0]!.sourcePath).toBe('b.txt');
    });
  });
});

describe('Given a multi-commit file and a line range', () => {
  const buildThreeLineFile = async (): Promise<{
    ctx: Context;
    c1: ObjectId;
    c2: ObjectId;
  }> => {
    const ctx = await seed();
    const c1 = await commitFile(ctx, 'c1', 'f.txt', 'a\nb\nc\n');
    const c2 = await commitFile(ctx, 'c2', 'f.txt', 'a\nb-mod\nc\n');
    return { ctx, c1, c2 };
  };

  describe('When blaming within the range', () => {
    it('Then only in-range lines are reported with authorship preserved', async () => {
      // Arrange
      const { ctx, c2 } = await buildThreeLineFile();

      // Act
      const sut = await blame(ctx, 'f.txt', { range: { start: 2, end: 2 } });

      // Assert
      expect(sut.lines.map((l) => l.finalLine)).toEqual([2]);
      expect(committedLines(sut)[0]!.commit).toBe(c2);
    });

    it('Then a multi-line range keeps each line on its own commit', async () => {
      // Arrange
      const { ctx, c1, c2 } = await buildThreeLineFile();

      // Act
      const sut = await blame(ctx, 'f.txt', { range: { start: 1, end: 2 } });

      // Assert
      expect(sut.lines.map((l) => l.finalLine)).toEqual([1, 2]);
      expect(committedLines(sut).map((l) => l.commit)).toEqual([c1, c2]);
    });

    it('Then an end past the last line is clamped to the file length', async () => {
      // Arrange
      const { ctx } = await buildThreeLineFile();

      // Act
      const sut = await blame(ctx, 'f.txt', { range: { start: 2, end: 100 } });

      // Assert
      expect(sut.lines.map((l) => l.finalLine)).toEqual([2, 3]);
    });
  });

  describe('When the range is invalid', () => {
    it('Then an inverted range refuses with INVALID_OPTION', async () => {
      // Arrange
      const { ctx } = await buildThreeLineFile();

      // Act + Assert
      await expect(blame(ctx, 'f.txt', { range: { start: 3, end: 1 } })).rejects.toMatchObject({
        data: { code: 'INVALID_OPTION', option: '-L', reason: 'range end 1 precedes start 3' },
      });
    });

    it('Then a start below 1 refuses with INVALID_OPTION', async () => {
      // Arrange
      const { ctx } = await buildThreeLineFile();

      // Act + Assert
      await expect(blame(ctx, 'f.txt', { range: { start: 0, end: 2 } })).rejects.toMatchObject({
        data: { code: 'INVALID_OPTION', option: '-L', reason: 'invalid line number: 0' },
      });
    });

    it('Then a start past the last line refuses with INVALID_OPTION', async () => {
      // Arrange
      const { ctx } = await buildThreeLineFile();

      // Act + Assert
      await expect(blame(ctx, 'f.txt', { range: { start: 10, end: 12 } })).rejects.toMatchObject({
        data: { code: 'INVALID_OPTION', option: '-L', reason: 'file has only 3 lines' },
      });
    });

    it('Then a non-integer bound refuses with INVALID_OPTION', async () => {
      // Arrange
      const { ctx } = await buildThreeLineFile();

      // Act + Assert
      await expect(blame(ctx, 'f.txt', { range: { start: 1.5, end: 2 } })).rejects.toMatchObject({
        data: { code: 'INVALID_OPTION', option: '-L', reason: 'line numbers must be integers' },
      });
    });
  });
});

const write = (ctx: Context, path: string, content: string): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.workDir}/${path}`, content);

describe('Given a worktree blame on a clean tree', () => {
  describe('When blaming with the worktree option', () => {
    it('Then the result is identical to blaming HEAD', async () => {
      // Arrange
      const ctx = await seed();
      await commitFile(ctx, 'c1', 'f.txt', 'a\nb\n');

      // Act
      const sut = await blame(ctx, 'f.txt', { worktree: true });

      // Assert
      expect(sut).toEqual(await blame(ctx, 'f.txt'));
      expect(sut.lines.every((l) => l.committed)).toBe(true);
    });
  });
});

describe('Given a tracked file modified in the worktree but not committed', () => {
  describe('When blaming the worktree', () => {
    it('Then the changed line blames the pseudo-commit and the rest their commits', async () => {
      // Arrange
      const ctx = await seed();
      const c1 = await commitFile(ctx, 'c1', 'f.txt', 'a\nb\nc\n');
      await write(ctx, 'f.txt', 'a\nB\nc\n');

      // Act
      const sut = await blame(ctx, 'f.txt', { worktree: true });

      // Assert
      expect(sut.lines.map((l) => l.committed)).toEqual([true, false, true]);
      expect(sut.lines.map((l) => l.finalLine)).toEqual([1, 2, 3]);
      expect(sut.lines[0]).toMatchObject({ committed: true, commit: c1 });
      expect(sut.lines[2]).toMatchObject({ committed: true, commit: c1 });
      const changed = sut.lines[1]!;
      expect(changed.committed).toBe(false);
      expect(changed.sourceLine).toBe(2);
      expect(text(changed.content)).toBe('B\n');
      expect(changed.previous).toEqual({ commit: c1, path: 'f.txt' });
    });
  });

  describe('When a new line is appended in the worktree', () => {
    it('Then the appended line blames the pseudo-commit with HEAD as previous', async () => {
      // Arrange
      const ctx = await seed();
      const c1 = await commitFile(ctx, 'c1', 'f.txt', 'a\nb\n');
      await write(ctx, 'f.txt', 'a\nb\nc\n');

      // Act
      const sut = await blame(ctx, 'f.txt', { worktree: true });

      // Assert
      expect(sut.lines.map((l) => l.committed)).toEqual([true, true, false]);
      const appended = sut.lines[2]!;
      expect(appended.finalLine).toBe(3);
      expect(appended.sourceLine).toBe(3);
      expect(text(appended.content)).toBe('c\n');
      expect(appended.previous).toEqual({ commit: c1, path: 'f.txt' });
    });
  });
});

describe('Given a new file staged but never committed', () => {
  describe('When blaming the worktree', () => {
    it('Then every line blames the pseudo-commit with no previous', async () => {
      // Arrange
      const ctx = await seed();
      await commitFile(ctx, 'c1', 'other.txt', 'x\n');
      await write(ctx, 'new.txt', 'p\nq\n');
      await add(ctx, ['new.txt']);

      // Act
      const sut = await blame(ctx, 'new.txt', { worktree: true });

      // Assert
      expect(sut.lines.map((l) => l.committed)).toEqual([false, false]);
      expect(sut.lines.map((l) => l.finalLine)).toEqual([1, 2]);
      expect(sut.lines.map((l) => l.sourceLine)).toEqual([1, 2]);
      expect(sut.lines.every((l) => l.previous === undefined)).toBe(true);
      expect(sut.lines.map((l) => text(l.content))).toEqual(['p\n', 'q\n']);
    });
  });
});

describe('Given a committed symlink whose target changed in the worktree', () => {
  describe('When blaming the worktree', () => {
    it('Then the link blames the pseudo-commit with its new target as content', async () => {
      // Arrange — commit a symlink, then repoint it in the worktree
      const ctx = await seed();
      await ctx.fs.symlink('old/target', `${ctx.layout.workDir}/link`);
      await add(ctx, ['link']);
      clock += 60;
      await commit(ctx, {
        message: 'c1 subject\n\nbody',
        author: ident('c1', clock),
        committer: ident('c1', clock),
      });
      await ctx.fs.rm(`${ctx.layout.workDir}/link`);
      await ctx.fs.symlink('new/target', `${ctx.layout.workDir}/link`);

      // Act
      const sut = await blame(ctx, 'link', { worktree: true });

      // Assert — a symlink's content is its target string (no trailing newline)
      expect(sut.lines.map((l) => l.committed)).toEqual([false]);
      expect(text(sut.lines[0]!.content)).toBe('new/target');
    });
  });
});

describe('Given a worktree blame and a line range', () => {
  describe('When the range spans a committed and an uncommitted line', () => {
    it('Then both are reported with their respective attribution', async () => {
      // Arrange
      const ctx = await seed();
      const c1 = await commitFile(ctx, 'c1', 'f.txt', 'a\nb\nc\nd\n');
      await write(ctx, 'f.txt', 'a\nB\nc\nD\n');

      // Act
      const sut = await blame(ctx, 'f.txt', { worktree: true, range: { start: 2, end: 3 } });

      // Assert
      expect(sut.lines.map((l) => l.finalLine)).toEqual([2, 3]);
      expect(sut.lines[0]).toMatchObject({ committed: false });
      expect(sut.lines[1]).toMatchObject({ committed: true, commit: c1 });
    });
  });
});

describe('Given a worktree blame with an empty working file', () => {
  describe('When blaming it', () => {
    it('Then no lines are reported', async () => {
      // Arrange
      const ctx = await seed();
      await commitFile(ctx, 'c1', 'f.txt', 'a\nb\n');
      await write(ctx, 'f.txt', '');

      // Act
      const sut = await blame(ctx, 'f.txt', { worktree: true });

      // Assert
      expect(sut.lines).toEqual([]);
    });
  });
});

describe('Given a worktree blame on an untracked file', () => {
  describe('When blaming it', () => {
    it('Then it refuses with PATH_NOT_IN_TREE', async () => {
      // Arrange
      const ctx = await seed();
      await commitFile(ctx, 'c1', 'other.txt', 'x\n');
      await write(ctx, 'untracked.txt', 'a\n');

      // Act + Assert
      await expect(blame(ctx, 'untracked.txt', { worktree: true })).rejects.toMatchObject({
        data: { code: 'PATH_NOT_IN_TREE', rev: 'HEAD', path: 'untracked.txt' },
      });
    });
  });
});

describe('Given a worktree blame on a tracked file deleted from disk', () => {
  describe('When blaming it', () => {
    it('Then it refuses with WORKTREE_FILE_ABSENT', async () => {
      // Arrange
      const ctx = await seed();
      await commitFile(ctx, 'c1', 'f.txt', 'a\n');
      await ctx.fs.rm(`${ctx.layout.workDir}/f.txt`);

      // Act + Assert
      await expect(blame(ctx, 'f.txt', { worktree: true })).rejects.toMatchObject({
        data: { code: 'WORKTREE_FILE_ABSENT', path: 'f.txt' },
      });
    });
  });
});

describe('Given a worktree blame on an unborn HEAD', () => {
  describe('When blaming it', () => {
    it('Then it refuses with REF_NOT_FOUND before reading the working file', async () => {
      // Arrange — init only, no commit; a working file present must not mask the refusal
      const ctx = await seed();
      await write(ctx, 'f.txt', 'a\n');

      // Act + Assert
      await expect(blame(ctx, 'f.txt', { worktree: true })).rejects.toMatchObject({
        data: { code: 'REF_NOT_FOUND' },
      });
    });
  });
});

describe('Given a worktree blame on a path that escapes the repository', () => {
  describe('When the path traverses upward', () => {
    it('Then it refuses with PATHSPEC_OUTSIDE_REPO before reading the filesystem', async () => {
      // Arrange
      const ctx = await seed();
      await commitFile(ctx, 'c1', 'f.txt', 'a\n');

      // Act + Assert
      await expect(blame(ctx, '../escape.txt', { worktree: true })).rejects.toMatchObject({
        data: { code: 'PATHSPEC_OUTSIDE_REPO' },
      });
    });
  });

  describe('When the path targets the .git directory', () => {
    it('Then it refuses with PATHSPEC_OUTSIDE_REPO', async () => {
      // Arrange
      const ctx = await seed();
      await commitFile(ctx, 'c1', 'f.txt', 'a\n');

      // Act + Assert
      await expect(blame(ctx, '.git/config', { worktree: true })).rejects.toMatchObject({
        data: { code: 'PATHSPEC_OUTSIDE_REPO' },
      });
    });
  });
});

describe('Given the worktree option combined with an explicit revision', () => {
  describe('When blaming', () => {
    it('Then it refuses the contradictory combination with INVALID_OPTION', async () => {
      // Arrange
      const ctx = await seed();
      await commitFile(ctx, 'c1', 'f.txt', 'a\n');

      // Act + Assert
      await expect(blame(ctx, 'f.txt', { worktree: true, rev: 'HEAD' })).rejects.toMatchObject({
        data: {
          code: 'INVALID_OPTION',
          option: 'worktree',
          reason: 'cannot combine with a revision',
        },
      });
    });
  });
});
