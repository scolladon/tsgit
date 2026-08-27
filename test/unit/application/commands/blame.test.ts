import { describe, expect, it, vi } from 'vitest';
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
import * as historyRewriteMod from '../../../../src/application/commands/internal/history-rewrite.js';
import { mergeRun } from '../../../../src/application/commands/merge.js';
import { mv } from '../../../../src/application/commands/mv.js';
import { createCommit } from '../../../../src/application/primitives/create-commit.js';
import { findTreeEntry } from '../../../../src/application/primitives/internal/resolve-tree-path.js';
import * as readObjectMod from '../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import * as lineDiffMod from '../../../../src/domain/diff/line-diff.js';
import { TsgitError } from '../../../../src/domain/error.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { AuthorIdentity, Blob, ObjectId, Tree } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { refuseReadOnSymlink } from '../primitives/fixtures.js';
import { asBareContext } from './fixtures.js';

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
      const result = await blame(ctx, 'f.txt');

      // Assert
      expect(committedLines(result).map((l) => l.commit)).toEqual([c1, c2, c1, c2]);
      expect(result.lines.map((l) => l.finalLine)).toEqual([1, 2, 3, 4]);
      expect(result.lines.map((l) => text(l.content))).toEqual([
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
      const result = await blame(ctx, 'f.txt');

      // Assert
      expect(committedLines(result)[0]!.boundary).toBe(true);
      expect(result.lines[0]!.previous).toBeUndefined();
      expect(committedLines(result)[1]!.boundary).toBe(false);
      expect(result.lines[1]!.previous).toEqual({ commit: c1, path: 'f.txt' });
    });
  });
});

describe('Given a shallow boundary hand-written mid-chain over a modified file', () => {
  describe('When blaming the file', () => {
    it('Then the boundary commit is a boundary and its real parent is never read', async () => {
      // Arrange — c1 introduces line1; c2 appends line2. Without grafting, line1
      // would blame to c1 (unmodified, passed through). Marking c2 shallow must
      // stop the walk there instead, attributing every surviving line to c2.
      const ctx = await seed();
      await commitFile(ctx, 'c1', 'f.txt', 'line1\n');
      const c2 = await commitFile(ctx, 'c2', 'f.txt', 'line1\nline2\n');
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, `${c2}\n`);

      // Act
      const result = await blame(ctx, 'f.txt');

      // Assert
      expect(committedLines(result).map((l) => l.commit)).toEqual([c2, c2]);
      expect(committedLines(result).every((l) => l.boundary)).toBe(true);
      expect(result.lines.every((l) => l.previous === undefined)).toBe(true);
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
      const result = await blame(ctx, 'f.txt');

      // Assert
      expect(committedLines(result).map((l) => l.commit)).toEqual([c2, c2, c1, c1]);
      expect(result.lines.map((l) => l.finalLine)).toEqual([1, 2, 3, 4]);
      expect(result.lines.map((l) => l.sourceLine)).toEqual([1, 2, 1, 2]);
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
      const result = await blame(ctx, 'f.txt');

      // Assert
      expect(result.lines).toHaveLength(1);
      expect(committedLines(result)[0]!.commit).toBe(c1);
      expect(committedLines(result)[0]!.boundary).toBe(true);
      expect(committedLines(result)[0]!.summary).toBe('c1 subject');
      expect(result.lines[0]!.sourcePath).toBe('f.txt');
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
      const result = await blame(ctx, 'empty.txt');

      // Assert
      expect(result.lines).toEqual([]);
      expect(result.path).toBe('empty.txt');
    });
  });
});

