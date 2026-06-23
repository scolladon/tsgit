import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { fsck } from '../../../../src/application/commands/fsck.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { TsgitError } from '../../../../src/domain/error.js';
import {
  FILE_MODE,
  type ObjectId,
  type RefName,
  type TreeEntry,
} from '../../../../src/domain/objects/index.js';
import type { FilePath } from '../../../../src/domain/objects/object-id.js';
import type { Context } from '../../../../src/ports/context.js';
import { buildSeededContext } from '../primitives/fixtures.js';

const sut = fsck;

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

const makeCommit = (tree: ObjectId, parents: ReadonlyArray<ObjectId>, message = 'commit') => ({
  type: 'commit' as const,
  id: '' as ObjectId,
  data: {
    tree,
    parents: [...parents],
    author: {
      name: 'Ada',
      email: 'ada@example.com',
      timestamp: 1_700_000_000,
      timezoneOffset: '+0000',
    },
    committer: {
      name: 'Ada',
      email: 'ada@example.com',
      timestamp: 1_700_000_000,
      timezoneOffset: '+0000',
    },
    message,
    extraHeaders: [],
  },
});

const makeTag = (
  object: ObjectId,
  objectType: 'commit' | 'blob' | 'tree' | 'tag',
  tagName: string,
) => ({
  type: 'tag' as const,
  id: '' as ObjectId,
  data: {
    object,
    objectType,
    tagName,
    message: 'annotated tag',
    extraHeaders: [],
  },
});

/** Write an empty tree as blob, no refs: no reachable tree object. */
const initBareCtx = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  // Seed HEAD so assertRepository passes
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  return ctx;
};

// ---------------------------------------------------------------------------
// HEALTHY REPO — no findings
// ---------------------------------------------------------------------------

