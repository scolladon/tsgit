import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import type { ArchiveEntry } from '../../../../src/application/commands/archive.js';
import { archive } from '../../../../src/application/commands/archive.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { TsgitError } from '../../../../src/domain/error.js';
import { FILE_MODE, type ObjectId, type TreeEntry } from '../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
import type { Context } from '../../../../src/ports/context.js';
import { buildTreeChain, instrumentedContext, seedMaxTreeDepth } from '../primitives/fixtures.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

const makeBlob = (content: string) => ({
  type: 'blob' as const,
  id: '' as ObjectId,
  content: enc.encode(content),
});

const makeTree = (entries: ReadonlyArray<TreeEntry>) => ({
  type: 'tree' as const,
  id: '' as ObjectId,
  entries: [...entries],
});

const COMMITTER_TIMESTAMP = 1_700_000_000;

const makeCommit = (tree: ObjectId, parents: ReadonlyArray<ObjectId> = []) => ({
  type: 'commit' as const,
  id: '' as ObjectId,
  data: {
    tree,
    parents: [...parents],
    author: {
      name: 'Ada',
      email: 'ada@example.com',
      timestamp: COMMITTER_TIMESTAMP,
      timezoneOffset: '+0000',
    },
    committer: {
      name: 'Ada',
      email: 'ada@example.com',
      timestamp: COMMITTER_TIMESTAMP,
      timezoneOffset: '+0000',
    },
    message: 'commit',
    extraHeaders: [],
  },
});

const makeTag = (object: ObjectId, tagName: string) => ({
  type: 'tag' as const,
  id: '' as ObjectId,
  data: {
    object,
    objectType: 'commit' as const,
    tagName,
    message: 'annotated tag',
    extraHeaders: [],
  },
});

/** Minimal repo context: HEAD exists, no commit yet (unborn). */
const initUnbornCtx = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  return ctx;
};

/** Seed a repo with one commit, return ctx + commitId. */
const seedOneCommit = async (
  entries: ReadonlyArray<TreeEntry> = [],
): Promise<{ ctx: Context; commitId: ObjectId; treeId: ObjectId }> => {
  const ctx = await initUnbornCtx();
  const treeId = await writeObject(ctx, makeTree(entries));
  const commitId = await writeObject(ctx, makeCommit(treeId));
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);
  return { ctx, commitId, treeId };
};

// ---------------------------------------------------------------------------
// R1 — NOT_A_REPOSITORY
// ---------------------------------------------------------------------------