describe('Given a path that cannot resolve to a blob in the tree', () => {
  describe('When blaming it', () => {
    it.each([
      {
        label: 'a path absent from the revision',
        path: 'missing.txt',
        arrange: async (ctx: Context): Promise<{ rev?: ObjectId }> => {
          await commitFile(ctx, 'c1', 'f.txt', 'a\n');
          return {};
        },
      },
      {
        label: 'a path that names a directory',
        path: 'dir',
        arrange: async (ctx: Context): Promise<{ rev?: ObjectId }> => {
          await commitFile(ctx, 'c1', 'dir/a.txt', 'x\n');
          await commitFile(ctx, 'c2', 'dir/b.txt', 'y\n');
          return {};
        },
      },
      {
        label: 'a path that names a gitlink submodule entry',
        path: 'mysub',
        arrange: async (ctx: Context): Promise<{ rev?: ObjectId }> => {
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
          return { rev };
        },
      },
    ])('Then it refuses with PATH_NOT_IN_TREE ($label)', async ({ path, arrange }) => {
      // Arrange
      const ctx = await seed();
      const { rev } = await arrange(ctx);

      // Act + Assert
      try {
        await blame(ctx, path, rev !== undefined ? { rev } : undefined);
        expect.unreachable('blame should refuse the path');
      } catch (error) {
        expect(error).toBeInstanceOf(TsgitError);
        expect((error as TsgitError).data).toMatchObject({
          code: 'PATH_NOT_IN_TREE',
          path,
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
      const result = await blame(ctx, 'f.txt', { rev: c1 });

      // Assert
      expect(committedLines(result).map((l) => l.commit)).toEqual([c1, c1]);
      expect(result.lines.map((l) => text(l.content))).toEqual(['line1\n', 'line2\n']);
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
      const result = await blame(ctx, 'f.txt');

      // Assert
      expect(merged.kind).toBe('merge');
      expect(committedLines(result).map((l) => l.commit)).toEqual([side, c1, main]);
      expect(result.lines.map((l) => text(l.content))).toEqual(['a-side\n', 'b\n', 'c-main\n']);
      expect(committedLines(result)[1]!.boundary).toBe(true);
      const mergeId = merged.kind === 'merge' ? merged.id : undefined;
      expect(committedLines(result).some((l) => l.commit === mergeId)).toBe(false);
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
      const result = await blame(ctx, 'f.txt');

      // Assert
      expect(committedLines(result).map((l) => l.commit)).toEqual([c2, c2]);
      expect(committedLines(result).every((l) => l.boundary)).toBe(false);
      expect(result.lines.every((l) => l.previous === undefined)).toBe(true);
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
      const result = await blame(ctx, 'renamed.txt');

      // Assert
      expect(committedLines(result).map((l) => l.commit)).toEqual([c1, c2]);
      expect(result.lines.map((l) => l.sourcePath)).toEqual(['f.txt', 'f.txt']);
      expect(result.lines.map((l) => l.finalLine)).toEqual([1, 2]);
      expect(committedLines(result).some((l) => l.commit === c3)).toBe(false);
      expect(result.lines[1]!.previous).toEqual({ commit: c1, path: 'f.txt' });
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
      const result = await blame(ctx, 'f.txt');

      // Assert
      expect(committedLines(result).map((l) => l.commit)).toEqual([c2, c2]);
      expect(committedLines(result).some((l) => l.commit === c1)).toBe(false);
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
      const result = await blame(ctx, 'f.txt');

      // Assert
      expect(committedLines(result).map((l) => l.commit)).toEqual([c1, c2, c1]);
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
      const result = await blame(ctx, 'f.txt');

      // Assert
      expect(committedLines(result).map((l) => l.commit)).toEqual([c1, c1, c1]);
      expect(committedLines(result).every((l) => l.boundary)).toBe(true);
    });
  });
});

/**
 * `readObject`/`readRawObject` reads for `id` across both spies — counts
 * logical read/parse attempts regardless of which entry point made them, so
 * the assertion survives the loose-object byte cache underneath (a second
 * `ctx.fs.read` for the same oid can be served from cache, but a second call
 * into either primitive still shows up here).
 */
const objectReadsOf = (
  id: ObjectId,
  readObjectSpy: ReturnType<typeof vi.spyOn>,
  readRawObjectSpy: ReturnType<typeof vi.spyOn>,
): number =>
  [...readObjectSpy.mock.calls, ...readRawObjectSpy.mock.calls].filter(
    ([, calledId]) => calledId === id,
  ).length;

describe("Given a parent whose root tree equals the child's", () => {
  describe('When the parent is resolved', () => {
    it('Then no tree object is read for it', async () => {
      // Arrange — c2 reuses c1's tree verbatim (a message-only child commit),
      // so the per-level oid short-circuit sees the root match with zero reads.
      const ctx = await seed();
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/f.txt`, 'a\nb\n');
      await add(ctx, ['f.txt']);
      clock += 60;
      const c1 = await commit(ctx, {
        message: 'c1 subject',
        author: ident('c1', clock),
        committer: ident('c1', clock),
      });
      clock += 60;
      const c2 = await createCommit(ctx, {
        tree: c1.tree,
        parents: [c1.id],
        author: ident('c2', clock),
        committer: ident('c2', clock),
        message: 'c2 message-only change',
      });
      const readObjectSpy = vi.spyOn(readObjectMod, 'readObject');
      const readRawObjectSpy = vi.spyOn(readObjectMod, 'readRawObject');

      // Act
      await blame(ctx, 'f.txt', { rev: c2 });

      // Assert — the shared tree is read once in total, resolving c2's own
      // path; c1's resolution (the parent) reads it zero additional times.
      expect(objectReadsOf(c1.tree, readObjectSpy, readRawObjectSpy)).toBe(1);
      readObjectSpy.mockRestore();
      readRawObjectSpy.mockRestore();
    });
  });
});

describe("Given a parent that differs from the child only outside the blamed path's first segment", () => {
  describe('When the file is blamed', () => {
    it('Then the descent stops at the first equal level', async () => {
      // Arrange — a/b/c.txt is byte-identical in c1 and c2; only the sibling
      // a/other.txt changes, so the root and a/ differ but a/b/ does not.
      const ctx = await seed();
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a/b/c.txt`, 'x\n');
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a/other.txt`, 'A\n');
      await add(ctx, ['a/b/c.txt', 'a/other.txt']);
      clock += 60;
      await commit(ctx, {
        message: 'c1',
        author: ident('c1', clock),
        committer: ident('c1', clock),
      });
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a/other.txt`, 'B\n');
      await add(ctx, ['a/other.txt']);
      clock += 60;
      const c2 = await commit(ctx, {
        message: 'c2',
        author: ident('c2', clock),
        committer: ident('c2', clock),
      });
      const abEntry = await findTreeEntry(ctx, c2.tree, 'a/b');
      if (abEntry === undefined) throw new Error('test setup: a/b missing from c2');
      const readObjectSpy = vi.spyOn(readObjectMod, 'readObject');
      const readRawObjectSpy = vi.spyOn(readObjectMod, 'readRawObject');

      // Act
      await blame(ctx, 'a/b/c.txt', { rev: c2.id });

      // Assert — a/b/ is read once in total, resolving c2's own path; c1's
      // resolution matches a/b/'s oid at the second level and never reads
      // a/b/'s own content again to look for c.txt inside it.
      expect(objectReadsOf(abEntry.id, readObjectSpy, readRawObjectSpy)).toBe(1);
      readObjectSpy.mockRestore();
      readRawObjectSpy.mockRestore();
    });
  });
});

describe('Given a grandparent that shares a subtree with the parent but the child does not', () => {
  describe('When the file is blamed across three generations', () => {
    it("Then the grandparent's resolution reuses the parent's own accurate chain, matching one level higher than the child's chain would", async () => {
      // Arrange — a/b/c.txt never changes across c0→c1→c2. a/ itself is
      // byte-identical between c0 and c1 (only z.txt differs there), but
      // DIFFERS between c1 and c2 (a/other.txt changes at c2). The suspect
      // scheduled at c1 (a TREESAME hop from c2, matching two levels down at
      // a/b/) must carry c1's OWN root/a-level oids, not c2's stale ones, or
      // resolving c0 (c1's parent) re-descends into a/ a second time to find
      // a match that was already available one level higher.
      const ctx = await seed();
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a/other.txt`, 'same\n');
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a/b/c.txt`, 'x\n');
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/z.txt`, 'Z0\n');
      await add(ctx, ['a/other.txt', 'a/b/c.txt', 'z.txt']);
      clock += 60;
      await commit(ctx, {
        message: 'c0',
        author: ident('c0', clock),
        committer: ident('c0', clock),
      });
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/z.txt`, 'Z1\n');
      await add(ctx, ['z.txt']);
      clock += 60;
      const c1 = await commit(ctx, {
        message: 'c1',
        author: ident('c1', clock),
        committer: ident('c1', clock),
      });
      const c1aEntry = await findTreeEntry(ctx, c1.tree, 'a');
      if (c1aEntry === undefined) throw new Error('test setup: a missing from c1');
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a/other.txt`, 'different\n');
      await add(ctx, ['a/other.txt']);
      clock += 60;
      const c2 = await commit(ctx, {
        message: 'c2',
        author: ident('c2', clock),
        committer: ident('c2', clock),
      });
      const readObjectSpy = vi.spyOn(readObjectMod, 'readObject');
      const readRawObjectSpy = vi.spyOn(readObjectMod, 'readRawObject');

      // Act
      await blame(ctx, 'a/b/c.txt', { rev: c2.id });

      // Assert — a/'s shared oid (identical in c0 and c1) is read as an
      // object exactly once (resolving c1 against c2, where a/ genuinely
      // differs and a real descent into a/ is required); resolving c0
      // against c1's stored chain matches it at the entry level instead of
      // reading it again to redescend.
      expect(objectReadsOf(c1aEntry.id, readObjectSpy, readRawObjectSpy)).toBe(1);
      readObjectSpy.mockRestore();
      readRawObjectSpy.mockRestore();
    });
  });
});

describe('Given a suspect whose blob is unchanged across three generations', () => {
  describe('When the file is blamed', () => {
    it('Then the blob is split once', async () => {
      // Arrange — c1 introduces f.txt; c2, c3, c4 touch only other.txt, so
      // f.txt is TREESAME at every hop walking back from c4 to c1.
      const ctx = await seed();
      await commitFile(ctx, 'c1', 'f.txt', 'a\nb\n');
      await commitFile(ctx, 'c2', 'other.txt', '1\n');
      await commitFile(ctx, 'c3', 'other.txt', '2\n');
      const c4 = await commitFile(ctx, 'c4', 'other.txt', '3\n');
      const splitLinesSpy = vi.spyOn(lineDiffMod, 'splitLines');

      // Act
      await blame(ctx, 'f.txt', { rev: c4 });

      // Assert
      expect(splitLinesSpy).toHaveBeenCalledTimes(1);
      splitLinesSpy.mockRestore();
    });
  });
});

describe('Given a two-commit history where the parent hop actually changes the file', () => {
  describe('When the file is blamed', () => {
    it('Then the changed-parent hop diffs via diffPresplitLines, passing the carried suspect.lines as theirsLines unchanged', async () => {
      // Arrange — c1 introduces f.txt, c2 modifies it: the c1 hop diffs c1's
      // freshly-split blob against c2's ALREADY-split suspect.lines, by
      // reference, rather than handing diffLines raw bytes to re-split.
      const ctx = await seed();
      await commitFile(ctx, 'c1', 'f.txt', 'a\nb\n');
      const c2 = await commitFile(ctx, 'c2', 'f.txt', 'a\nb-mod\n');
      const diffLinesSpy = vi.spyOn(lineDiffMod, 'diffLines');
      const diffPresplitLinesSpy = vi.spyOn(lineDiffMod, 'diffPresplitLines');

      // Act
      await blame(ctx, 'f.txt', { rev: c2 });

      // Assert
      expect(diffLinesSpy).not.toHaveBeenCalled();
      expect(diffPresplitLinesSpy).toHaveBeenCalledTimes(1);
      const [oursLines, theirsLines] = diffPresplitLinesSpy.mock.calls[0]!;
      expect(theirsLines).toEqual(lineDiffMod.splitLines(new TextEncoder().encode('a\nb-mod\n')));
      expect(oursLines).toEqual(lineDiffMod.splitLines(new TextEncoder().encode('a\nb\n')));
      diffLinesSpy.mockRestore();
      diffPresplitLinesSpy.mockRestore();
    });
  });
});

describe('Given a merge commit with two parents', () => {
  describe('When the merge tip is blamed', () => {
    it('Then each parent commit object is read once', async () => {
      // Arrange — side changes line 1, main changes line 3, line 2 untouched:
      // both parents receive passed entries and are later processed as
      // suspects in their own right.
      const ctx = await seed();
      await commitFile(ctx, 'c1', 'f.txt', 'a\nb\nc\n');
      await branchCreate(ctx, { name: 'side' });
      await checkout(ctx, { rev: 'side' });
      const side = await commitFile(ctx, 'side', 'f.txt', 'a-side\nb\nc\n');
      await checkout(ctx, { rev: 'main' });
      const main = await commitFile(ctx, 'main', 'f.txt', 'a\nb\nc-main\n');
      clock += 60;
      await mergeRun(ctx, {
        rev: 'side',
        author: ident('merger', clock),
        committer: ident('merger', clock),
      });
      const readCommitDataSpy = vi.spyOn(historyRewriteMod, 'readCommitData');

      // Act
      await blame(ctx, 'f.txt');

      // Assert — each parent's own commit object is read once (by whichever
      // resolution first discovers it), never re-read when it pops as a suspect.
      const readsOf = (id: ObjectId): number =>
        readCommitDataSpy.mock.calls.filter(([, calledId]) => calledId === id).length;
      expect(readsOf(side)).toBe(1);
      expect(readsOf(main)).toBe(1);
      readCommitDataSpy.mockRestore();
    });
  });
});

describe('Given a symlink at the blamed path', () => {
  describe('When the file is blamed across a commit that changes its target', () => {
    it('Then its target string is blamed as content', async () => {
      // Arrange
      const ctx = await seed();
      await ctx.fs.symlink('target-v1', `${ctx.layout.workDir}/link`);
      await add(ctx, ['link']);
      clock += 60;
      await commit(ctx, {
        message: 'c1',
        author: ident('c1', clock),
        committer: ident('c1', clock),
      });
      await ctx.fs.rm(`${ctx.layout.workDir}/link`);
      await ctx.fs.symlink('target-v2', `${ctx.layout.workDir}/link`);
      await add(ctx, ['link']);
      clock += 60;
      const c2 = await commit(ctx, {
        message: 'c2',
        author: ident('c2', clock),
        committer: ident('c2', clock),
      });

      // Act
      const result = await blame(ctx, 'link');

      // Assert
      expect(committedLines(result).map((l) => l.commit)).toEqual([c2.id]);
      expect(text(result.lines[0]!.content)).toBe('target-v2');
    });
  });
});

describe('Given a gitlink at the blamed path in an ancestor commit', () => {
  describe('When a descendant replaces it with a regular file of the same name', () => {
    it('Then the gitlink ancestor is treated as absent, not blamed through', async () => {
      // Arrange
      const ctx = await seed();
      const base = await commitFile(ctx, 'base', 'keep.txt', 'x\n');
      const gitlinkTreeId = await writeObject(ctx, {
        type: 'tree',
        id: '' as ObjectId,
        entries: [{ mode: FILE_MODE.GITLINK, name: 'mysub', id: base }],
      } as Tree);
      clock += 60;
      const c1 = await createCommit(ctx, {
        tree: gitlinkTreeId,
        parents: [base],
        author: ident('c1', clock),
        committer: ident('c1', clock),
        message: 'c1 gitlink',
      });
      const blobId = await writeObject(ctx, {
        type: 'blob',
        id: '' as ObjectId,
        content: new TextEncoder().encode('real content\n'),
      } as Blob);
      const regularTreeId = await writeObject(ctx, {
        type: 'tree',
        id: '' as ObjectId,
        entries: [{ mode: FILE_MODE.REGULAR, name: 'mysub', id: blobId }],
      } as Tree);
      clock += 60;
      const c2 = await createCommit(ctx, {
        tree: regularTreeId,
        parents: [c1],
        author: ident('c2', clock),
        committer: ident('c2', clock),
        message: 'c2 replaces gitlink with a file',
      });

      // Act
      const result = await blame(ctx, 'mysub', { rev: c2 });

      // Assert — 'mysub' is treated as freshly introduced at c2, never
      // blamed through the gitlink ancestor.
      expect(committedLines(result).map((l) => l.commit)).toEqual([c2]);
      expect(committedLines(result)[0]!.boundary).toBe(false);
      expect(result.lines[0]!.previous).toBeUndefined();
    });
  });
});

describe('Given a commit whose `tree` field points at a non-tree object', () => {
  describe('When blaming a path as of that revision', () => {
    it('Then refuses with UNEXPECTED_OBJECT_TYPE rather than degrading to a path-not-found', async () => {
      // Arrange — the root of the descent shares the same raw byte-scan as
      // every other level (Part 10's consolidation); it must still assert
      // the root is actually a tree, the way `readTree`'s own peel-chain
      // does, instead of silently returning "not found" for the whole file.
      const ctx = await seed();
      const blobId = await writeObject(ctx, {
        type: 'blob',
        id: '' as ObjectId,
        content: new TextEncoder().encode('not a tree'),
      } as Blob);
      clock += 60;
      const corrupt = await createCommit(ctx, {
        tree: blobId,
        parents: [],
        author: ident('corrupt', clock),
        committer: ident('corrupt', clock),
        message: 'commit with a corrupt tree field',
      });

      // Act / Assert
      try {
        await blame(ctx, 'f.txt', { rev: corrupt });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(TsgitError);
        const data = (error as TsgitError).data;
        expect(data.code).toBe('UNEXPECTED_OBJECT_TYPE');
        if (data.code === 'UNEXPECTED_OBJECT_TYPE') {
          expect(data.expected).toBe('tree');
          expect(data.actual).toBe('blob');
          expect(data.id).toBe(blobId);
        }
      }
    });
  });
});

describe('Given a blamed line living inside an otherwise-large blob', () => {
  describe('When the file is blamed', () => {
    it("Then a finalized line's content does not retain the whole inflated blob buffer", async () => {
      // Arrange — one real line, padded with many throwaway lines so the
      // blob is large; only the first line survives to be blamed.
      const ctx = await seed();
      const padding = Array.from({ length: 500 }, (_, i) => `pad${i}\n`).join('');
      await commitFile(ctx, 'c1', 'f.txt', `real\n${padding}`);

      // Act
      const result = await blame(ctx, 'f.txt');
      const content = result.lines[0]!.content;

      // Assert — a copy's own backing buffer is exactly its own length; a
      // subarray view into the original (much larger) blob would report the
      // blob's full byte length instead.
      expect(content.buffer.byteLength).toBe(content.byteLength);
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
      const result = await blame(ctx, 'dir/b.txt');

      // Assert
      expect(committedLines(result).map((l) => l.commit)).toEqual([c1, c1]);
      expect(result.lines.map((l) => l.sourcePath)).toEqual(['dir/a.txt', 'dir/a.txt']);
      expect(committedLines(result).some((l) => l.commit === c2)).toBe(false);
    });
  });
});

describe('Given a rename whose source path is unchanged across a further ancestor', () => {
  describe('When blaming past the rename to that ancestor', () => {
    it("Then the line still blames to the root commit — the rename hop's chain is usable for a further short-circuit", async () => {
      // Arrange — c0 introduces dir/a.txt and other.txt; c1 touches only
      // other.txt (dir/ untouched, so dir/'s oid is identical in c0 and c1);
      // c2 renames dir/a.txt to dir/b.txt with no content change. Blaming
      // dir/b.txt from c2 must follow the rename to dir/a.txt, then keep
      // walking past c1 (TREESAME on dir/) all the way to c0.
      const ctx = await seed();
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/dir/a.txt`, 'x\n');
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/other.txt`, '0\n');
      await add(ctx, ['dir/a.txt', 'other.txt']);
      clock += 60;
      const c0 = (
        await commit(ctx, {
          message: 'c0',
          author: ident('c0', clock),
          committer: ident('c0', clock),
        })
      ).id;
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/other.txt`, '1\n');
      await add(ctx, ['other.txt']);
      clock += 60;
      await commit(ctx, {
        message: 'c1',
        author: ident('c1', clock),
        committer: ident('c1', clock),
      });
      await mv(ctx, ['dir/a.txt'], 'dir/b.txt');
      clock += 60;
      await commit(ctx, {
        message: 'c2',
        author: ident('c2', clock),
        committer: ident('c2', clock),
      });

      // Act
      const result = await blame(ctx, 'dir/b.txt');

      // Assert
      expect(committedLines(result).map((l) => l.commit)).toEqual([c0]);
      expect(committedLines(result)[0]!.boundary).toBe(true);
      expect(result.lines[0]!.sourcePath).toBe('dir/a.txt');
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
      const result = await blame(ctx, 'f.txt', { range: { start: 2, end: 2 } });

      // Assert
      expect(result.lines.map((l) => l.finalLine)).toEqual([2]);
      expect(committedLines(result)[0]!.commit).toBe(c2);
    });

    it('Then a multi-line range keeps each line on its own commit', async () => {
      // Arrange
      const { ctx, c1, c2 } = await buildThreeLineFile();

      // Act
      const result = await blame(ctx, 'f.txt', { range: { start: 1, end: 2 } });

      // Assert
      expect(result.lines.map((l) => l.finalLine)).toEqual([1, 2]);
      expect(committedLines(result).map((l) => l.commit)).toEqual([c1, c2]);
    });

    it('Then an end past the last line is clamped to the file length', async () => {
      // Arrange
      const { ctx } = await buildThreeLineFile();

      // Act
      const result = await blame(ctx, 'f.txt', { range: { start: 2, end: 100 } });

      // Assert
      expect(result.lines.map((l) => l.finalLine)).toEqual([2, 3]);
    });
  });

  describe('When the range is invalid', () => {
    it.each([
      {
        label: 'an inverted range',
        range: { start: 3, end: 1 },
        reason: 'range end 1 precedes start 3',
      },
      {
        label: 'a start below 1',
        range: { start: 0, end: 2 },
        reason: 'invalid line number: 0',
      },
      {
        label: 'a start past the last line',
        range: { start: 10, end: 12 },
        reason: 'file has only 3 lines',
      },
      {
        label: 'a non-integer bound',
        range: { start: 1.5, end: 2 },
        reason: 'line numbers must be integers',
      },
    ])('Then it refuses with INVALID_OPTION ($label)', async ({ range, reason }) => {
      // Arrange
      const { ctx } = await buildThreeLineFile();

      // Act + Assert
      await expect(blame(ctx, 'f.txt', { range })).rejects.toMatchObject({
        data: { code: 'INVALID_OPTION', option: '-L', reason },
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
      const result = await blame(ctx, 'f.txt', { worktree: true });

      // Assert
      expect(result).toEqual(await blame(ctx, 'f.txt'));
      expect(result.lines.every((l) => l.committed)).toBe(true);
    });
  });
});