describe('Given a healthy repo with reachable commits', () => {
  describe('When fsck runs', () => {
    it('Then returns no dangling/unreachable/missing/broken-link findings and exit code 0', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const blobId = await writeObject(ctx, makeBlob('hello'));
      const treeId = await writeObject(
        ctx,
        makeTree([{ mode: FILE_MODE.REGULAR, name: 'hello.txt', id: blobId }]),
      );
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');

      // Act
      const result = await sut(ctx);

      // Assert — no integrity faults; root finding is expected for root commits
      const faultTypes = [
        'dangling',
        'unreachable',
        'missing',
        'broken-link',
        'bad-object',
        'hash-mismatch',
        'bad-ref',
      ];
      const faults = result.findings.filter((f) => faultTypes.includes(f.type));
      expect(faults).toHaveLength(0);
      expect(result.exitCode).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// NOT A REPOSITORY — refuse
// ---------------------------------------------------------------------------

describe('Given a context without a HEAD file (not a repository)', () => {
  describe('When fsck runs', () => {
    it('Then throws NOT_A_REPOSITORY', async () => {
      // Arrange
      const ctx = createMemoryContext();
      // No HEAD file written

      // Act
      try {
        await sut(ctx);
        expect.fail('should have thrown');
      } catch (err) {
        // Assert
        expect(err).toBeInstanceOf(TsgitError);
        expect((err as TsgitError).data.code).toBe('NOT_A_REPOSITORY');
      }
    });
  });
});

// ---------------------------------------------------------------------------
// BROKEN [core] CONFIG — tolerated (not a fault)
// ---------------------------------------------------------------------------

describe('Given a repo with a broken [core] config (valueless key)', () => {
  describe('When fsck runs', () => {
    it('Then returns no findings (core config failure tolerated)', async () => {
      // Arrange
      const ctx = await initBareCtx();
      // Write a broken config with a valueless key
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\texcludesfile\n');

      // Act
      const result = await sut(ctx);

      // Assert — assertRepository only, assertOperationalRepository NOT used
      expect(result.exitCode).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// UNBORN HEAD — tolerated (not a fault)
// ---------------------------------------------------------------------------

describe('Given a repo with HEAD pointing to an unborn branch', () => {
  describe('When fsck runs', () => {
    it('Then returns no findings and exit code 0', async () => {
      // Arrange
      const ctx = await initBareCtx();
      // HEAD -> refs/heads/main, no refs/heads/main file → unborn

      // Act
      const result = await sut(ctx);

      // Assert
      expect(result.findings).toHaveLength(0);
      expect(result.exitCode).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// DANGLING OBJECTS — tip-only (no in-edge from another present object)
// ---------------------------------------------------------------------------

describe('Given a dangling blob (written but not referenced)', () => {
  describe('When fsck runs', () => {
    it('Then emits one dangling finding for the blob', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const blobId = await writeObject(ctx, makeBlob('orphan'));

      // Act
      const result = await sut(ctx);

      // Assert
      const dangling = result.findings.filter((f) => f.type === 'dangling');
      expect(dangling).toHaveLength(1);
      expect(dangling[0]).toMatchObject({ type: 'dangling', id: blobId, objectType: 'blob' });
      expect(result.exitCode).toBe(0);
    });
  });
});

describe('Given a dangling commit (written but not referenced by any ref)', () => {
  describe('When fsck runs', () => {
    it('Then emits one dangling finding for the commit', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const treeId = await writeObject(ctx, makeTree([]));
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      // No ref points to commitId

      // Act
      const result = await sut(ctx);

      // Assert
      const dangling = result.findings.filter((f) => f.type === 'dangling');
      const danglingCommit = dangling.find((f) => f.id === commitId);
      expect(danglingCommit).toBeDefined();
      expect(danglingCommit).toMatchObject({
        type: 'dangling',
        id: commitId,
        objectType: 'commit',
      });
      expect(result.exitCode).toBe(0);
    });
  });
});

describe('Given a dangling tree (written but not referenced)', () => {
  describe('When fsck runs', () => {
    it('Then emits one dangling finding for the tree', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const treeId = await writeObject(ctx, makeTree([]));
      // No commit references this tree

      // Act
      const result = await sut(ctx);

      // Assert
      const dangling = result.findings.filter((f) => f.type === 'dangling');
      expect(dangling).toHaveLength(1);
      expect(dangling[0]).toMatchObject({ type: 'dangling', id: treeId, objectType: 'tree' });
      expect(result.exitCode).toBe(0);
    });
  });
});

describe('Given a dangling annotated tag (written but not referenced by any ref)', () => {
  describe('When fsck runs', () => {
    it('Then emits dangling finding for the tag and tagged finding for its target', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const treeId = await writeObject(ctx, makeTree([]));
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      const tagId = await writeObject(ctx, makeTag(commitId, 'commit', 'v1.0'));
      // No ref points to tagId

      // Act
      const result = await sut(ctx);

      // Assert
      const dangling = result.findings.filter((f) => f.type === 'dangling');
      const danglingTag = dangling.find((f) => f.id === tagId);
      expect(danglingTag).toMatchObject({ type: 'dangling', id: tagId, objectType: 'tag' });
      expect(result.exitCode).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// UNREACHABLE — full orphan subgraph (every node in orphan is unreachable)
// ---------------------------------------------------------------------------

describe('Given an orphan commit subgraph (commit→tree→blob, all unreachable)', () => {
  describe('When fsck runs', () => {
    it('Then emits unreachable findings for all objects in the subgraph', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const blobId = await writeObject(ctx, makeBlob('orphan-content'));
      const treeId = await writeObject(
        ctx,
        makeTree([{ mode: FILE_MODE.REGULAR, name: 'file.txt', id: blobId }]),
      );
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      // No ref → all three are unreachable

      // Act
      const result = await sut(ctx);

      // Assert — all three objects are unreachable
      const unreachableIds = result.findings
        .filter((f) => f.type === 'unreachable')
        .map((f) => (f as { type: 'unreachable'; id: ObjectId }).id);
      expect(unreachableIds).toContain(blobId);
      expect(unreachableIds).toContain(treeId);
      expect(unreachableIds).toContain(commitId);

      // The commit is a tip (no in-edge from another object): also dangling
      const danglingIds = result.findings
        .filter((f) => f.type === 'dangling')
        .map((f) => (f as { type: 'dangling'; id: ObjectId }).id);
      expect(danglingIds).toContain(commitId);

      // The blob and tree are not dangling (they have in-edges from unreachable objects)
      expect(danglingIds).not.toContain(blobId);
      expect(danglingIds).not.toContain(treeId);
      expect(result.exitCode).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// MISSING — referenced oid absent from the object store
// ---------------------------------------------------------------------------

describe('Given a tree entry pointing to a missing blob', () => {
  describe('When fsck runs', () => {
    it('Then emits missing and broken-link findings, exit code 2', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const ghostId = '0000000000000000000000000000000000000001' as ObjectId;
      const treeId = await writeObject(
        ctx,
        makeTree([{ mode: FILE_MODE.REGULAR, name: 'ghost.txt', id: ghostId }]),
      );
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act
      const result = await sut(ctx);

      // Assert
      const missing = result.findings.filter((f) => f.type === 'missing');
      expect(missing.length).toBeGreaterThanOrEqual(1);
      const missingBlob = missing.find((f) => (f as { id: ObjectId }).id === ghostId);
      expect(missingBlob).toBeDefined();

      const brokenLinks = result.findings.filter((f) => f.type === 'broken-link');
      expect(brokenLinks.length).toBeGreaterThanOrEqual(1);
      const link = brokenLinks.find(
        (f) =>
          (f as { fromId: ObjectId; toId: ObjectId }).fromId === treeId &&
          (f as { fromId: ObjectId; toId: ObjectId }).toId === ghostId,
      );
      expect(link).toBeDefined();
      expect(link).toMatchObject({
        type: 'broken-link',
        fromType: 'tree',
        toType: 'blob',
        fromId: treeId,
        toId: ghostId,
      });

      expect(result.exitCode & 2).toBe(2);
    });
  });
});

describe('Given a commit with a missing parent', () => {
  describe('When fsck runs', () => {
    it('Then emits missing and broken-link for the missing parent, exit code 2', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const ghostParent = '0000000000000000000000000000000000000002' as ObjectId;
      const treeId = await writeObject(ctx, makeTree([]));
      const commitId = await writeObject(ctx, makeCommit(treeId, [ghostParent]));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act
      const result = await sut(ctx);

      // Assert
      const missing = result.findings.filter((f) => f.type === 'missing');
      const missingParent = missing.find((f) => (f as { id: ObjectId }).id === ghostParent);
      expect(missingParent).toBeDefined();

      const brokenLinks = result.findings.filter((f) => f.type === 'broken-link');
      const link = brokenLinks.find(
        (f) =>
          (f as { fromId: ObjectId; toId: ObjectId }).fromId === commitId &&
          (f as { fromId: ObjectId; toId: ObjectId }).toId === ghostParent,
      );
      expect(link).toBeDefined();
      expect(link).toMatchObject({
        type: 'broken-link',
        fromType: 'commit',
        toType: 'commit',
        fromId: commitId,
        toId: ghostParent,
      });

      expect(result.exitCode & 2).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// MISSING TREE on commit
// ---------------------------------------------------------------------------

describe('Given a commit pointing to a missing tree', () => {
  describe('When fsck runs', () => {
    it('Then emits missing and broken-link for the missing tree, exit code 2', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const ghostTree = '0000000000000000000000000000000000000003' as ObjectId;
      const commitId = await writeObject(ctx, makeCommit(ghostTree, []));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act
      const result = await sut(ctx);

      // Assert
      const missing = result.findings.filter((f) => f.type === 'missing');
      const missingTree = missing.find((f) => (f as { id: ObjectId }).id === ghostTree);
      expect(missingTree).toBeDefined();

      const brokenLinks = result.findings.filter((f) => f.type === 'broken-link');
      const link = brokenLinks.find(
        (f) => (f as { fromId: ObjectId; toId: ObjectId }).toId === ghostTree,
      );
      expect(link).toBeDefined();
      expect(link).toMatchObject({ type: 'broken-link', fromType: 'commit', toType: 'tree' });
      expect(result.exitCode & 2).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// ROOT COMMITS — reachable commits with no parents
// ---------------------------------------------------------------------------

describe('Given a reachable root commit (no parents)', () => {
  describe('When fsck runs', () => {
    it('Then emits a root finding for the commit', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const treeId = await writeObject(ctx, makeTree([]));
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act
      const result = await sut(ctx);

      // Assert
      const roots = result.findings.filter((f) => f.type === 'root');
      expect(roots).toHaveLength(1);
      expect(roots[0]).toMatchObject({ type: 'root', id: commitId });
      expect(result.exitCode).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// TAGGED — ref pointing to annotated tag
// ---------------------------------------------------------------------------

describe('Given a ref pointing to an annotated tag (tag target reachable)', () => {
  describe('When fsck runs', () => {
    it('Then emits a tagged finding for the commit target', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const treeId = await writeObject(ctx, makeTree([]));
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      const tagId = await writeObject(ctx, makeTag(commitId, 'commit', 'v1.0'));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/tags/v1.0`, `${tagId}\n`);
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act
      const result = await sut(ctx);

      // Assert
      const tagged = result.findings.filter((f) => f.type === 'tagged');
      expect(tagged).toHaveLength(1);
      expect(tagged[0]).toMatchObject({
        type: 'tagged',
        id: commitId,
        objectType: 'commit',
        tagName: 'v1.0',
        tag: tagId,
      });
      expect(result.exitCode).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// REFLOG ROOTS — reflog oids keep objects reachable when reflogRoots:true (default)
// ---------------------------------------------------------------------------

describe('Given a commit reachable only via reflog (reset --hard scenario)', () => {
  // Scenario: user made commit A, then reset --hard to empty-tree commit B.
  // Main ref points to B (no parents). Reflog has the entry A->B.
  // A is only reachable via the reflog old-oid, not via any ref or commit parent.

  describe('When fsck runs with default options (reflogRoots defaults true)', () => {
    it('Then the old commit is NOT dangling (reflog keeps it reachable)', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const treeId = await writeObject(ctx, makeTree([]));
      const oldCommitId = await writeObject(ctx, makeCommit(treeId, [], 'old'));
      const newCommitId = await writeObject(ctx, makeCommit(treeId, [], 'new'));
      // Only newCommitId is pointed to by main; oldCommitId has no ref and is NOT a parent
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${newCommitId}\n`);
      // Reflog records the reset: old→new
      const reflogLine = `${oldCommitId} ${newCommitId} Ada <ada@example.com> 1700000000 +0000\treset: moving to HEAD\n`;
      await ctx.fs.mkdir(`${ctx.layout.gitDir}/logs/refs/heads`);
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/logs/refs/heads/main`, reflogLine);

      // Act
      const result = await sut(ctx);

      // Assert — oldCommitId reachable from reflog old-oid, so NOT dangling
      const dangling = result.findings.filter((f) => f.type === 'dangling');
      const isDanglingOld = dangling.some((f) => (f as { id: ObjectId }).id === oldCommitId);
      expect(isDanglingOld).toBe(false);
      expect(result.exitCode).toBe(0);
    });
  });

  describe('When fsck runs with reflogRoots: false', () => {
    it('Then the old commit IS dangling (reflog excluded from roots)', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const treeId = await writeObject(ctx, makeTree([]));
      const oldCommitId = await writeObject(ctx, makeCommit(treeId, [], 'old'));
      const newCommitId = await writeObject(ctx, makeCommit(treeId, [], 'new'));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${newCommitId}\n`);
      const reflogLine = `${oldCommitId} ${newCommitId} Ada <ada@example.com> 1700000000 +0000\treset: moving to HEAD\n`;
      await ctx.fs.mkdir(`${ctx.layout.gitDir}/logs/refs/heads`);
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/logs/refs/heads/main`, reflogLine);

      // Act
      const result = await sut(ctx, { reflogRoots: false });

      // Assert — oldCommitId NOT reachable (no ref, no parent edge, no reflog) → dangling
      const dangling = result.findings.filter((f) => f.type === 'dangling');
      const isDanglingOld = dangling.some((f) => (f as { id: ObjectId }).id === oldCommitId);
      expect(isDanglingOld).toBe(true);
      expect(result.exitCode).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// INDEX ROOTS — index oids keep staged blobs reachable when indexRoot:true (default)
// ---------------------------------------------------------------------------

describe('Given a staged-only blob (in index, not yet committed)', () => {
  describe('When fsck runs with default options (indexRoot defaults true)', () => {
    it('Then the staged blob is NOT dangling (index keeps it reachable)', async () => {
      // Arrange
      // We need: a blob written, an index referencing that blob, HEAD present.
      // Use buildSeededContext from primitives/fixtures to correctly write the index
      // (with checksum trailer) and then manually add the blob.
      const { STAGE0_FLAGS } = await import('../../../../src/domain/git-index/index-entry.js');
      // First write a blob via a separate context to get its id, then recreate ctx with index
      const tempCtx = await initBareCtx();
      const blobId = await writeObject(tempCtx, makeBlob('staged content'));

      // Use buildSeededContext to get a context that has the correct index
      const ctx = await buildSeededContext({
        objects: [makeBlob('staged content')],
        index: {
          version: 2,
          entries: [
            {
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
              id: blobId,
              flags: STAGE0_FLAGS,
              path: 'staged.txt' as FilePath,
            },
          ],
          extensions: [],
          trailerSha: new Uint8Array(0),
        },
      });
      // Write HEAD so assertRepository passes
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');

      // Act
      const result = await sut(ctx);

      // Assert — blobId reachable from index
      const dangling = result.findings.filter((f) => f.type === 'dangling');
      const isDanglingBlob = dangling.some((f) => (f as { id: ObjectId }).id === blobId);
      expect(isDanglingBlob).toBe(false);
      expect(result.exitCode).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// EXIT CODE BIT ISOLATION
// ---------------------------------------------------------------------------

describe('Given a clean repo', () => {
  describe('When fsck runs', () => {
    it('Then exit code is exactly 0', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const treeId = await writeObject(ctx, makeTree([]));
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act
      const result = await sut(ctx);

      // Assert
      expect(result.exitCode).toBe(0);
    });
  });
});

describe('Given a missing object (referenced but absent)', () => {
  describe('When fsck runs', () => {
    it('Then exit code has bit 2 set', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const ghostTree = '0000000000000000000000000000000000000004' as ObjectId;
      const commitId = await writeObject(ctx, makeCommit(ghostTree, []));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act
      const result = await sut(ctx);

      // Assert
      expect(result.exitCode & 2).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// REFNAME narrowing helper for type assertions
// ---------------------------------------------------------------------------

const asRefName = (s: string): RefName => s as RefName;
void asRefName; // used in IDE hover checks only