describe('Given a context without a HEAD file (not a repository)', () => {
  describe('When archive is called', () => {
    it('Then throws NOT_A_REPOSITORY', async () => {
      // Arrange
      const ctx = createMemoryContext();

      // Act
      let caught: unknown;
      try {
        await archive(ctx, { treeish: 'HEAD' });
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('NOT_A_REPOSITORY');
    });
  });
});

// ---------------------------------------------------------------------------
// R2 — unborn HEAD (revParse cannot resolve)
// ---------------------------------------------------------------------------

describe('Given a repository with an unborn HEAD (no commits yet)', () => {
  describe('When archive is called with treeish HEAD', () => {
    it('Then throws OBJECT_NOT_FOUND (revParse cannot resolve unborn HEAD)', async () => {
      // Arrange
      const ctx = await initUnbornCtx();

      // Act
      let caught: unknown;
      try {
        await archive(ctx, { treeish: 'HEAD' });
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
    });
  });
});

// ---------------------------------------------------------------------------
// R3 — unresolvable rev
// ---------------------------------------------------------------------------

describe('Given a repository with a valid commit', () => {
  describe('When archive is called with a garbage treeish', () => {
    it('Then throws OBJECT_NOT_FOUND', async () => {
      // Arrange
      const { ctx } = await seedOneCommit();

      // Act
      let caught: unknown;
      try {
        await archive(ctx, { treeish: 'no-such-ref-at-all' });
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
    });
  });
});

// ---------------------------------------------------------------------------
// R4 — blob treeish (ISOLATED test)
// ---------------------------------------------------------------------------

describe('Given a treeish that resolves to a blob (not a tree)', () => {
  describe('When archive is called', () => {
    it('Then throws UNEXPECTED_OBJECT_TYPE with expected=tree actual=blob', async () => {
      // Arrange
      const { ctx } = await seedOneCommit();
      const blobId = await writeObject(ctx, makeBlob('some content'));

      // Act
      let caught: unknown;
      try {
        await archive(ctx, { treeish: blobId });
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data;
      expect(data.code).toBe('UNEXPECTED_OBJECT_TYPE');
      if (data.code === 'UNEXPECTED_OBJECT_TYPE') {
        expect(data.expected).toBe('tree');
        expect(data.actual).toBe('blob');
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Commit-ish — commit + commitTime present
// ---------------------------------------------------------------------------

describe('Given a repository with a single commit', () => {
  describe('When archive is called with treeish HEAD (commit-ish)', () => {
    it('Then result.commit equals the commit oid and result.commitTime equals committer timestamp', async () => {
      // Arrange
      const { ctx, commitId, treeId } = await seedOneCommit();

      // Act
      const result = await archive(ctx, { treeish: 'HEAD' });

      // Assert
      expect(result.commit).toBe(commitId);
      expect(result.commitTime).toBe(COMMITTER_TIMESTAMP);
      expect(result.tree).toBe(treeId);
    });
  });
});

// ---------------------------------------------------------------------------
// Bare tree treeish — commit + commitTime absent
// ---------------------------------------------------------------------------

describe('Given a repository with a commit', () => {
  describe('When archive is called with treeish being the raw tree oid', () => {
    it('Then result.commit and result.commitTime are undefined', async () => {
      // Arrange
      const { ctx, treeId } = await seedOneCommit();

      // Act
      const result = await archive(ctx, { treeish: treeId });

      // Assert
      expect(result.commit).toBeUndefined();
      expect(result.commitTime).toBeUndefined();
      expect(result.tree).toBe(treeId);
    });
  });
});

// ---------------------------------------------------------------------------
// Annotated tag — peeled commit
// ---------------------------------------------------------------------------

describe('Given a repository with an annotated tag pointing at a commit', () => {
  describe('When archive is called with the tag name', () => {
    it('Then result.commit is the peeled commit oid and result.commitTime is its committer timestamp', async () => {
      // Arrange
      const { ctx, commitId, treeId } = await seedOneCommit();
      const tagId = await writeObject(ctx, makeTag(commitId, 'v1.0'));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/tags/v1.0`, `${tagId}\n`);

      // Act
      const result = await archive(ctx, { treeish: 'v1.0' });

      // Assert
      expect(result.commit).toBe(commitId);
      expect(result.commitTime).toBe(COMMITTER_TIMESTAMP);
      expect(result.tree).toBe(treeId);
    });
  });
});

// ---------------------------------------------------------------------------
// Empty tree — empty stream
// ---------------------------------------------------------------------------

describe('Given a commit with an empty tree', () => {
  describe('When archive iterates entries', () => {
    it('Then the entries stream is empty', async () => {
      // Arrange
      const { ctx } = await seedOneCommit([]);

      // Act
      const result = await archive(ctx, { treeish: 'HEAD' });
      const entries: ArchiveEntry[] = [];
      for await (const entry of result.entries) {
        entries.push(entry);
      }

      // Assert
      expect(entries).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Mixed tree — paths, modes, oids, content, pre-order
// ---------------------------------------------------------------------------

describe('Given a commit with a mixed tree (regular, exec, symlink, dir with content, gitlink)', () => {
  describe('When archive iterates entries', () => {
    it('Then entries are yielded pre-order with correct paths, raw modes, oids, and content', async () => {
      // Arrange
      const ctx = await initUnbornCtx();

      const regularContent = enc.encode('hello\n');
      const execContent = enc.encode('#!/bin/sh\necho hi\n');
      const symlinkTarget = enc.encode('../other.txt');
      const nestedContent = enc.encode('nested\n');

      const regularId = await writeObject(ctx, {
        type: 'blob',
        id: '' as ObjectId,
        content: regularContent,
      });
      const execId = await writeObject(ctx, {
        type: 'blob',
        id: '' as ObjectId,
        content: execContent,
      });
      const symlinkId = await writeObject(ctx, {
        type: 'blob',
        id: '' as ObjectId,
        content: symlinkTarget,
      });
      const nestedBlobId = await writeObject(ctx, {
        type: 'blob',
        id: '' as ObjectId,
        content: nestedContent,
      });
      const submoduleOid = '1234567890abcdef1234567890abcdef12345678' as ObjectId;

      const dirTreeId = await writeObject(
        ctx,
        makeTree([treeEntry(FILE_MODE.REGULAR, 'nested.txt', nestedBlobId)]),
      );
      const rootTreeId = await writeObject(
        ctx,
        makeTree([
          treeEntry(FILE_MODE.REGULAR, 'a.txt', regularId),
          treeEntry(FILE_MODE.GITLINK, 'mysub', submoduleOid),
          treeEntry(FILE_MODE.DIRECTORY, 'dir', dirTreeId),
          treeEntry(FILE_MODE.EXECUTABLE, 'run.sh', execId),
          treeEntry(FILE_MODE.SYMLINK, 'link', symlinkId),
        ]),
      );
      const commitId = await writeObject(ctx, makeCommit(rootTreeId));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act
      const result = await archive(ctx, { treeish: 'HEAD' });
      const entries: ArchiveEntry[] = [];
      for await (const entry of result.entries) {
        entries.push(entry);
      }

      // Assert — paths (git canonical sort order, pre-order: dir before its contents)
      // git canonical tree sort: 'a.txt' < 'dir/' < 'link' < 'mysub' < 'run.sh'
      // But git uses strcmp on the raw name (treating directories as name+'/').
      // The order depends on how git sorts: 'a.txt' < 'dir/' < 'link' < 'mysub' < 'run.sh'.
      // However, gitlink 'mysub' sorts as 'mysub/' when comparing, so order may vary.
      // Test by path presence and mode correctness rather than exact order for flexibility.
      const byPath = (path: string) => entries.find((e) => e.path === path);

      // Regular file
      expect(byPath('a.txt')).toMatchObject({ mode: FILE_MODE.REGULAR, oid: regularId });
      expect(byPath('a.txt')?.content).toEqual(regularContent);

      // Executable file
      expect(byPath('run.sh')).toMatchObject({ mode: FILE_MODE.EXECUTABLE, oid: execId });
      expect(byPath('run.sh')?.content).toEqual(execContent);

      // Symlink — content is link target bytes
      expect(byPath('link')).toMatchObject({ mode: FILE_MODE.SYMLINK, oid: symlinkId });
      expect(byPath('link')?.content).toEqual(symlinkTarget);

      // Directory entry — no content
      expect(byPath('dir')).toMatchObject({ mode: FILE_MODE.DIRECTORY, oid: dirTreeId });
      expect(byPath('dir')?.content).toBeUndefined();

      // Nested file under dir — pre-order: dir entry appears before dir/nested.txt
      expect(byPath('dir/nested.txt')).toMatchObject({
        mode: FILE_MODE.REGULAR,
        oid: nestedBlobId,
      });
      expect(byPath('dir/nested.txt')?.content).toEqual(nestedContent);

      // Gitlink — no content
      expect(byPath('mysub')).toMatchObject({ mode: FILE_MODE.GITLINK, oid: submoduleOid });
      expect(byPath('mysub')?.content).toBeUndefined();

      // Pre-order: 'dir' entry appears before 'dir/nested.txt'
      const dirIdx = entries.findIndex((e) => e.path === 'dir');
      const nestedIdx = entries.findIndex((e) => e.path === 'dir/nested.txt');
      expect(dirIdx).toBeLessThan(nestedIdx);
    });
  });
});

// ---------------------------------------------------------------------------
// Directory and gitlink entries must NOT have content
// ---------------------------------------------------------------------------

describe('Given a tree with a directory and a gitlink entry', () => {
  describe('When archive iterates entries', () => {
    it('Then directory and gitlink entries have no content field', async () => {
      // Arrange
      const ctx = await initUnbornCtx();
      const submoduleOid = 'aabbccdd11223344aabbccdd11223344aabbccdd' as ObjectId;
      const innerTreeId = await writeObject(ctx, makeTree([]));
      const rootTreeId = await writeObject(
        ctx,
        makeTree([
          treeEntry(FILE_MODE.DIRECTORY, 'emptydir', innerTreeId),
          treeEntry(FILE_MODE.GITLINK, 'sub', submoduleOid),
        ]),
      );
      const commitId = await writeObject(ctx, makeCommit(rootTreeId));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act
      const result = await archive(ctx, { treeish: 'HEAD' });
      const entries: ArchiveEntry[] = [];
      for await (const entry of result.entries) {
        entries.push(entry);
      }

      // Assert
      const dirEntry = entries.find((e) => e.path === 'emptydir');
      const subEntry = entries.find((e) => e.path === 'sub');
      expect(dirEntry).toBeDefined();
      expect(dirEntry?.content).toBeUndefined();
      expect(subEntry).toBeDefined();
      expect(subEntry?.content).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Laziness probe — blob reads happen only during iteration
// ---------------------------------------------------------------------------

describe('Given a commit with 3 blob entries', () => {
  describe('When archive is called but entries are not yet iterated', () => {
    it('Then blob content reads are deferred and happen only as entries are iterated', async () => {
      // Arrange
      const base = await initUnbornCtx();
      const blobAId = await writeObject(base, makeBlob('content-a'));
      const blobBId = await writeObject(base, makeBlob('content-b'));
      const blobCId = await writeObject(base, makeBlob('content-c'));
      const treeId = await writeObject(
        base,
        makeTree([
          treeEntry(FILE_MODE.REGULAR, 'a.txt', blobAId),
          treeEntry(FILE_MODE.REGULAR, 'b.txt', blobBId),
          treeEntry(FILE_MODE.REGULAR, 'c.txt', blobCId),
        ]),
      );
      const commitId = await writeObject(base, makeCommit(treeId));
      await base.fs.writeUtf8(`${base.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      const { ctx, calls } = instrumentedContext(base);

      // Loose objects are stored at .git/objects/<2>/<38>; check for the 38-char suffix
      const wasRead = (id: ObjectId) =>
        calls().some((c) => c.method === 'read' && c.path.endsWith(id.slice(2)));

      // Act — call archive without iterating any entries
      const result = await archive(ctx, { treeish: 'HEAD' });

      // Assert — blob content has NOT been read at archive-call time
      expect(wasRead(blobAId)).toBe(false);
      expect(wasRead(blobBId)).toBe(false);
      expect(wasRead(blobCId)).toBe(false);

      // Act — iterate exactly the first entry
      const iter = result.entries[Symbol.asyncIterator]();
      await iter.next();

      // Assert — only the first blob was read; second and third remain unread
      expect(wasRead(blobAId)).toBe(true);
      expect(wasRead(blobBId)).toBe(false);
      expect(wasRead(blobCId)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Eager config gate — archive now takes assertOperationalRepository
// ---------------------------------------------------------------------------

describe('Given a repository whose config holds an invalid core.maxTreeDepth', () => {
  describe('When archive is called', () => {
    it('Then throws CONFIG_BAD_NUMERIC_VALUE with reason invalid unit', async () => {
      // Arrange
      const ctx = await initUnbornCtx();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tmaxTreeDepth = 2.5\n');

      // Act
      let caught: unknown;
      try {
        await archive(ctx, { treeish: 'HEAD' });
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data as {
        readonly code: string;
        readonly key: string;
        readonly value: string;
        readonly reason: string;
      };
      expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
      expect(data.key).toBe('core.maxtreedepth');
      expect(data.value).toBe('2.5');
      expect(data.reason).toBe('invalid unit');
    });
  });
});

// ---------------------------------------------------------------------------
// Depth cap — archive no longer overrides walkTree's own maxDepth, so it
// inherits core.maxTreeDepth exactly like every other walkTree caller.
// ---------------------------------------------------------------------------

describe('Given core.maxTreeDepth configured to a small cap and a tree chain exactly at the cap', () => {
  describe('When archive iterates all entries', () => {
    it('Then no TREE_DEPTH_EXCEEDED is thrown (boundary)', async () => {
      // Arrange
      const SMALL_CAP = 4;
      const ctx = await initUnbornCtx();
      await seedMaxTreeDepth(ctx, String(SMALL_CAP));
      const treeId = await buildTreeChain(ctx, SMALL_CAP);
      const commitId = await writeObject(ctx, makeCommit(treeId));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act — drain the full entry stream
      const result = await archive(ctx, { treeish: 'HEAD' });
      const entries: ArchiveEntry[] = [];
      for await (const entry of result.entries) {
        entries.push(entry);
      }

      // Assert — SMALL_CAP directory entries + 1 leaf blob; no throw
      expect(entries).toHaveLength(SMALL_CAP + 1);
      expect(entries[entries.length - 1]?.mode).toBe(FILE_MODE.REGULAR);
    });
  });
});

describe('Given core.maxTreeDepth configured to a small cap and a tree chain one level past the cap', () => {
  describe('When archive iterates all entries', () => {
    it('Then throws TREE_DEPTH_EXCEEDED with the exact depth', async () => {
      // Arrange — this is the assertion that fails on `main` today: archive
      // passed walkTree an effectively-unbounded maxDepth, so it refused at
      // no input at all.
      const SMALL_CAP = 4;
      const ctx = await initUnbornCtx();
      await seedMaxTreeDepth(ctx, String(SMALL_CAP));
      const treeId = await buildTreeChain(ctx, SMALL_CAP + 1);
      const commitId = await writeObject(ctx, makeCommit(treeId));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act — drain the full entry stream
      let caught: unknown;
      try {
        const result = await archive(ctx, { treeish: 'HEAD' });
        for await (const _entry of result.entries) {
          // drain — the throw only fires once the generator descends far
          // enough to enter the frame past the cap.
        }
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data as {
        readonly code: string;
        readonly depth: number;
      };
      expect(data.code).toBe('TREE_DEPTH_EXCEEDED');
      expect(data.depth).toBe(SMALL_CAP + 1);
    });
  });
});