describe('Given a bare repository (no work tree)', () => {
  describe('When blaming with the worktree option', () => {
    it('Then it blames HEAD instead of refusing', async () => {
      // Arrange
      const seeded = await seed();
      await commitFile(seeded, 'c1', 'f.txt', 'a\nb\n');
      const ctx = asBareContext(seeded);

      // Act
      const result = await blame(ctx, 'f.txt', { worktree: true });

      // Assert — identical to blaming HEAD directly; no work tree was consulted.
      expect(result).toEqual(await blame(ctx, 'f.txt'));
      expect(result.lines.every((l) => l.committed)).toBe(true);
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
      const result = await blame(ctx, 'f.txt', { worktree: true });

      // Assert
      expect(result.lines.map((l) => l.committed)).toEqual([true, false, true]);
      expect(result.lines.map((l) => l.finalLine)).toEqual([1, 2, 3]);
      expect(result.lines[0]).toMatchObject({ committed: true, commit: c1 });
      expect(result.lines[2]).toMatchObject({ committed: true, commit: c1 });
      const changed = result.lines[1]!;
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
      const result = await blame(ctx, 'f.txt', { worktree: true });

      // Assert
      expect(result.lines.map((l) => l.committed)).toEqual([true, true, false]);
      const appended = result.lines[2]!;
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
      const result = await blame(ctx, 'new.txt', { worktree: true });

      // Assert
      expect(result.lines.map((l) => l.committed)).toEqual([false, false]);
      expect(result.lines.map((l) => l.finalLine)).toEqual([1, 2]);
      expect(result.lines.map((l) => l.sourceLine)).toEqual([1, 2]);
      expect(result.lines.every((l) => l.previous === undefined)).toBe(true);
      expect(result.lines.map((l) => text(l.content))).toEqual(['p\n', 'q\n']);
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
      const result = await blame(ctx, 'link', { worktree: true });

      // Assert — a symlink's content is its target string (no trailing newline)
      expect(result.lines.map((l) => l.committed)).toEqual([false]);
      expect(text(result.lines[0]!.content)).toBe('new/target');
    });
  });
});

describe('Given a committed symlink whose target changed in the worktree (no-dereference audit)', () => {
  describe('When blaming the worktree, and ctx.fs.read is wired to fail on the symlink path', () => {
    it('Then it never dereferences the link', async () => {
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
      const guarded = refuseReadOnSymlink(ctx, `${ctx.layout.workDir}/link`);

      // Act
      const result = await blame(guarded, 'link', { worktree: true });

      // Assert — a symlink's content is its target string (no trailing newline)
      expect(result.lines.map((l) => l.committed)).toEqual([false]);
      expect(text(result.lines[0]!.content)).toBe('new/target');
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
      const result = await blame(ctx, 'f.txt', { worktree: true, range: { start: 2, end: 3 } });

      // Assert
      expect(result.lines.map((l) => l.finalLine)).toEqual([2, 3]);
      expect(result.lines[0]).toMatchObject({ committed: false });
      expect(result.lines[1]).toMatchObject({ committed: true, commit: c1 });
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
      const result = await blame(ctx, 'f.txt', { worktree: true });

      // Assert
      expect(result.lines).toEqual([]);
    });
  });
});

describe('Given a worktree blame that cannot resolve the path', () => {
  describe('When blaming with the worktree option', () => {
    it.each([
      {
        label: 'an untracked file',
        arrange: async (ctx: Context): Promise<void> => {
          await commitFile(ctx, 'c1', 'other.txt', 'x\n');
          await write(ctx, 'untracked.txt', 'a\n');
        },
        path: 'untracked.txt',
        expected: { code: 'PATH_NOT_IN_TREE', rev: 'HEAD', path: 'untracked.txt' },
      },
      {
        label: 'a tracked file deleted from disk',
        arrange: async (ctx: Context): Promise<void> => {
          await commitFile(ctx, 'c1', 'f.txt', 'a\n');
          await ctx.fs.rm(`${ctx.layout.workDir}/f.txt`);
        },
        path: 'f.txt',
        expected: { code: 'WORKTREE_FILE_ABSENT', path: 'f.txt' },
      },
      {
        // An unborn HEAD: a working file present must not mask the refusal.
        label: 'an unborn HEAD (a working file is present but there is no commit yet)',
        arrange: async (ctx: Context): Promise<void> => {
          await write(ctx, 'f.txt', 'a\n');
        },
        path: 'f.txt',
        expected: { code: 'REF_NOT_FOUND' },
      },
    ])('Then it refuses ($label)', async ({ arrange, path, expected }) => {
      // Arrange
      const ctx = await seed();
      await arrange(ctx);

      // Act + Assert
      await expect(blame(ctx, path, { worktree: true })).rejects.toMatchObject({
        data: expected,
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

describe('Given a bare repository holding a committed file', () => {
  describe('When blaming the file with no options', () => {
    it('Then it resolves against HEAD instead of refusing', async () => {
      // Arrange
      const seeded = await seed();
      const c1 = await commitFile(seeded, 'c1', 'f.txt', 'line1\n');
      const ctx = asBareContext(seeded);

      // Act
      const result = await blame(ctx, 'f.txt');

      // Assert
      const lines = committedLines(result);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.commit).toBe(c1);
    });
  });
});

describe('Given a worktree-less repository that is NOT bare', () => {
  describe('When blaming with the worktree option', () => {
    it('Then throws WORK_TREE_REQUIRED naming the blame operation', async () => {
      // Arrange — bare stays false so the HEAD-seeding bare branch cannot
      // absorb the call; only the work-tree gate can be the cause.
      const seeded = await seed();
      await commitFile(seeded, 'c1', 'f.txt', 'line1\n');
      const { workDir: _workDir, ...worktreeLess } = seeded.layout;
      const ctx: Context = { ...seeded, layout: { ...worktreeLess, bare: false } };

      // Act
      let caught: unknown;
      try {
        await blame(ctx, 'f.txt', { worktree: true });
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data).toMatchObject({
        code: 'WORK_TREE_REQUIRED',
        operation: 'blame',
      });
    });
  });
});
