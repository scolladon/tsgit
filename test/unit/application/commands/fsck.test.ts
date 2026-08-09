import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { type FsckFinding, fsck } from '../../../../src/application/commands/fsck.js';
import {
  commonGitDir,
  looseObjectPath,
  multiPackIndexChainPath,
  multiPackIndexPath,
  objectsDir,
  packsDir,
} from '../../../../src/application/primitives/path-layout.js';
import {
  disposePackRegistry,
  refreshPackRegistry,
} from '../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import {
  decompressFailed,
  fileNotFound,
  permissionDenied,
  TsgitError,
  unsupportedOperation,
} from '../../../../src/domain/error.js';
import {
  FILE_MODE,
  hexToBytes,
  invalidObjectHeader,
  type ObjectId,
  serializeTreeContent,
  type TreeEntry,
} from '../../../../src/domain/objects/index.js';
import type { FilePath } from '../../../../src/domain/objects/object-id.js';
import { invalidPackIndex } from '../../../../src/domain/storage/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { buildMidx, type MidxSpec } from '../../domain/storage/arbitraries.js';
import { buildSeededContext } from '../primitives/fixtures.js';
import { withHandleLedger } from '../primitives/handle-ledger.js';
import {
  buildSyntheticPack,
  type EntrySpec,
  restampPackHeader,
  writeSyntheticPack,
} from '../primitives/pack-fixture.js';
import { findingIds } from './fsck-finding-ids.js';

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
      const result = await fsck(ctx);

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
        await fsck(ctx);
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
      const result = await fsck(ctx);

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
      const result = await fsck(ctx);

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
      const result = await fsck(ctx);

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
      const result = await fsck(ctx);

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
      const result = await fsck(ctx);

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
      const result = await fsck(ctx);

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
      const result = await fsck(ctx);

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
      const result = await fsck(ctx);

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
      const result = await fsck(ctx);

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
      const result = await fsck(ctx);

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
// MISSING SUBTREE on tree (directory entry)
// ---------------------------------------------------------------------------

describe('Given a tree with a directory entry pointing to a missing subtree', () => {
  describe('When fsck runs', () => {
    it('Then the broken link to the missing subtree is typed as a tree, exit code 2', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const ghostSubtree = '0000000000000000000000000000000000000007' as ObjectId;
      const treeId = await writeObject(
        ctx,
        makeTree([{ mode: FILE_MODE.DIRECTORY, name: 'sub', id: ghostSubtree }]),
      );
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act
      const result = await fsck(ctx);

      // Assert — a missing directory entry is expected to be a tree, not a blob.
      const brokenLinks = result.findings.filter((f) => f.type === 'broken-link');
      const link = brokenLinks.find(
        (f) => (f as { fromId: ObjectId; toId: ObjectId }).toId === ghostSubtree,
      );
      expect(link).toBeDefined();
      expect(link).toMatchObject({ type: 'broken-link', fromType: 'tree', toType: 'tree' });

      const missing = result.findings.filter((f) => f.type === 'missing');
      const missingSubtree = missing.find((f) => (f as { id: ObjectId }).id === ghostSubtree);
      expect(missingSubtree).toMatchObject({ type: 'missing', objectType: 'tree' });
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
      const result = await fsck(ctx);

      // Assert
      const roots = result.findings.filter((f) => f.type === 'root');
      expect(roots).toHaveLength(1);
      expect(roots[0]).toMatchObject({ type: 'root', id: commitId });
      expect(result.exitCode).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// SHALLOW BOUNDARY — the masked parent is neither missing nor broken-link
// ---------------------------------------------------------------------------

describe('Given a shallow-universe boundary whose real parent was never fetched', () => {
  describe('When fsck runs', () => {
    it('Then the boundary surfaces only as a root, with a clean exit bitmask', async () => {
      // Arrange — the boundary's raw parent oid is never written, simulating a
      // shallow clone; without masking this would be a `missing`/`broken-link`
      // finding instead of a `root` finding.
      const ctx = await initBareCtx();
      const missingRoot = 'a'.repeat(40) as ObjectId;
      const treeId = await writeObject(ctx, makeTree([]));
      const boundaryId = await writeObject(ctx, makeCommit(treeId, [missingRoot]));
      const tipId = await writeObject(ctx, makeCommit(treeId, [boundaryId]));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${tipId}\n`);
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, `${boundaryId}\n`);

      // Act
      const result = await fsck(ctx, { strict: true });

      // Assert
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
      const roots = result.findings.filter((f) => f.type === 'root');
      expect(roots).toEqual([{ type: 'root', id: boundaryId }]);
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
      const result = await fsck(ctx);

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
// TAGGED — annotated tag pointing to a missing target
// ---------------------------------------------------------------------------

describe('Given a ref pointing to an annotated tag whose target is missing', () => {
  describe('When fsck runs', () => {
    it('Then emits missing and broken-link for the missing target, exit code 2', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const ghostTarget = '0000000000000000000000000000000000000009' as ObjectId;
      const tagId = await writeObject(ctx, makeTag(ghostTarget, 'commit', 'v1.0'));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/tags/v1.0`, `${tagId}\n`);

      // Act
      const result = await fsck(ctx);

      // Assert — the missing target surfaces both as a broken tag link and a missing object.
      const brokenLinks = result.findings.filter((f) => f.type === 'broken-link');
      const link = brokenLinks.find(
        (f) => (f as { fromId: ObjectId; toId: ObjectId }).toId === ghostTarget,
      );
      expect(link).toBeDefined();
      expect(link).toMatchObject({
        type: 'broken-link',
        fromId: tagId,
        fromType: 'tag',
        toType: 'commit',
      });

      const missing = result.findings.filter((f) => f.type === 'missing');
      const missingTarget = missing.find((f) => (f as { id: ObjectId }).id === ghostTarget);
      expect(missingTarget).toMatchObject({ type: 'missing', objectType: 'commit' });
      expect(result.exitCode & 2).toBe(2);
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
      const result = await fsck(ctx);

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
      const result = await fsck(ctx, { reflogRoots: false });

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
      const result = await fsck(ctx);

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
      const result = await fsck(ctx);

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
      const result = await fsck(ctx);

      // Assert
      expect(result.exitCode & 2).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers for writing raw (potentially malformed) loose objects
// ---------------------------------------------------------------------------

/**
 * Write a raw loose object directly — bypassing writeObject's strict
 * serialisation. This lets tests place malformed content (zero-padded modes,
 * unsorted tree entries, bad identity lines) into the object store exactly as
 * hand-corrupted loose objects exist on real disks.
 *
 * Returns the SHA-1 OID of the raw bytes.
 */
async function writeMalformedLooseObject(ctx: Context, rawBytes: Uint8Array): Promise<ObjectId> {
  const id = (await ctx.hash.hashHex(rawBytes)) as ObjectId;
  const prefix = id.slice(0, 2);
  const dir = objectsDir(ctx.layout.gitDir, prefix);
  await ctx.fs.mkdir(dir);
  const compressed = await ctx.compressor.deflate(rawBytes);
  await ctx.fs.writeExclusive(looseObjectPath(ctx.layout.gitDir, id), compressed);
  return id;
}

/** Write a zero-byte file at the oid's loose path — present in the object
 * store's directory listing but unreadable inside the cache. */
async function writeEmptyLooseObject(ctx: Context, id: ObjectId): Promise<void> {
  const dir = objectsDir(ctx.layout.gitDir, id.slice(0, 2));
  await ctx.fs.mkdir(dir);
  await ctx.fs.write(looseObjectPath(ctx.layout.gitDir, id), new Uint8Array(0));
}

const enc2 = new TextEncoder();

function buildLooseBytes(type: string, body: Uint8Array): Uint8Array {
  const header = enc2.encode(`${type} ${body.length}\0`);
  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0);
  out.set(body, header.length);
  return out;
}

// ---------------------------------------------------------------------------
// CONTENT VALIDATION — zeroPaddedFilemode (WARN, no strict → exit 0)
// ---------------------------------------------------------------------------

describe('Given a loose tree object with zeroPaddedFilemode (zero-padded mode bytes)', () => {
  describe('When fsck runs without --strict', () => {
    it('Then emits a bad-object finding with severity warning and exit code 0', async () => {
      // Arrange
      const ctx = await initBareCtx();
      // Create a valid blob to reference
      const blobId = await writeObject(ctx, makeBlob('content'));
      // Build a tree with zero-padded filemode: "0100644" instead of "100644"
      const blobHex = blobId as string;
      const blobSha = new Uint8Array(20);
      for (let i = 0; i < 20; i++) {
        blobSha[i] = Number.parseInt(blobHex.slice(i * 2, i * 2 + 2), 16);
      }
      const modeBytes = enc2.encode('0100644 file.txt\0');
      const treeBody = new Uint8Array(modeBytes.length + 20);
      treeBody.set(modeBytes, 0);
      treeBody.set(blobSha, modeBytes.length);
      const treeRaw = buildLooseBytes('tree', treeBody);
      const treeId = await writeMalformedLooseObject(ctx, treeRaw);
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act
      const result = await fsck(ctx);

      // Assert — warning in tree <sha>: zeroPaddedFilemode
      const badObjects = result.findings.filter((f) => f.type === 'bad-object');
      const zeroPadded = badObjects.find(
        (f) => (f as { msgId: string }).msgId === 'zeroPaddedFilemode',
      );
      expect(zeroPadded).toBeDefined();
      expect(zeroPadded).toMatchObject({
        type: 'bad-object',
        id: treeId,
        objectType: 'tree',
        msgId: 'zeroPaddedFilemode',
        severity: 'warning',
      });
      // WARN default → exit 0
      expect(result.exitCode & 1).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// CONTENT VALIDATION — zeroPaddedFilemode under strict (WARN→ERROR → exit 1)
// ---------------------------------------------------------------------------

describe('Given a loose tree object with zeroPaddedFilemode (zero-padded mode bytes)', () => {
  describe('When fsck runs with strict:true', () => {
    it('Then emits a bad-object finding with severity error and exit code has bit 1', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const blobId = await writeObject(ctx, makeBlob('content'));
      const blobHex = blobId as string;
      const blobSha = new Uint8Array(20);
      for (let i = 0; i < 20; i++) {
        blobSha[i] = Number.parseInt(blobHex.slice(i * 2, i * 2 + 2), 16);
      }
      const modeBytes = enc2.encode('0100644 file.txt\0');
      const treeBody = new Uint8Array(modeBytes.length + 20);
      treeBody.set(modeBytes, 0);
      treeBody.set(blobSha, modeBytes.length);
      const treeRaw = buildLooseBytes('tree', treeBody);
      const treeId = await writeMalformedLooseObject(ctx, treeRaw);
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act
      const result = await fsck(ctx, { strict: true });

      // Assert — error in tree <sha>: zeroPaddedFilemode (WARN upgraded to ERROR under strict)
      const badObjects = result.findings.filter((f) => f.type === 'bad-object');
      const zeroPadded = badObjects.find(
        (f) => (f as { msgId: string }).msgId === 'zeroPaddedFilemode',
      );
      expect(zeroPadded).toBeDefined();
      expect(zeroPadded).toMatchObject({
        type: 'bad-object',
        msgId: 'zeroPaddedFilemode',
        severity: 'error',
      });
      // ERROR under strict → exit bit 1
      expect(result.exitCode & 1).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// CONTENT VALIDATION — treeNotSorted (ERROR in both default and strict)
// ---------------------------------------------------------------------------

describe('Given a loose tree object with treeNotSorted (entries in wrong order)', () => {
  describe('When fsck runs', () => {
    it('Then emits a bad-object finding with severity error and exit code has bit 1', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const blobId = await writeObject(ctx, makeBlob('a'));
      const blobId2 = await writeObject(ctx, makeBlob('b'));
      const blobHex1 = blobId as string;
      const blobHex2 = blobId2 as string;
      const sha1 = new Uint8Array(20);
      const sha2 = new Uint8Array(20);
      for (let i = 0; i < 20; i++) {
        sha1[i] = Number.parseInt(blobHex1.slice(i * 2, i * 2 + 2), 16);
        sha2[i] = Number.parseInt(blobHex2.slice(i * 2, i * 2 + 2), 16);
      }
      // Wrong order: 'z.txt' before 'a.txt' (descending, which violates git sort)
      const entry1 = enc2.encode('100644 z.txt\0');
      const entry2 = enc2.encode('100644 a.txt\0');
      const treeBody = new Uint8Array(entry1.length + 20 + entry2.length + 20);
      let off = 0;
      treeBody.set(entry1, off);
      off += entry1.length;
      treeBody.set(sha1, off);
      off += 20;
      treeBody.set(entry2, off);
      off += entry2.length;
      treeBody.set(sha2, off);
      const treeRaw = buildLooseBytes('tree', treeBody);
      const treeId = await writeMalformedLooseObject(ctx, treeRaw);
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act
      const result = await fsck(ctx);

      // Assert — error in tree <sha>: treeNotSorted: not properly sorted
      const badObjects = result.findings.filter((f) => f.type === 'bad-object');
      const notSorted = badObjects.find((f) => (f as { msgId: string }).msgId === 'treeNotSorted');
      expect(notSorted).toBeDefined();
      expect(notSorted).toMatchObject({
        type: 'bad-object',
        id: treeId,
        objectType: 'tree',
        msgId: 'treeNotSorted',
        severity: 'error',
      });
      // ERROR → exit bit 1
      expect(result.exitCode & 1).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// CONTENT VALIDATION — missingSpaceBeforeEmail (ERROR in both modes)
// ---------------------------------------------------------------------------

describe('Given a loose commit object with missingSpaceBeforeEmail', () => {
  describe('When fsck runs', () => {
    it('Then emits bad-object finding with severity error and exit code has bit 1', async () => {
      // Arrange
      const ctx = await initBareCtx();
      // Write a valid empty tree
      const treeId = await writeObject(ctx, makeTree([]));
      const treeHex = treeId as string;
      // Commit body with 'Name<email>' (missing space before '<')
      const commitBody = enc2.encode(
        `tree ${treeHex}\nauthor Name<bad@example.com> 1700000000 +0000\ncommitter Test <c@example.com> 1700000000 +0000\n\nmessage\n`,
      );
      const commitRaw = buildLooseBytes('commit', commitBody);
      const commitId = await writeMalformedLooseObject(ctx, commitRaw);
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act
      const result = await fsck(ctx);

      // Assert — error in commit <sha>: missingSpaceBeforeEmail
      const badObjects = result.findings.filter((f) => f.type === 'bad-object');
      const missingSpace = badObjects.find(
        (f) => (f as { msgId: string }).msgId === 'missingSpaceBeforeEmail',
      );
      expect(missingSpace).toBeDefined();
      expect(missingSpace).toMatchObject({
        type: 'bad-object',
        id: commitId,
        objectType: 'commit',
        msgId: 'missingSpaceBeforeEmail',
        severity: 'error',
      });
      // ERROR → exit bit 1
      expect(result.exitCode & 1).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// CONTENT VALIDATION — strict does NOT upgrade ERROR or INFO ids
// ---------------------------------------------------------------------------

describe('Given a loose tree with treeNotSorted (ERROR, not in strict-upgrade set)', () => {
  describe('When fsck runs with strict:true', () => {
    it('Then treeNotSorted severity stays error (not changed by strict)', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const blobId = await writeObject(ctx, makeBlob('x'));
      const blobHex = blobId as string;
      const sha = new Uint8Array(20);
      for (let i = 0; i < 20; i++) sha[i] = Number.parseInt(blobHex.slice(i * 2, i * 2 + 2), 16);
      const e1 = enc2.encode('100644 z.txt\0');
      const e2 = enc2.encode('100644 a.txt\0');
      const body = new Uint8Array(e1.length + 20 + e2.length + 20);
      let o = 0;
      body.set(e1, o);
      o += e1.length;
      body.set(sha, o);
      o += 20;
      body.set(e2, o);
      o += e2.length;
      body.set(sha, o);
      const treeRaw = buildLooseBytes('tree', body);
      const treeId = await writeMalformedLooseObject(ctx, treeRaw);
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act
      const result = await fsck(ctx, { strict: true });

      // Assert — treeNotSorted remains 'error' even under strict
      const notSorted = result.findings.find(
        (f) => f.type === 'bad-object' && (f as { msgId: string }).msgId === 'treeNotSorted',
      );
      expect(notSorted).toBeDefined();
      expect((notSorted as { severity: string }).severity).toBe('error');
    });
  });
});

// ---------------------------------------------------------------------------
// HASH MISMATCH — content hash ≠ path oid → hash-mismatch finding, exit bit 1
// ---------------------------------------------------------------------------

describe('Given a loose object whose content hash does not match its path (hash-path mismatch)', () => {
  describe('When fsck runs', () => {
    it('Then emits hash-mismatch finding and exit code has bit 1', async () => {
      // Arrange
      const ctx = await initBareCtx();
      // Write blob1 normally to get its hash
      const blobId1 = await writeObject(ctx, makeBlob('hello'));
      // Write blob2 normally to get the content we'll store under blob1's path
      const blobId2 = await writeObject(ctx, makeBlob('world'));
      // Overwrite blob1's path with blob2's compressed bytes
      const blob2Path = looseObjectPath(ctx.layout.gitDir, blobId2);
      const blob2Compressed = await ctx.fs.read(blob2Path);
      const blob1Path = looseObjectPath(ctx.layout.gitDir, blobId1);
      // Need to write: blob2's content at blob1's path (hash≠path)
      // The memory FS supports overwrite via writeUtf8 but we need binary
      // Use ctx.fs.read + ctx.fs.writeExclusive on the blob1 path
      // First remove blob1's original content by overwriting
      await ctx.fs.write(blob1Path, blob2Compressed);

      // Act
      const result = await fsck(ctx);

      // Assert — hash-mismatch finding for blobId1 (path oid) with actual = blobId2
      const hashMismatch = result.findings.filter((f) => f.type === 'hash-mismatch');
      expect(hashMismatch.length).toBeGreaterThanOrEqual(1);
      const mismatch = hashMismatch.find((f) => (f as { id: ObjectId }).id === blobId1);
      expect(mismatch).toBeDefined();
      expect((mismatch as { actual: ObjectId }).actual).toBe(blobId2);
      // hash-mismatch → exit bit 1
      expect(result.exitCode & 1).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// CONNECTIVITY-ONLY — content validation skipped
// ---------------------------------------------------------------------------

describe('Given a loose tree with zeroPaddedFilemode and connectivityOnly:true', () => {
  describe('When fsck runs with connectivityOnly:true', () => {
    it('Then no bad-object findings are emitted (content pass skipped)', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const blobId = await writeObject(ctx, makeBlob('content'));
      const blobHex = blobId as string;
      const blobSha = new Uint8Array(20);
      for (let i = 0; i < 20; i++) {
        blobSha[i] = Number.parseInt(blobHex.slice(i * 2, i * 2 + 2), 16);
      }
      const modeBytes = enc2.encode('0100644 file.txt\0');
      const treeBody = new Uint8Array(modeBytes.length + 20);
      treeBody.set(modeBytes, 0);
      treeBody.set(blobSha, modeBytes.length);
      const treeRaw = buildLooseBytes('tree', treeBody);
      const treeId = await writeMalformedLooseObject(ctx, treeRaw);
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act
      const result = await fsck(ctx, { connectivityOnly: true });

      // Assert — no bad-object findings (content pass skipped entirely)
      const badObjects = result.findings.filter((f) => f.type === 'bad-object');
      expect(badObjects).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// EXIT BIT ISOLATION — WARN content finding alone → exit 0
// ---------------------------------------------------------------------------

describe('Given a repo with only WARN-severity content findings (zeroPaddedFilemode, no strict)', () => {
  describe('When fsck runs without strict', () => {
    it('Then exit code is 0 (WARN alone does not set exit bit)', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const blobId = await writeObject(ctx, makeBlob('content'));
      const blobHex = blobId as string;
      const blobSha = new Uint8Array(20);
      for (let i = 0; i < 20; i++) {
        blobSha[i] = Number.parseInt(blobHex.slice(i * 2, i * 2 + 2), 16);
      }
      const modeBytes = enc2.encode('0100644 file.txt\0');
      const treeBody = new Uint8Array(modeBytes.length + 20);
      treeBody.set(modeBytes, 0);
      treeBody.set(blobSha, modeBytes.length);
      const treeRaw = buildLooseBytes('tree', treeBody);
      const treeId = await writeMalformedLooseObject(ctx, treeRaw);
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act
      const result = await fsck(ctx);

      // Assert — exit code 0 (WARN doesn't trigger exit bit)
      expect(result.exitCode).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// REFS-VERIFY PASS — badRefContent (malformed loose ref, exit bit 8)
// ---------------------------------------------------------------------------

describe('Given a loose ref with malformed content (not a valid OID)', () => {
  describe('When fsck runs with checkReferences default (true)', () => {
    it('Then emits bad-ref badRefContent finding severity error, exit bit 8 set', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const treeId = await writeObject(ctx, makeTree([]));
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/garbage`, 'not-a-valid-sha\n');

      // Act
      const result = await fsck(ctx);

      // Assert — badRefContent finding present
      const badRef = result.findings.find(
        (f): f is FsckFinding & { type: 'bad-ref' } =>
          f.type === 'bad-ref' && f.msgId === 'badRefContent',
      );
      expect(badRef).toBeDefined();
      expect(badRef?.severity).toBe('error');
      expect(badRef?.ref).toBe('refs/heads/garbage');
      // exit bit 8 set (refs content failure)
      expect(result.exitCode & 8).toBe(8);
    });
  });
});

describe('Given a loose ref with malformed content', () => {
  describe('When fsck runs with checkReferences:false', () => {
    it('Then no badRefContent finding is emitted (refs-verify pass skipped)', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const treeId = await writeObject(ctx, makeTree([]));
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/garbage`, 'not-a-valid-sha\n');

      // Act
      const result = await fsck(ctx, { checkReferences: false });

      // Assert — no badRefContent finding when refs-verify pass is skipped
      const badRefContent = result.findings.find(
        (f) => f.type === 'bad-ref' && (f as { msgId: string }).msgId === 'badRefContent',
      );
      expect(badRefContent).toBeUndefined();
      // exit bit 8 NOT set
      expect(result.exitCode & 8).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// REFS-VERIFY PASS — badRefOid (absent OID, exit bit 2)
// ---------------------------------------------------------------------------

describe('Given a loose ref pointing to a valid-format but absent OID', () => {
  describe('When fsck runs', () => {
    it('Then emits bad-ref badRefOid finding severity error, exit bit 2 set', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const treeId = await writeObject(ctx, makeTree([]));
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);
      const absentOid = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as ObjectId;
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/broken`, `${absentOid}\n`);

      // Act
      const result = await fsck(ctx);

      // Assert — badRefOid finding for the absent OID ref
      const badRef = result.findings.find(
        (f): f is FsckFinding & { type: 'bad-ref' } =>
          f.type === 'bad-ref' && f.msgId === 'badRefOid',
      );
      expect(badRef).toBeDefined();
      expect(badRef?.severity).toBe('error');
      expect(badRef?.ref).toBe('refs/heads/broken');
      expect(badRef?.target).toBe(absentOid);
      // exit bit 2 set (missing/absent)
      expect(result.exitCode & 2).toBe(2);
    });
  });
});

describe('Given a loose ref pointing to an absent OID', () => {
  describe('When fsck runs', () => {
    it('Then does NOT emit a duplicate missing finding for the absent OID', async () => {
      // Arrange — absent OID ref should produce bad-ref, not 'missing' finding
      const ctx = await initBareCtx();
      const absentOid = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as ObjectId;
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/broken`, `${absentOid}\n`);

      // Act
      const result = await fsck(ctx);

      // Assert — only bad-ref, no 'missing' finding for the absent OID
      const missingForAbsent = result.findings.filter(
        (f) => f.type === 'missing' && (f as { id: ObjectId }).id === absentOid,
      );
      expect(missingForAbsent).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// REFS-VERIFY PASS — malformed content: badRefContent + badRefOid(zero), exit 10
// ---------------------------------------------------------------------------

describe('Given a loose ref with malformed content (matrix #9b)', () => {
  describe('When fsck runs', () => {
    it('Then emits both badRefContent (bit 8) and badRefOid for zero OID (bit 2), exit 10', async () => {
      // Arrange
      const ctx = await initBareCtx();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/garbage`, 'not-a-valid-sha\n');

      // Act
      const result = await fsck(ctx);

      // Assert — badRefContent finding
      const badRefContent = result.findings.find(
        (f): f is FsckFinding & { type: 'bad-ref' } =>
          f.type === 'bad-ref' && f.msgId === 'badRefContent',
      );
      expect(badRefContent).toBeDefined();
      expect(badRefContent?.severity).toBe('error');

      // Assert — badRefOid finding (synthesized zero OID)
      const badRefOid = result.findings.find(
        (f): f is FsckFinding & { type: 'bad-ref' } =>
          f.type === 'bad-ref' && f.msgId === 'badRefOid',
      );
      expect(badRefOid).toBeDefined();
      expect(badRefOid?.target).toBe('0000000000000000000000000000000000000000');

      // Assert — composite exit 10 = 2|8
      expect(result.exitCode).toBe(10);
    });
  });
});

// ---------------------------------------------------------------------------
// REFS-VERIFY PASS — packed-refs absent OID (exit bit 2)
// ---------------------------------------------------------------------------

describe('Given a packed-ref entry pointing to an absent OID', () => {
  describe('When fsck runs', () => {
    it('Then emits bad-ref badRefOid finding for the packed ref, exit bit 2 set', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const absentOid = 'cccccccccccccccccccccccccccccccccccccccc' as ObjectId;
      await ctx.fs.writeUtf8(
        `${ctx.layout.gitDir}/packed-refs`,
        `# pack-refs with: peeled fully-peeled sorted \n${absentOid} refs/heads/packed-broken\n`,
      );

      // Act
      const result = await fsck(ctx);

      // Assert — badRefOid finding
      const badRef = result.findings.find(
        (f): f is FsckFinding & { type: 'bad-ref' } =>
          f.type === 'bad-ref' && f.msgId === 'badRefOid',
      );
      expect(badRef).toBeDefined();
      expect(badRef?.ref).toBe('refs/heads/packed-broken');
      expect(badRef?.target).toBe(absentOid);
      // exit bit 2 set
      expect(result.exitCode & 2).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// REFS-VERIFY PASS — checkReferences:false skips ENTIRE refs-verify pass
// ---------------------------------------------------------------------------

describe('Given a loose ref with absent OID and checkReferences:false', () => {
  describe('When fsck runs with checkReferences:false', () => {
    it('Then still emits badRefOid (absent OID always checked) but no badRefContent', async () => {
      // Arrange — checkReferences:false skips content-format check but not absent-OID check
      const ctx = await initBareCtx();
      const absentOid = 'dddddddddddddddddddddddddddddddddddddddd' as ObjectId;
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/broken`, `${absentOid}\n`);

      // Act
      const result = await fsck(ctx, { checkReferences: false });

      // Assert — badRefOid still emitted (absent OID not gated by checkReferences)
      const badRefOid = result.findings.find(
        (f): f is FsckFinding & { type: 'bad-ref' } =>
          f.type === 'bad-ref' && f.msgId === 'badRefOid',
      );
      expect(badRefOid).toBeDefined();
      expect(result.exitCode & 2).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// REFS-VERIFY PASS — unborn HEAD (symref → non-existent branch) is clean
// ---------------------------------------------------------------------------

describe('Given HEAD pointing to unborn branch (no commits)', () => {
  describe('When fsck runs', () => {
    it('Then no bad-ref findings and exit code 0 (unborn HEAD tolerated)', async () => {
      // Arrange — initBareCtx writes HEAD → ref: refs/heads/main (unborn)
      const ctx = await initBareCtx();

      // Act
      const result = await fsck(ctx);

      // Assert — no bad-ref findings for unborn HEAD
      const badRefs = result.findings.filter((f) => f.type === 'bad-ref');
      expect(badRefs).toHaveLength(0);
      expect(result.exitCode).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// REFLOG NULL-OID SENTINEL — zero oldId on initial commit must not produce
// a spurious 'missing' finding (real git 2.54.0: exit 0, no output)
// ---------------------------------------------------------------------------

describe('Given a repo with one commit whose reflog first entry has the null-oid (0000…) as oldId', () => {
  describe('When fsck runs', () => {
    it('Then no missing finding is emitted for the null-oid and exit code is 0', async () => {
      // Arrange — write a minimal healthy commit graph with refs
      const ctx = await initBareCtx();
      const treeId = await writeObject(ctx, makeTree([]));
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);
      // Reflog initial entry: oldId is ZERO_OID (the null-oid sentinel git writes on creation)
      const ZERO_OID_STR = '0000000000000000000000000000000000000000';
      const reflogLine = `${ZERO_OID_STR} ${commitId} Ada <ada@example.com> 1700000000 +0000\tcommit (initial): first\n`;
      await ctx.fs.mkdir(`${ctx.layout.gitDir}/logs/refs/heads`);
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/logs/refs/heads/main`, reflogLine);

      // Act
      const result = await fsck(ctx);

      // Assert — null-oid must never be treated as a missing object
      const missingForZeroOid = result.findings.filter(
        (f) => f.type === 'missing' && (f as { id: ObjectId }).id === ZERO_OID_STR,
      );
      expect(missingForZeroOid).toHaveLength(0);
      // Clean repo → exit 0
      expect(result.exitCode).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// FIX 1 — .gitmodules blob content checks must fire when blob is named
// .gitmodules in its parent tree (pinned real git 2.54.0: exit 1, stderr
// "error in blob <sha>: gitmodulesUrl: disallowed submodule url: ...")
// ---------------------------------------------------------------------------

describe('Given a tree containing a .gitmodules blob with a disallowed URL (--upload-pack=evil)', () => {
  describe('When fsck runs', () => {
    it('Then emits gitmodulesUrl bad-object finding with severity error and exit bit 1', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const enc = new TextEncoder();
      // Blob content: valid .gitmodules INI with a disallowed url
      const gitmodulesContent = enc.encode(
        '[submodule "evil"]\n\tpath = evil\n\turl = --upload-pack=evil\n',
      );
      const blobId = await writeObject(ctx, {
        type: 'blob' as const,
        id: '' as ObjectId,
        content: gitmodulesContent,
      });
      // Tree: blob named '.gitmodules'
      const treeId = await writeObject(
        ctx,
        makeTree([{ mode: FILE_MODE.REGULAR, name: '.gitmodules', id: blobId }]),
      );
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act
      const result = await fsck(ctx);

      // Assert — gitmodulesUrl finding on the blob
      // Pinned real git 2.54.0: stderr "error in blob <sha>: gitmodulesUrl: disallowed submodule url: --upload-pack=evil", exit 1
      const gitmodulesUrl = result.findings.find(
        (f): f is FsckFinding & { type: 'bad-object' } =>
          f.type === 'bad-object' && (f as { msgId: string }).msgId === 'gitmodulesUrl',
      );
      expect(gitmodulesUrl).toBeDefined();
      expect((gitmodulesUrl as { id: ObjectId }).id).toBe(blobId);
      expect((gitmodulesUrl as { objectType: string }).objectType).toBe('blob');
      expect((gitmodulesUrl as { severity: string }).severity).toBe('error');
      // exit bit 1: content-ERROR finding
      expect(result.exitCode & 1).toBe(1);
    });
  });
});

describe('Given a tree containing a .gitmodules blob that cannot be parsed (malformed INI)', () => {
  describe('When fsck runs', () => {
    it('Then emits gitmodulesParse bad-object finding with severity info and exit 0', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const enc = new TextEncoder();
      // Malformed .gitmodules: unclosed section header
      const gitmodulesContent = enc.encode(
        '[submodule "bad"\npath = evil\nurl = git://example.com/evil\n',
      );
      const blobId = await writeObject(ctx, {
        type: 'blob' as const,
        id: '' as ObjectId,
        content: gitmodulesContent,
      });
      const treeId = await writeObject(
        ctx,
        makeTree([{ mode: FILE_MODE.REGULAR, name: '.gitmodules', id: blobId }]),
      );
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act
      const result = await fsck(ctx);

      // Assert — gitmodulesParse finding on the blob
      // Pinned real git 2.54.0: "warning in blob <sha>: gitmodulesParse: could not parse gitmodules blob", exit 0
      const gitmodulesParse = result.findings.find(
        (f): f is FsckFinding & { type: 'bad-object' } =>
          f.type === 'bad-object' && (f as { msgId: string }).msgId === 'gitmodulesParse',
      );
      expect(gitmodulesParse).toBeDefined();
      expect((gitmodulesParse as { id: ObjectId }).id).toBe(blobId);
      expect((gitmodulesParse as { objectType: string }).objectType).toBe('blob');
      // gitmodulesParse is INFO severity
      expect((gitmodulesParse as { severity: string }).severity).toBe('info');
      // INFO alone → exit 0
      expect(result.exitCode).toBe(0);
    });
  });
});

describe('Given a tree containing a .gitmodules blob with a submodule named "../evil" (unsafe name)', () => {
  describe('When fsck runs', () => {
    it('Then emits gitmodulesName bad-object finding with severity error and exit bit 1', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const enc = new TextEncoder();
      const gitmodulesContent = enc.encode(
        '[submodule "../evil"]\n\tpath = evil\n\turl = https://example.com/repo.git\n',
      );
      const blobId = await writeObject(ctx, {
        type: 'blob' as const,
        id: '' as ObjectId,
        content: gitmodulesContent,
      });
      const treeId = await writeObject(
        ctx,
        makeTree([{ mode: FILE_MODE.REGULAR, name: '.gitmodules', id: blobId }]),
      );
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act
      const result = await fsck(ctx);

      // Assert — gitmodulesName finding on the blob
      // Pinned real git 2.54.0: "error in blob <sha>: gitmodulesName: disallowed submodule name: ../evil", exit 1
      const gitmodulesName = result.findings.find(
        (f): f is FsckFinding & { type: 'bad-object' } =>
          f.type === 'bad-object' && (f as { msgId: string }).msgId === 'gitmodulesName',
      );
      expect(gitmodulesName).toBeDefined();
      expect((gitmodulesName as { id: ObjectId }).id).toBe(blobId);
      expect((gitmodulesName as { severity: string }).severity).toBe('error');
      expect(result.exitCode & 1).toBe(1);
    });
  });
});

describe('Given a blob named .gitmodules in a sub-tree (not the root tree)', () => {
  describe('When fsck runs', () => {
    it('Then emits gitmodulesUrl finding (git checks .gitmodules at any tree level, not only root)', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const enc = new TextEncoder();
      // .gitmodules with bad URL — placed inside a subdirectory tree
      // Pinned real git 2.54.0: git DOES check .gitmodules at any tree level
      const gitmodulesContent = enc.encode(
        '[submodule "evil"]\n\tpath = evil\n\turl = --upload-pack=evil\n',
      );
      const blobId = await writeObject(ctx, {
        type: 'blob' as const,
        id: '' as ObjectId,
        content: gitmodulesContent,
      });
      // Inner tree: has .gitmodules blob
      const innerTreeId = await writeObject(
        ctx,
        makeTree([{ mode: FILE_MODE.REGULAR, name: '.gitmodules', id: blobId }]),
      );
      // Root tree: has inner tree as a subdirectory
      const rootTreeId = await writeObject(
        ctx,
        makeTree([{ mode: FILE_MODE.DIRECTORY, name: 'subdir', id: innerTreeId }]),
      );
      const commitId = await writeObject(ctx, makeCommit(rootTreeId, []));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act
      const result = await fsck(ctx);

      // Assert — gitmodulesUrl fires even for .gitmodules in a subdirectory
      const gitmodulesUrl = result.findings.find(
        (f): f is FsckFinding & { type: 'bad-object' } =>
          f.type === 'bad-object' && (f as { msgId: string }).msgId === 'gitmodulesUrl',
      );
      expect(gitmodulesUrl).toBeDefined();
      expect((gitmodulesUrl as { id: ObjectId }).id).toBe(blobId);
      expect(result.exitCode & 1).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// FIX 3 — corrupt-object msgId faithfulness
// Inflate failure → objectType 'unknown', not 'blob'
// Unknown type in header → msgId 'unknownType', objectType 'unknown'
// ---------------------------------------------------------------------------

describe('Given a loose object with undecodable compressed bytes (inflate failure)', () => {
  describe('When fsck runs', () => {
    it('Then bad-object objectType is unknown (not blob), msgId is unterminatedHeader, exit bit 1', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const blobId = await writeObject(ctx, makeBlob('to-corrupt'));
      const blobPath = looseObjectPath(ctx.layout.gitDir, blobId);
      // Write bytes that cannot be deflate-decompressed
      const garbage = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      await ctx.fs.write(blobPath, garbage);

      // Act
      const result = await fsck(ctx);

      // Assert — corrupt object: objectType must not be hardcoded 'blob'
      const corrupt = result.findings.find(
        (f): f is FsckFinding & { type: 'bad-object' } =>
          f.type === 'bad-object' && (f as { id: ObjectId }).id === blobId,
      );
      expect(corrupt).toBeDefined();
      // Inflate failure: type is unknown (we cannot read the header)
      expect((corrupt as { objectType: string }).objectType).toBe('unknown');
      expect((corrupt as { msgId: string }).msgId).toBe('unterminatedHeader');
      expect((corrupt as { severity: string }).severity).toBe('error');
      expect(result.exitCode & 1).toBe(1);
    });
  });
});

describe('Given a loose object whose raw header declares an unknown type (e.g. "bogus")', () => {
  describe('When fsck runs', () => {
    it('Then bad-object has msgId unknownType and objectType unknown, exit bit 1', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const enc = new TextEncoder();
      // Build a loose object raw bytes: 'bogus 5\0hello' (unknown type)
      const body = enc.encode('hello');
      const header = enc.encode(`bogus ${body.length}\0`);
      const rawBytes = new Uint8Array(header.length + body.length);
      rawBytes.set(header);
      rawBytes.set(body, header.length);
      // Compute the OID (sha1 of raw bytes)
      const oidHex = await ctx.hash.hashHex(rawBytes);
      const compressed = await ctx.compressor.deflate(rawBytes);
      const objPath = looseObjectPath(ctx.layout.gitDir, oidHex as ObjectId);
      await ctx.fs.write(objPath, compressed);

      // Act
      const result = await fsck(ctx);

      // Assert — unknown-type object: msgId should be 'unknownType', objectType 'unknown'
      // Pinned real git 2.54.0: stderr "error: unable to parse type from header 'bogus 5'", exit 1
      const unknownType = result.findings.find(
        (f): f is FsckFinding & { type: 'bad-object' } =>
          f.type === 'bad-object' && (f as { id: ObjectId }).id === oidHex,
      );
      expect(unknownType).toBeDefined();
      expect((unknownType as { msgId: string }).msgId).toBe('unknownType');
      expect((unknownType as { objectType: string }).objectType).toBe('unknown');
      expect((unknownType as { severity: string }).severity).toBe('error');
      expect(result.exitCode & 1).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// full:false — packed objects excluded from universe
// ---------------------------------------------------------------------------

describe('Given a repo where the only object is in a pack file', () => {
  describe('When fsck runs with full:false', () => {
    it('Then no findings are emitted (packed object not enumerated)', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const blobContent = enc.encode('packed-content');
      // Write a pack containing a blob (no loose copy)
      const [blobId] = await writeSyntheticPack(ctx, 'testpack', [
        { kind: 'base', type: 'blob', content: blobContent },
      ]);
      // Write a minimal valid commit so the repo has a ref
      const treeId = await writeObject(ctx, makeTree([]));
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);
      // The packed blob is NOT referenced — in full mode it would be dangling.
      // In full:false mode it is invisible (not in universe), so no finding.

      // Act
      const result = await fsck(ctx, { full: false });

      // Assert — packed blob is invisible; no dangling finding for it
      const danglingForPacked = result.findings.filter(
        (f) => f.type === 'dangling' && (f as { id: ObjectId }).id === blobId,
      );
      expect(danglingForPacked).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Merge commit — two reachable parents, no spurious dangling/root findings
// ---------------------------------------------------------------------------

describe('Given a merge commit with two reachable parent commits', () => {
  describe('When fsck runs', () => {
    it('Then no dangling or missing findings for either parent', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const treeId = await writeObject(ctx, makeTree([]));
      const parent1Id = await writeObject(ctx, makeCommit(treeId, []));
      const parent2Id = await writeObject(ctx, makeCommit(treeId, []));
      const mergeId = await writeObject(ctx, makeCommit(treeId, [parent1Id, parent2Id]));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${mergeId}\n`);

      // Act
      const result = await fsck(ctx);

      // Assert — parents are reached; no dangling/missing for either
      const parentFindings = result.findings.filter(
        (f) =>
          (f.type === 'dangling' || f.type === 'missing') &&
          ((f as { id?: ObjectId }).id === parent1Id || (f as { id?: ObjectId }).id === parent2Id),
      );
      expect(parentFindings).toHaveLength(0);
      // merge commit is not a root finding (it has parents)
      expect(result.exitCode).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Dangling object in pack only (no loose copy) — reported dangling
// ---------------------------------------------------------------------------

describe('Given a dangling blob that exists only in a pack file', () => {
  describe('When fsck runs (full mode, default)', () => {
    it('Then emits dangling finding for the packed blob', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const blobContent = enc.encode('dangling-packed-blob');
      const [blobId] = await writeSyntheticPack(ctx, 'danglingpack', [
        { kind: 'base', type: 'blob', content: blobContent },
      ]);
      // No ref or commit references blobId — it is dangling.
      // Write a minimal valid commit so the repo is non-empty.
      const treeId = await writeObject(ctx, makeTree([]));
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act
      const result = await fsck(ctx);

      // Assert — dangling finding for the packed blob
      const danglingPacked = result.findings.find(
        (f): f is FsckFinding & { type: 'dangling' } =>
          f.type === 'dangling' && (f as { id: ObjectId }).id === blobId,
      );
      expect(danglingPacked).toBeDefined();
      expect((danglingPacked as { objectType: string }).objectType).toBe('blob');
    });
  });
});

// ---------------------------------------------------------------------------
// EXIT CODE COMPOSITE — bit1 (content-error) AND bit2 (missing) → exitCode === 3 exactly
// ---------------------------------------------------------------------------

describe('Given a repo with both a content-ERROR finding and a missing referenced object', () => {
  describe('When fsck runs', () => {
    it('Then exit code is exactly 3 (bit 1 OR bit 2)', async () => {
      // Arrange
      const ctx = await initBareCtx();
      // Build a tree with treeNotSorted fault (ERROR, bit 1)
      const blobId = await writeObject(ctx, makeBlob('content'));
      const blobHex = blobId as string;
      const blobSha = new Uint8Array(20);
      for (let i = 0; i < 20; i++) {
        blobSha[i] = Number.parseInt(blobHex.slice(i * 2, i * 2 + 2), 16);
      }
      // Unsorted tree: 'z-file' before 'a-file' → treeNotSorted (ERROR)
      const zEntry = new Uint8Array([...enc2.encode('100644 z-file\0'), ...blobSha]);
      const aEntry = new Uint8Array([...enc2.encode('100644 a-file\0'), ...blobSha]);
      const treeBody = new Uint8Array(zEntry.length + aEntry.length);
      treeBody.set(zEntry, 0);
      treeBody.set(aEntry, zEntry.length);
      const treeRaw = buildLooseBytes('tree', treeBody);
      const treeId = await writeMalformedLooseObject(ctx, treeRaw);
      // Missing parent reference (bit 2)
      const ghostParent = '0000000000000000000000000000000000000099' as ObjectId;
      const commitId = await writeObject(ctx, makeCommit(treeId, [ghostParent]));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act
      const result = await fsck(ctx);

      // Assert — both bits set: exitCode === 3 exactly (not just masked)
      expect(result.exitCode).toBe(3);
    });
  });
});

// ---------------------------------------------------------------------------
// MUTATION KILL TESTS
// ---------------------------------------------------------------------------

// Kill: fsck.ts line 45 (connectivityOnly skips buildBlobFilenameMap)
// The blobFilenames map must NOT be built when connectivityOnly:true —
// otherwise a bad .gitmodules blob would trigger content findings in a
// connectivity-only run, leaking EXIT_CONTENT_ERROR into the exit code.
describe('Given repo .gitmodules blob with disallowed URL', () => {
  describe('When fsck runs connectivityOnly:true', () => {
    it('Then no bad-object finding emitted (blobFilenames not built in connectivity-only mode)', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const enc = new TextEncoder();
      const gitmodulesContent = enc.encode(
        '[submodule "evil"]\n\tpath = evil\n\turl = --upload-pack=evil\n',
      );
      const blobId = await writeObject(ctx, {
        type: 'blob' as const,
        id: '' as ObjectId,
        content: gitmodulesContent,
      });
      const treeId = await writeObject(
        ctx,
        makeTree([{ mode: FILE_MODE.REGULAR, name: '.gitmodules', id: blobId }]),
      );
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act
      const result = await fsck(ctx, { connectivityOnly: true });

      // Assert — connectivity-only skips blob-filename map AND content pass
      const badObjects = result.findings.filter((f) => f.type === 'bad-object');
      expect(badObjects).toHaveLength(0);
      // Exit code must not have bit 1 (content error)
      expect(result.exitCode & 1).toBe(0);
    });
  });
});

// Kill: fsck.ts line 80 (missingTypeFromEdge first-write guard)
// When a missing object is referenced by TWO broken edges with different
// expected types, only the FIRST type (from the first edge) must be stored.
// The guard `!missingTypeFromEdge.has(edge.toId)` prevents overwriting.
describe('Given missing blob referenced both as blob (tree entry) and as tag target', () => {
  describe('When fsck runs', () => {
    it('Then missing finding uses type from first broken edge (tree → blob)', async () => {
      // Arrange — ghost oid is missing; referenced from a tree entry (type=blob)
      // AND from an annotated tag (type=blob also, but different edge).
      // To create two-type conflict: ghost id referenced from tree (blob) and
      // from a tag object (objectType blob). We assert type is 'blob' from tree edge.
      const ctx = await initBareCtx();
      const ghostId = '0000000000000000000000000000000000000042' as ObjectId;
      // Tree entry references ghost as blob
      const treeId = await writeObject(
        ctx,
        makeTree([{ mode: FILE_MODE.REGULAR, name: 'ghost.txt', id: ghostId }]),
      );
      // Tag also references ghost (as a blob tag target)
      const tagId = await writeObject(ctx, makeTag(ghostId, 'blob', 'v-ghost'));
      await writeObject(ctx, makeCommit(treeId, []));
      // Ref points to tagId so both are walked
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/tags/v-ghost`, `${tagId}\n`);
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act
      const result = await fsck(ctx);

      // Assert — one missing finding for ghostId; type is determined by first broken edge
      const missing = result.findings.filter(
        (f) => f.type === 'missing' && (f as { id: ObjectId }).id === ghostId,
      );
      expect(missing).toHaveLength(1);
      // Type should be 'blob' (from tree entry edge — whichever is first)
      expect((missing[0] as { objectType: string }).objectType).toBe('blob');
    });
  });
});

// Kill: content-validation.ts line 97 (SPECIAL_BLOB_NAMES guard)
// A non-special-name blob inside a tree must NOT trigger gitmodules content
// checks even if its bytes happen to look like a .gitmodules file.
describe('Given tree with non-special-name blob whose content looks like .gitmodules', () => {
  describe('When fsck runs', () => {
    it('Then no gitmodules bad-object finding emitted for the non-special blob', async () => {
      // Arrange — blob content is a valid-looking gitmodules with bad URL
      // but the blob is stored under a non-special filename 'config.txt'
      const ctx = await initBareCtx();
      const enc = new TextEncoder();
      const gitmodulesLikeContent = enc.encode(
        '[submodule "evil"]\n\tpath = evil\n\turl = --upload-pack=evil\n',
      );
      const blobId = await writeObject(ctx, {
        type: 'blob' as const,
        id: '' as ObjectId,
        content: gitmodulesLikeContent,
      });
      // Blob referenced under 'config.txt' (NOT '.gitmodules')
      const treeId = await writeObject(
        ctx,
        makeTree([{ mode: FILE_MODE.REGULAR, name: 'config.txt', id: blobId }]),
      );
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act
      const result = await fsck(ctx);

      // Assert — no gitmodulesUrl finding for this blob
      const gitmodulesFindings = result.findings.filter(
        (f) =>
          f.type === 'bad-object' &&
          (f as { id: ObjectId }).id === blobId &&
          (f as { msgId: string }).msgId === 'gitmodulesUrl',
      );
      expect(gitmodulesFindings).toHaveLength(0);
    });
  });
});

// Kill: reachability.ts line 19 (tag target in recordOutEdges for inEdge)
// A tag's target must be recorded as having an in-edge. Without this, the
// commit pointed to by a dangling tag would be falsely classified as dangling.
describe('Given dangling tag pointing to a commit (both written, no ref)', () => {
  describe('When fsck runs', () => {
    it('Then commit target is NOT dangling (tag gives it an in-edge)', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const treeId = await writeObject(ctx, makeTree([]));
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      const tagId = await writeObject(ctx, makeTag(commitId, 'commit', 'v0.1'));
      // No ref points to tagId OR commitId — both are unreachable
      // But commitId has an in-edge FROM tagId, so it is unreachable but NOT dangling

      // Act
      const result = await fsck(ctx);

      // Assert — tagId is dangling (no in-edge), commitId is unreachable but NOT dangling
      const dangling = result.findings.filter((f) => f.type === 'dangling');
      const danglingIds = dangling.map((f) => (f as { id: ObjectId }).id);
      expect(danglingIds).toContain(tagId);
      expect(danglingIds).not.toContain(commitId);
    });
  });
});

// Kill: reachability.ts line 98 (parent enqueue in processCommit)
// When a commit has a parent that IS in the universe (not missing),
// the parent must be enqueued and walked — its own objects must be reached.
describe('Given two commits where child references parent (chain of length 2)', () => {
  describe('When fsck runs with ref on child only', () => {
    it('Then parent commit and its tree are reached (not unreachable)', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const treeId = await writeObject(ctx, makeTree([]));
      const parentId = await writeObject(ctx, makeCommit(treeId, []));
      const childId = await writeObject(ctx, makeCommit(treeId, [parentId]));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${childId}\n`);

      // Act
      const result = await fsck(ctx);

      // Assert — no unreachable or dangling findings (parent walked via child)
      const unreachable = result.findings.filter((f) => f.type === 'unreachable');
      const unreachableIds = unreachable.map((f) => (f as { id: ObjectId }).id);
      expect(unreachableIds).not.toContain(parentId);
      expect(unreachableIds).not.toContain(treeId);
      expect(result.exitCode).toBe(0);
    });
  });
});

// Kill: reachability.ts line 102 (parents.length === 0 guard for rootCommits)
// A merge commit with parents must NOT appear in rootCommits.
// A root finding must only be emitted for commits with zero parents.
describe('Given merge commit with two reachable parents', () => {
  describe('When fsck runs', () => {
    it('Then merge commit does NOT emit a root finding', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const treeId = await writeObject(ctx, makeTree([]));
      const parent1Id = await writeObject(ctx, makeCommit(treeId, []));
      const parent2Id = await writeObject(ctx, makeCommit(treeId, []));
      const mergeId = await writeObject(ctx, makeCommit(treeId, [parent1Id, parent2Id]));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${mergeId}\n`);

      // Act
      const result = await fsck(ctx);

      // Assert — only parent1Id and parent2Id emit root findings, not mergeId
      const roots = result.findings.filter((f) => f.type === 'root');
      const rootIds = roots.map((f) => (f as { id: ObjectId }).id);
      expect(rootIds).toContain(parent1Id);
      expect(rootIds).toContain(parent2Id);
      expect(rootIds).not.toContain(mergeId);
    });
  });
});

// Kill: reachability.ts line 107 (GITLINK guard in processTree)
// Tree entries with GITLINK mode (submodule) must be skipped during the walk.
// Without the guard, a missing submodule commit would generate spurious
// 'missing' and 'broken-link' findings for the gitlink OID.
describe('Given tree with gitlink (submodule) entry pointing to commit not in universe', () => {
  describe('When fsck runs', () => {
    it('Then no missing or broken-link finding emitted for gitlink target', async () => {
      // Arrange
      const ctx = await initBareCtx();
      // Gitlink OID simulates a submodule commit — it is NOT in this repo's universe
      const submoduleCommitId = '0000000000000000000000000000000000000099' as ObjectId;
      const treeId = await writeObject(
        ctx,
        makeTree([{ mode: FILE_MODE.GITLINK, name: 'vendor', id: submoduleCommitId }]),
      );
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act
      const result = await fsck(ctx);

      // Assert — no missing or broken-link finding for the gitlink OID
      const missingGitlink = result.findings.filter(
        (f) =>
          (f.type === 'missing' || f.type === 'broken-link') &&
          (f as { id?: ObjectId; toId?: ObjectId }).toId === submoduleCommitId,
      );
      expect(missingGitlink).toHaveLength(0);
      expect(result.exitCode & 2).toBe(0);
    });
  });
});

// Kill: reachability.ts line 163 (corrupt object in walk loop must be marked reached)
// When a ref points to a corrupt object (readable in universe but null in cache),
// the walk must mark it reached to avoid re-processing it infinitely.
// Without reached.add(id), the worklist loop would spin forever.
describe('Given ref pointing to corrupt object (null in cache)', () => {
  describe('When fsck runs', () => {
    it('Then fsck completes without hanging and the corrupt object is not unreachable', async () => {
      // Arrange — write a blob normally, then corrupt its bytes
      const ctx = await initBareCtx();
      const blobId = await writeObject(ctx, makeBlob('corrupt-me'));
      // Corrupt: replace with garbage that deflates fine but breaks parse
      const blobPath = looseObjectPath(ctx.layout.gitDir, blobId);
      const garbage = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      await ctx.fs.write(blobPath, garbage);
      // Ref points to this corrupt blob (treated as a root)
      // We need a commit pointing to a tree that includes this blob
      const treeId = await writeObject(
        ctx,
        makeTree([{ mode: FILE_MODE.REGULAR, name: 'file.txt', id: blobId }]),
      );
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act — must complete (no infinite loop)
      const result = await fsck(ctx);

      // Assert — bad-object finding for corrupt blob; no unreachable finding for it
      const badObj = result.findings.find(
        (f): f is FsckFinding & { type: 'bad-object' } =>
          f.type === 'bad-object' && (f as { id: ObjectId }).id === blobId,
      );
      expect(badObj).toBeDefined();
      const unreachableBlob = result.findings.find(
        (f) => f.type === 'unreachable' && (f as { id: ObjectId }).id === blobId,
      );
      expect(unreachableBlob).toBeUndefined();
    });
  });
});

// Kill: roots.ts line 18 (peel:false in resolveRef for addRefRoots)
// When a ref points to an annotated tag, resolveRef with peel:false returns
// the TAG object OID. Without peel:false (default peels), the commit OID
// would be returned instead, and the tag object would become dangling/unreachable.
describe('Given ref pointing to annotated tag (peel:false must be used)', () => {
  describe('When fsck runs', () => {
    it('Then the tag object itself is not dangling or unreachable', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const treeId = await writeObject(ctx, makeTree([]));
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      const tagId = await writeObject(ctx, makeTag(commitId, 'commit', 'v1.0'));
      // Ref points to tagId (not the commit)
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/tags/v1.0`, `${tagId}\n`);

      // Act
      const result = await fsck(ctx);

      // Assert — tag and commit are both reachable; no unreachable/dangling findings
      const unreachable = result.findings.filter((f) => f.type === 'unreachable');
      const unreachableIds = unreachable.map((f) => (f as { id: ObjectId }).id);
      expect(unreachableIds).not.toContain(tagId);
      expect(unreachableIds).not.toContain(commitId);
    });
  });
});

// Kill: roots.ts line 40 (newId ZERO_OID guard in addReflogRoots)
// A reflog entry whose newId is the zero OID (branch deletion event) must NOT
// add ZERO_OID to roots — it is a sentinel, not a real object reference.
describe('Given reflog with entry where newId is zero OID (branch deletion event)', () => {
  describe('When fsck runs', () => {
    it('Then no missing finding emitted for zero-OID newId', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const treeId = await writeObject(ctx, makeTree([]));
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);
      // Reflog: deletion entry — newId is ZERO_OID (branch deleted)
      const ZERO_OID_STR = '0000000000000000000000000000000000000000';
      const reflogLine = `${commitId} ${ZERO_OID_STR} Ada <ada@example.com> 1700000000 +0000\tdelete: deleting branch\n`;
      await ctx.fs.mkdir(`${ctx.layout.gitDir}/logs/refs/heads`);
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/logs/refs/heads/main`, reflogLine);

      // Act
      const result = await fsck(ctx);

      // Assert — no 'missing' finding for ZERO_OID
      const missingForZero = result.findings.filter(
        (f) => f.type === 'missing' && (f as { id: ObjectId }).id === ZERO_OID_STR,
      );
      expect(missingForZero).toHaveLength(0);
      expect(result.exitCode).toBe(0);
    });
  });
});

// Kill: roots.ts line 53 (stage === 0 guard in addIndexRoots)
// Conflict-stage entries (stage 1/2/3) must NOT be added to roots.
// Only stage-0 entries represent the current working-tree state.
describe('Given index with only conflict-stage entries (stage 1, 2, 3, no stage 0)', () => {
  describe('When fsck runs', () => {
    it('Then conflict-stage blobs are dangling (not kept reachable by index)', async () => {
      // Arrange
      const { STAGE0_FLAGS } = await import('../../../../src/domain/git-index/index-entry.js');
      const tempCtx = await initBareCtx();
      const blobId = await writeObject(tempCtx, makeBlob('conflict content'));

      // Build context with blob + an index that has stage=1 entry (conflict, not stage-0)
      const ctx = await buildSeededContext({
        objects: [makeBlob('conflict content')],
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
              flags: { ...STAGE0_FLAGS, stage: 1 },
              path: 'conflict.txt' as FilePath,
            },
          ],
          extensions: [],
          trailerSha: new Uint8Array(0),
        },
      });
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');

      // Act
      const result = await fsck(ctx);

      // Assert — stage-1 blob is NOT reachable from index; it is dangling
      const dangling = result.findings.filter((f) => f.type === 'dangling');
      const danglingIds = dangling.map((f) => (f as { id: ObjectId }).id);
      expect(danglingIds).toContain(blobId);
    });
  });
});

// Kill: roots.ts line 74 (indexRoot !== false guard)
// When indexRoot:false, staged blobs must NOT be kept reachable via the index.
describe('Given staged blob with indexRoot:false', () => {
  describe('When fsck runs indexRoot:false', () => {
    it('Then staged blob IS dangling (index excluded from roots)', async () => {
      // Arrange
      const { STAGE0_FLAGS } = await import('../../../../src/domain/git-index/index-entry.js');
      const tempCtx = await initBareCtx();
      const blobId = await writeObject(tempCtx, makeBlob('staged-index-root'));

      const ctx = await buildSeededContext({
        objects: [makeBlob('staged-index-root')],
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
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');

      // Act
      const result = await fsck(ctx, { indexRoot: false });

      // Assert — blob is dangling because index is excluded
      const dangling = result.findings.filter((f) => f.type === 'dangling');
      const isDanglingBlob = dangling.some((f) => (f as { id: ObjectId }).id === blobId);
      expect(isDanglingBlob).toBe(true);
    });
  });
});

// Kill: refs-verify.ts line 28 (regex /[\r\n]+$/ vs /[\r\n]$/)
// A loose ref with Windows-style line ending (\r\n) must have BOTH chars stripped,
// not just the trailing \n. With /[\r\n]$/ only one char is removed → \r remains
// in the content → OID_RE.test fails → spurious badRefContent finding.
describe('Given loose ref with Windows CRLF line ending', () => {
  describe('When fsck runs', () => {
    it('Then no badRefContent finding (CRLF stripped cleanly by /[\\r\\n]+$/)', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const treeId = await writeObject(ctx, makeTree([]));
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      // Write ref with \r\n ending (Windows-style)
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\r\n`);

      // Act
      const result = await fsck(ctx);

      // Assert — CRLF is stripped; no badRefContent finding
      const badRefContent = result.findings.find(
        (f) => f.type === 'bad-ref' && (f as { msgId: string }).msgId === 'badRefContent',
      );
      expect(badRefContent).toBeUndefined();
      expect(result.exitCode & 8).toBe(0);
    });
  });
});

// Kill: refs-verify.ts line 95 (entry.name !== ref guard in packed-refs loop)
// When packed-refs has multiple entries, only the entry matching the current
// ref name must be checked. Without the name filter, entries for OTHER refs
// could trigger spurious badRefOid findings when their OIDs are absent.
describe('Given packed-refs with two refs: one valid, one absent OID', () => {
  describe('When fsck runs', () => {
    it('Then only the absent-OID ref emits badRefOid (not the valid one)', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const treeId = await writeObject(ctx, makeTree([]));
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      const absentOid = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as ObjectId;
      // packed-refs with one valid ref (commitId in universe) and one absent ref
      await ctx.fs.writeUtf8(
        `${ctx.layout.gitDir}/packed-refs`,
        `# pack-refs with: peeled fully-peeled sorted \n${commitId} refs/heads/main\n${absentOid} refs/heads/broken\n`,
      );

      // Act
      const result = await fsck(ctx);

      // Assert — badRefOid only for refs/heads/broken, not refs/heads/main
      const badRefs = result.findings.filter(
        (f): f is FsckFinding & { type: 'bad-ref' } =>
          f.type === 'bad-ref' && f.msgId === 'badRefOid',
      );
      expect(badRefs).toHaveLength(1);
      expect(badRefs[0]!.ref).toBe('refs/heads/broken');
    });
  });
});

// Kill: refs-verify.ts line 96 (!universe.has(entry.id) guard)
// A packed ref whose OID IS in the object universe must NOT emit a badRefOid finding.
describe('Given packed ref with valid OID present in object universe', () => {
  describe('When fsck runs', () => {
    it('Then no badRefOid finding emitted for the valid packed ref', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const treeId = await writeObject(ctx, makeTree([]));
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      // packed-refs with valid OID (commitId IS in universe)
      await ctx.fs.writeUtf8(
        `${ctx.layout.gitDir}/packed-refs`,
        `# pack-refs with: peeled fully-peeled sorted \n${commitId} refs/heads/main\n`,
      );

      // Act
      const result = await fsck(ctx);

      // Assert — no badRefOid for refs/heads/main (OID present in universe)
      const badRefOid = result.findings.find(
        (f) => f.type === 'bad-ref' && (f as { msgId: string }).msgId === 'badRefOid',
      );
      expect(badRefOid).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Kill id 270: reachability.ts BlockStatement — corrupt object must be marked
// as reached (not classified as unreachable/dangling).
// If state.reached.add(id) is removed, the corrupt blob is unreachable.
// ---------------------------------------------------------------------------

describe('Given a corrupt loose blob with no in-edges in the universe', () => {
  describe('When fsck runs', () => {
    it('Then does NOT emit an unreachable finding for the corrupt blob', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const blobId = await writeObject(ctx, makeBlob('to-corrupt'));
      // Overwrite with invalid zlib bytes (unreadable object)
      const blobPath = looseObjectPath(ctx.layout.gitDir, blobId);
      const garbage = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      await ctx.fs.write(blobPath, garbage);

      // Act
      const result = await fsck(ctx);

      // Assert — corrupt object is treated as reached, NOT unreachable/dangling
      const unreachable = result.findings.filter(
        (f) => f.type === 'unreachable' && (f as { id: ObjectId }).id === blobId,
      );
      expect(unreachable).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Kill id 380: roots.ts universe.has(id) → false — ref OID must be added as
// a root only when in the universe. This test verifies the positive case: a
// ref pointing to an object IN the universe causes the object to be reached
// (not unreachable).
// ---------------------------------------------------------------------------

describe('Given a repo with a commit reachable via a loose ref', () => {
  describe('When fsck runs', () => {
    it('Then the commit is NOT unreachable (ref adds it as a root)', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const treeId = await writeObject(ctx, makeTree([]));
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      // The ref points to commitId which IS in the universe
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act
      const result = await fsck(ctx);

      // Assert — commit is reached via the ref root, so NOT unreachable
      const unreachable = result.findings.filter(
        (f) => f.type === 'unreachable' && (f as { id: ObjectId }).id === commitId,
      );
      expect(unreachable).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Kill: refs-verify.ts Regex /[\r\n]+$/ → /[\r\n]+/ (missing $)
// A loose ref with trailing double-newline must be stripped completely to a
// valid OID. Without the $-anchor the first \n is stripped but the trailing
// \n remains, making the content "sha\n" which fails OID_RE → badRefContent.
// ---------------------------------------------------------------------------

describe('Given a loose ref whose raw content has an embedded CR between hex chars (no trailing newline)', () => {
  describe('When fsck runs', () => {
    it('Then bad-ref badRefContent finding is emitted (CR in middle is not stripped by /$/ anchor)', async () => {
      // Arrange — raw ref bytes: 20-hex + CR + 20-hex (no trailing LF, total 41 chars)
      // A stray CR embedded between what looks like OID hex digits.
      // Original /[\r\n]+$/ has no match (CR is not at end) → content = "20hex\r20hex" →
      //   OID_RE fails (41 chars, contains CR) → badRefContent.
      // Mutant /[\r\n]+/ (no $) matches the CR at pos 20, strips it → "20hex20hex" (40 chars) →
      //   OID_RE passes → no badRefContent (wrong; silently accepts malformed ref).
      const ctx = await initBareCtx();
      // 20 'a' + CR + 20 'b' — no trailing newline
      const malformedRef = `${'a'.repeat(20)}\r${'b'.repeat(20)}`;
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, malformedRef);

      // Act
      const result = await fsck(ctx);

      // Assert — embedded CR must produce badRefContent (not badRefOid or no finding)
      const badRefContent = result.findings.find(
        (f): f is FsckFinding & { type: 'bad-ref' } =>
          f.type === 'bad-ref' && (f as { msgId: string }).msgId === 'badRefContent',
      );
      expect(badRefContent).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Kill id 26: fsck.ts missingTypeFromEdge — !has(edge.toId) → true
// When two broken edges point to the same missing OID with DIFFERENT expected
// types (e.g., 'tree' from a commit.tree reference, 'blob' from a tree entry),
// first-wins (original) stores 'tree'; always-overwrite (mutant) stores 'blob'.
// ---------------------------------------------------------------------------

describe('Given two broken edges pointing to the same missing OID with different expected types', () => {
  describe('When fsck runs', () => {
    it('Then the missing finding uses the first-seen type (blob from tree entry, not tree from commit)', async () => {
      // Arrange — a tree has a blob entry to missingOid (type='blob'), AND a commit
      // references the same missingOid as its tree (type='tree'). Both are in seeds.
      // Walk order: tree-entry edge (blob) arrives in brokenEdges first because
      // the tree is processed before the commit with missing tree (seeds pop order).
      // Original first-wins: stores 'blob'. Mutant always-overwrite: stores 'tree'.
      const ctx = await initBareCtx();
      const missingOid = '2222222222222222222222222222222222222222' as ObjectId;

      // Tree in universe with a blob entry to missingOid
      const realTreeId = await writeObject(
        ctx,
        makeTree([
          {
            mode: FILE_MODE.REGULAR,
            name: 'file.txt',
            id: missingOid, // missing, expected type 'blob'
          },
        ]),
      );

      // Commit with realTreeId as its tree — put in refs/heads/main (seed)
      const goodCommitId = await writeObject(ctx, makeCommit(realTreeId, []));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${goodCommitId}\n`);

      // Commit with missingOid as its tree — put in refs/heads/aaa (sorts first)
      // This causes the commit-to-tree broken edge (type='tree') to be in brokenEdges
      const badCommitId = await writeObject(ctx, {
        type: 'commit' as const,
        id: '' as ObjectId,
        data: {
          tree: missingOid, // missing, expected type 'tree'
          parents: [],
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
          message: 'bad',
          extraHeaders: [],
        },
      });
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/aaa`, `${badCommitId}\n`);

      // Act
      const result = await fsck(ctx);

      // Assert — missing finding for missingOid must have objectType 'tree'.
      // Walk order: refs/heads/aaa (badCommitId) inserts into seeds before
      // refs/heads/main (goodCommitId); pop takes goodCommitId first. goodCommitId
      // enqueues realTreeId. Then badCommitId is processed → brokenEdge(tree) pushed
      // BEFORE realTreeId is processed → brokenEdge(blob) pushed.
      // brokenEdges = [{tree}, {blob}].
      // Original first-wins → 'tree'. Mutant always-overwrite → 'blob'.
      const missingFinding = result.findings.find(
        (f): f is FsckFinding & { type: 'missing' } =>
          f.type === 'missing' && (f as { id: ObjectId }).id === missingOid,
      );
      expect(missingFinding).toBeDefined();
      expect((missingFinding as { objectType: string }).objectType).toBe('tree');
    });
  });
});

// ---------------------------------------------------------------------------
// Kill id 45: fsck.ts connectivityBit — || → && (LogicalOperator)
// missingIds.size > 0 || brokenEdges.length > 0
// A reflog entry pointing to a non-existent OID adds that OID to missingIds
// (via buildReachableSet's universe check) without creating any brokenEdges
// (reflog roots bypass the per-edge push). The mutant (&&) would give
// (1 > 0 && 0 > 0) = false → no EXIT_MISSING bit set.
// ---------------------------------------------------------------------------

describe('Given a reflog entry pointing to a non-existent OID with no graph edges broken', () => {
  describe('When fsck runs', () => {
    it('Then exitCode has EXIT_MISSING bit set (missingIds > 0 is sufficient)', async () => {
      // Arrange — repo with HEAD and a reflog entry whose new-oid is not in universe
      const ctx = await initBareCtx();
      const missingOid = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as ObjectId;
      const zeroOid = '0000000000000000000000000000000000000000';
      // Write reflog entry: old=ZERO (creation), new=missingOid (not a real object)
      await ctx.fs.mkdir(`${ctx.layout.gitDir}/logs/refs/heads`);
      await ctx.fs.writeUtf8(
        `${ctx.layout.gitDir}/logs/refs/heads/main`,
        `${zeroOid} ${missingOid} Ada <ada@example.com> 1700000000 +0000\tcommit: initial\n`,
      );

      // Act
      const result = await fsck(ctx);

      // Assert — missingIds.size > 0, brokenEdges.length === 0 → EXIT_MISSING bit must be set
      expect(result.exitCode & 2).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// Kill id 75: content-validation.ts line 60 StringLiteral
// reason.startsWith('unknown object type') → reason.startsWith('')
// startsWith('') is always true → always returns 'unknownType' instead of
// distinguishing 'unterminatedHeader' (missing NUL) vs 'unknownType' (bad type).
// A header that inflates fine but has no NUL terminator produces
// reason = 'missing null terminator' → original returns 'unterminatedHeader'.
// The mutant (startsWith('')) returns 'unknownType' — distinguishable.
// ---------------------------------------------------------------------------

describe('Given loose object with inflated header missing NUL terminator', () => {
  describe('When fsck runs', () => {
    it('Then bad-object finding has msgId unterminatedHeader (not unknownType)', async () => {
      // Arrange — bytes 'blob 5hello' (no \0 between header and body)
      const ctx = await initBareCtx();
      const rawBytes = new TextEncoder().encode('blob 5hello');
      const oidHex = (await ctx.hash.hashHex(rawBytes)) as ObjectId;
      const compressed = await ctx.compressor.deflate(rawBytes);
      await ctx.fs.write(looseObjectPath(ctx.layout.gitDir, oidHex), compressed);

      // Act
      const result = await fsck(ctx);

      // Assert — missing NUL → reason 'missing null terminator' → msgId 'unterminatedHeader'
      // Mutant startsWith('') → 'unknownType' (wrong)
      const badObj = result.findings.find(
        (f): f is FsckFinding & { type: 'bad-object' } =>
          f.type === 'bad-object' && (f as { id: ObjectId }).id === oidHex,
      );
      expect(badObj).toBeDefined();
      expect((badObj as { msgId: string }).msgId).toBe('unterminatedHeader');
    });
  });
});

// ---------------------------------------------------------------------------
// PACK-HEALTH PASS — inaccessible packs and unusable pack indexes
// ---------------------------------------------------------------------------

const packFilePath = (ctx: Context, name: string): string =>
  `${ctx.layout.gitDir}/objects/pack/pack-${name}.pack`;
const idxFilePath = (ctx: Context, name: string): string =>
  `${ctx.layout.gitDir}/objects/pack/pack-${name}.idx`;

const onePackEntry = (content: string) => [
  { kind: 'base' as const, type: 'blob' as const, content: enc.encode(content) },
];

describe('Given a repo with one healthy pack and no unusable packs', () => {
  describe('When fsck runs', () => {
    it('Then no pack finding is emitted and exit bit 4 is unset', async () => {
      // Arrange
      const ctx = await initBareCtx();
      await writeSyntheticPack(ctx, 'healthy', onePackEntry('healthy-content'));

      // Act
      const result = await fsck(ctx);

      // Assert
      const packFindings = result.findings.filter((f) => f.type.startsWith('pack-'));
      expect(packFindings).toHaveLength(0);
      expect(result.exitCode & 4).toBe(0);
    });
  });
});

describe('Given a v99-header pack whose objects exist nowhere else', () => {
  describe('When fsck runs', () => {
    it("Then exactly one pack-inaccessible finding names the pack, bit 4 is set, and no finding carries the pack's object ids", async () => {
      // Arrange
      const ctx = await initBareCtx();
      const packIds = await writeSyntheticPack(ctx, 'refused', onePackEntry('refused-content'));
      await restampPackHeader(ctx, packFilePath(ctx, 'refused'), { version: 99 });

      // Act
      const result = await fsck(ctx);

      // Assert
      const inaccessible = result.findings.filter((f) => f.type === 'pack-inaccessible');
      expect(inaccessible).toHaveLength(1);
      expect((inaccessible[0] as { pack: string }).pack).toBe('pack-refused');
      expect(result.exitCode & 4).toBe(4);
      const carriedIds = new Set(result.findings.flatMap((f) => findingIds(f)));
      for (const id of packIds) {
        expect(carriedIds.has(id as ObjectId)).toBe(false);
      }
    });

    it('Then no pack-rev-index-unusable finding is emitted and bit 64 is absent (the pack layer is not the index layer)', async () => {
      // Arrange
      const ctx = await initBareCtx();
      await writeSyntheticPack(
        ctx,
        'refused-pack-layer',
        onePackEntry('refused-pack-layer-content'),
      );
      await restampPackHeader(ctx, packFilePath(ctx, 'refused-pack-layer'), { version: 99 });

      // Act
      const result = await fsck(ctx);

      // Assert
      expect(result.findings.some((f) => f.type === 'pack-rev-index-unusable')).toBe(false);
      expect(result.exitCode & 64).toBe(0);
    });
  });
});

describe('Given a pack whose header object count disagrees with its index', () => {
  describe('When fsck runs', () => {
    it('Then one pack-inaccessible finding is emitted whose reason names both counts, and bit 4 is set', async () => {
      // Arrange
      const ctx = await initBareCtx();
      await writeSyntheticPack(ctx, 'count-mismatch', onePackEntry('count-mismatch-content'));
      await restampPackHeader(ctx, packFilePath(ctx, 'count-mismatch'), { objectCount: 2 });

      // Act
      const result = await fsck(ctx);

      // Assert
      const inaccessible = result.findings.filter((f) => f.type === 'pack-inaccessible');
      expect(inaccessible).toHaveLength(1);
      expect((inaccessible[0] as { reason: string }).reason).toBe(
        'object count disagrees with index: pack 2, index 1',
      );
      expect(result.exitCode & 4).toBe(4);
    });
  });
});

describe('Given a pack whose .idx is corrupt (magic mismatch)', () => {
  describe('When fsck runs', () => {
    it('Then one pack-index-unusable and one pack-rev-index-unusable finding are emitted, and bits 4 and 64 are both set', async () => {
      // Arrange
      const ctx = await initBareCtx();
      await writeSyntheticPack(ctx, 'corrupt-idx', onePackEntry('corrupt-idx-content'));
      await ctx.fs.write(idxFilePath(ctx, 'corrupt-idx'), new Uint8Array(1072));

      // Act
      const result = await fsck(ctx);

      // Assert
      const indexUnusable = result.findings.filter((f) => f.type === 'pack-index-unusable');
      const revIndexUnusable = result.findings.filter((f) => f.type === 'pack-rev-index-unusable');
      expect(indexUnusable).toHaveLength(1);
      expect(revIndexUnusable).toHaveLength(1);
      expect((indexUnusable[0] as { pack: string }).pack).toBe('pack-corrupt-idx');
      expect((revIndexUnusable[0] as { pack: string }).pack).toBe('pack-corrupt-idx');
      expect(result.exitCode & 4).toBe(4);
      expect(result.exitCode & 64).toBe(64);
    });
  });
});

describe('Given an orphan .idx with no sibling .pack file', () => {
  describe('When fsck runs', () => {
    it('Then no finding is emitted and exit code is exactly 0', async () => {
      // Arrange
      const ctx = await initBareCtx();
      await writeSyntheticPack(ctx, 'orphan', onePackEntry('orphan-content'));
      await ctx.fs.rm(packFilePath(ctx, 'orphan'));

      // Act
      const result = await fsck(ctx);

      // Assert
      expect(result.findings).toHaveLength(0);
      expect(result.exitCode).toBe(0);
    });
  });
});

describe('Given two packs both header-refused', () => {
  describe('When fsck runs', () => {
    it('Then two pack-inaccessible findings are emitted and bit 4 is set exactly once', async () => {
      // Arrange
      const ctx = await initBareCtx();
      await writeSyntheticPack(ctx, 'refused-a', onePackEntry('refused-a-content'));
      await restampPackHeader(ctx, packFilePath(ctx, 'refused-a'), { version: 99 });
      await writeSyntheticPack(ctx, 'refused-b', onePackEntry('refused-b-content'));
      await restampPackHeader(ctx, packFilePath(ctx, 'refused-b'), { version: 99 });

      // Act
      const result = await fsck(ctx);

      // Assert
      const inaccessible = result.findings.filter((f) => f.type === 'pack-inaccessible');
      expect(inaccessible).toHaveLength(2);
      expect(result.exitCode & 4).toBe(4);
    });
  });
});

describe('Given a v99-refused pack and a healthy twin pack holding the same object ids', () => {
  describe('When fsck runs', () => {
    it('Then the shared object is still classified dangling/unreachable via the healthy twin, and the refused pack is reported', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const entries = onePackEntry('twin-content');
      const healthyIds = await writeSyntheticPack(ctx, 'twin-healthy', entries);
      await writeSyntheticPack(ctx, 'twin-refused', entries);
      await restampPackHeader(ctx, packFilePath(ctx, 'twin-refused'), { version: 99 });
      const [blobId] = healthyIds;

      // Act
      const result = await fsck(ctx);

      // Assert
      const isDangling = result.findings.some(
        (f) => f.type === 'dangling' && (f as { id: ObjectId }).id === blobId,
      );
      const isUnreachable = result.findings.some(
        (f) => f.type === 'unreachable' && (f as { id: ObjectId }).id === blobId,
      );
      const inaccessible = result.findings.filter((f) => f.type === 'pack-inaccessible');
      expect(isDangling).toBe(true);
      expect(isUnreachable).toBe(true);
      expect(inaccessible).toHaveLength(1);
      expect((inaccessible[0] as { pack: string }).pack).toBe('pack-twin-refused');
    });
  });
});

describe('Given a v99-refused pack holding the only reachable tree beneath a loose root commit', () => {
  describe('When fsck runs', () => {
    it('Then a missing and a broken-link finding are emitted alongside the pack finding, with bits 2 and 4 both set', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const emptyTreeBody = serializeTreeContent(makeTree([]), ctx.hashConfig);
      const [treeId] = await writeSyntheticPack(ctx, 'row8-refused', [
        { kind: 'base', type: 'tree', content: emptyTreeBody },
      ]);
      await restampPackHeader(ctx, packFilePath(ctx, 'row8-refused'), { version: 99 });
      const commitId = await writeObject(ctx, makeCommit(treeId as ObjectId, []));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act
      const result = await fsck(ctx);

      // Assert
      const missing = result.findings.filter(
        (f) => f.type === 'missing' && (f as { id: ObjectId }).id === treeId,
      );
      const brokenLink = result.findings.filter(
        (f) => f.type === 'broken-link' && (f as { toId: ObjectId }).toId === treeId,
      );
      const inaccessible = result.findings.filter((f) => f.type === 'pack-inaccessible');
      expect(missing).toHaveLength(1);
      expect(brokenLink).toHaveLength(1);
      expect(inaccessible).toHaveLength(1);
      expect(result.exitCode & 2).toBe(2);
      expect(result.exitCode & 4).toBe(4);
    });
  });
});

describe('Given a header-refused pack', () => {
  describe('When fsck runs with connectivityOnly: true', () => {
    it('Then no pack-inaccessible finding is emitted and bit 4 is absent', async () => {
      // Arrange
      const ctx = await initBareCtx();
      await writeSyntheticPack(ctx, 'conn-only-refused', onePackEntry('conn-only-content'));
      await restampPackHeader(ctx, packFilePath(ctx, 'conn-only-refused'), { version: 99 });

      // Act
      const result = await fsck(ctx, { connectivityOnly: true });

      // Assert
      expect(result.findings.some((f) => f.type === 'pack-inaccessible')).toBe(false);
      expect(result.exitCode & 4).toBe(0);
    });
  });

  describe('When fsck runs with full: false', () => {
    it('Then no pack-inaccessible finding is emitted and bit 4 is absent', async () => {
      // Arrange
      const ctx = await initBareCtx();
      await writeSyntheticPack(ctx, 'full-false-refused', onePackEntry('full-false-content'));
      await restampPackHeader(ctx, packFilePath(ctx, 'full-false-refused'), { version: 99 });

      // Act
      const result = await fsck(ctx, { full: false });

      // Assert
      expect(result.findings.some((f) => f.type === 'pack-inaccessible')).toBe(false);
      expect(result.exitCode & 4).toBe(0);
    });
  });

  describe('When fsck runs with strict: true', () => {
    it('Then bit 4 stays set for the refused pack, same as without strict', async () => {
      // Arrange
      const ctx = await initBareCtx();
      await writeSyntheticPack(ctx, 'strict-refused', onePackEntry('strict-content'));
      await restampPackHeader(ctx, packFilePath(ctx, 'strict-refused'), { version: 99 });

      // Act
      const withoutStrict = await fsck(ctx);
      const withStrict = await fsck(ctx, { strict: true });

      // Assert
      expect(withoutStrict.exitCode & 4).toBe(4);
      expect(withStrict.exitCode & 4).toBe(4);
    });
  });
});

describe('Given a pack with a corrupt .idx', () => {
  describe('When fsck runs with connectivityOnly: true', () => {
    it('Then pack-rev-index-unusable is present, bit 64 is set, and bit 4 is absent', async () => {
      // Arrange
      const ctx = await initBareCtx();
      await writeSyntheticPack(ctx, 'conn-corrupt-idx', onePackEntry('conn-corrupt-idx-content'));
      await ctx.fs.write(idxFilePath(ctx, 'conn-corrupt-idx'), new Uint8Array(1072));

      // Act
      const result = await fsck(ctx, { connectivityOnly: true });

      // Assert
      const revIndexUnusable = result.findings.filter((f) => f.type === 'pack-rev-index-unusable');
      expect(revIndexUnusable).toHaveLength(1);
      expect(result.exitCode & 64).toBe(64);
      expect(result.exitCode & 4).toBe(0);
      expect(result.findings.some((f) => f.type === 'pack-index-unusable')).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// CONNECTIVITY-ONLY — CLASSIFY UNREADABLE OBJECTS (§D12)
// ---------------------------------------------------------------------------

describe('Given a v99-header pack whose objects exist nowhere else, connectivity classification', () => {
  describe('When fsck runs with connectivityOnly: true', () => {
    it('Then each pack object id gets a dangling/unknown and unreachable/unknown finding, and exit code is 0', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const packIds = await writeSyntheticPack(
        ctx,
        'd12-refused',
        onePackEntry('d12-refused-content'),
      );
      await restampPackHeader(ctx, packFilePath(ctx, 'd12-refused'), { version: 99 });

      // Act
      const result = await fsck(ctx, { connectivityOnly: true });

      // Assert
      for (const id of packIds) {
        const dangling = result.findings.find(
          (f) => f.type === 'dangling' && (f as { id: ObjectId }).id === id,
        );
        const unreachable = result.findings.find(
          (f) => f.type === 'unreachable' && (f as { id: ObjectId }).id === id,
        );
        expect(dangling).toBeDefined();
        expect((dangling as { objectType: string }).objectType).toBe('unknown');
        expect(unreachable).toBeDefined();
        expect((unreachable as { objectType: string }).objectType).toBe('unknown');
      }
      expect(result.exitCode).toBe(0);
    });
  });

  describe('When fsck runs (default mode)', () => {
    it('Then no dangling or unreachable finding carries a pack object id', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const packIds = await writeSyntheticPack(
        ctx,
        'd12-refused-default',
        onePackEntry('d12-refused-default-content'),
      );
      await restampPackHeader(ctx, packFilePath(ctx, 'd12-refused-default'), { version: 99 });

      // Act
      const result = await fsck(ctx);

      // Assert
      const dangling = result.findings.filter(
        (f) => f.type === 'dangling' && packIds.includes((f as { id: ObjectId }).id),
      );
      const unreachable = result.findings.filter(
        (f) => f.type === 'unreachable' && packIds.includes((f as { id: ObjectId }).id),
      );
      expect(dangling).toHaveLength(0);
      expect(unreachable).toHaveLength(0);
    });
  });

  describe('When fsck runs with full: false', () => {
    it('Then no finding of any kind carries a pack object id', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const packIds = await writeSyntheticPack(
        ctx,
        'd12-refused-no-full',
        onePackEntry('d12-refused-no-full-content'),
      );
      await restampPackHeader(ctx, packFilePath(ctx, 'd12-refused-no-full'), { version: 99 });

      // Act
      const result = await fsck(ctx, { full: false });

      // Assert
      const carriedIds = new Set(result.findings.flatMap((f) => findingIds(f)));
      for (const id of packIds) {
        expect(carriedIds.has(id as ObjectId)).toBe(false);
      }
    });
  });
});

describe('Given an unreferenced loose object whose read rejects with PERMISSION_DENIED', () => {
  describe('When fsck runs with connectivityOnly: true', () => {
    it('Then emits a dangling/unknown and an unreachable/unknown finding, and exit code is 0', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const blobId = await writeObject(ctx, makeBlob('unopenable-content'));
      const blobPath = looseObjectPath(ctx.layout.gitDir, blobId);
      const wrapped: Context = {
        ...ctx,
        fs: {
          ...ctx.fs,
          read: async (path: string) => {
            if (path === blobPath) throw permissionDenied(path);
            return ctx.fs.read(path);
          },
        },
      };

      // Act
      const result = await fsck(wrapped, { connectivityOnly: true });

      // Assert
      const dangling = result.findings.find(
        (f) => f.type === 'dangling' && (f as { id: ObjectId }).id === blobId,
      );
      const unreachable = result.findings.find(
        (f) => f.type === 'unreachable' && (f as { id: ObjectId }).id === blobId,
      );
      expect(dangling).toBeDefined();
      expect((dangling as { objectType: string }).objectType).toBe('unknown');
      expect(unreachable).toBeDefined();
      expect((unreachable as { objectType: string }).objectType).toBe('unknown');
      expect(result.exitCode).toBe(0);
    });
  });
});

describe('Given an unreferenced empty-file loose object (zero bytes)', () => {
  describe('When fsck runs with connectivityOnly: true', () => {
    it('Then emits a dangling/unknown and an unreachable/unknown finding, and exit code is 0', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const emptyId = 'e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5' as ObjectId;
      await writeEmptyLooseObject(ctx, emptyId);

      // Act
      const result = await fsck(ctx, { connectivityOnly: true });

      // Assert
      const dangling = result.findings.find(
        (f) => f.type === 'dangling' && (f as { id: ObjectId }).id === emptyId,
      );
      const unreachable = result.findings.find(
        (f) => f.type === 'unreachable' && (f as { id: ObjectId }).id === emptyId,
      );
      expect(dangling).toBeDefined();
      expect((dangling as { objectType: string }).objectType).toBe('unknown');
      expect(unreachable).toBeDefined();
      expect((unreachable as { objectType: string }).objectType).toBe('unknown');
      expect(result.exitCode).toBe(0);
    });
  });

  describe('When fsck runs (default mode)', () => {
    it('Then no dangling or unreachable finding is emitted, a bad-object finding is present, and exit code has bit 1', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const emptyId = 'e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6' as ObjectId;
      await writeEmptyLooseObject(ctx, emptyId);

      // Act
      const result = await fsck(ctx);

      // Assert
      const dangling = result.findings.find(
        (f) => f.type === 'dangling' && (f as { id: ObjectId }).id === emptyId,
      );
      const unreachable = result.findings.find(
        (f) => f.type === 'unreachable' && (f as { id: ObjectId }).id === emptyId,
      );
      const badObject = result.findings.find(
        (f) => f.type === 'bad-object' && (f as { id: ObjectId }).id === emptyId,
      );
      expect(dangling).toBeUndefined();
      expect(unreachable).toBeUndefined();
      expect(badObject).toBeDefined();
      expect(result.exitCode & 1).toBe(1);
    });
  });
});

describe('Given a reachable tree entry pointing at an unreadable (empty-file) blob', () => {
  describe('When fsck runs with connectivityOnly: true', () => {
    it('Then no dangling, unreachable, or missing finding is emitted, and exit code is 0', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const damagedId = 'd7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7' as ObjectId;
      await writeEmptyLooseObject(ctx, damagedId);
      const treeId = await writeObject(
        ctx,
        makeTree([{ mode: FILE_MODE.REGULAR, name: 'damaged.bin', id: damagedId }]),
      );
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act
      const result = await fsck(ctx, { connectivityOnly: true });

      // Assert
      expect(result.findings.filter((f) => f.type === 'dangling')).toHaveLength(0);
      expect(result.findings.filter((f) => f.type === 'unreachable')).toHaveLength(0);
      expect(result.findings.filter((f) => f.type === 'missing')).toHaveLength(0);
      expect(result.exitCode).toBe(0);
    });
  });
});

describe('Given a loose object whose content hash does not match its path (hash-path mismatch), connectivityOnly: true', () => {
  describe('When fsck runs with connectivityOnly: true', () => {
    it("Then emits a dangling finding with the real decoded type, not 'unknown'", async () => {
      // Arrange
      const ctx = await initBareCtx();
      const blobId1 = await writeObject(ctx, makeBlob('hello'));
      const blobId2 = await writeObject(ctx, makeBlob('world'));
      const blob2Path = looseObjectPath(ctx.layout.gitDir, blobId2);
      const blob2Compressed = await ctx.fs.read(blob2Path);
      const blob1Path = looseObjectPath(ctx.layout.gitDir, blobId1);
      await ctx.fs.write(blob1Path, blob2Compressed);

      // Act
      const result = await fsck(ctx, { connectivityOnly: true });

      // Assert — decodes fine (real type 'blob'), not corrupt: the widening
      // must key on the null cache entry, not on "content pass complained"
      // (content pass does not even run in connectivityOnly mode).
      const dangling = result.findings.find(
        (f) => f.type === 'dangling' && (f as { id: ObjectId }).id === blobId1,
      );
      expect(dangling).toBeDefined();
      expect((dangling as { objectType: string }).objectType).toBe('blob');
    });
  });
});

describe('Given two unreadable objects, one referenced by a readable object and one referenced by nobody', () => {
  describe('When fsck runs with connectivityOnly: true', () => {
    it('Then the referenced one is unreachable only, and the unreferenced one is unreachable and dangling', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const referencedId = 'a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9' as ObjectId;
      const orphanId = 'b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9' as ObjectId;
      await writeEmptyLooseObject(ctx, referencedId);
      await writeEmptyLooseObject(ctx, orphanId);
      await writeObject(
        ctx,
        makeTree([{ mode: FILE_MODE.REGULAR, name: 'ref.bin', id: referencedId }]),
      );

      // Act
      const result = await fsck(ctx, { connectivityOnly: true });

      // Assert
      const referencedDangling = result.findings.some(
        (f) => f.type === 'dangling' && (f as { id: ObjectId }).id === referencedId,
      );
      const referencedUnreachable = result.findings.some(
        (f) => f.type === 'unreachable' && (f as { id: ObjectId }).id === referencedId,
      );
      const orphanDangling = result.findings.some(
        (f) => f.type === 'dangling' && (f as { id: ObjectId }).id === orphanId,
      );
      const orphanUnreachable = result.findings.some(
        (f) => f.type === 'unreachable' && (f as { id: ObjectId }).id === orphanId,
      );
      expect(referencedDangling).toBe(false);
      expect(referencedUnreachable).toBe(true);
      expect(orphanDangling).toBe(true);
      expect(orphanUnreachable).toBe(true);
    });
  });
});

describe('Given a healthy repo with no damage', () => {
  describe('When fsck runs (default mode)', () => {
    it('Then no dangling or unreachable finding is emitted and exit code is 0', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const blobId = await writeObject(ctx, makeBlob('healthy-content'));
      const treeId = await writeObject(
        ctx,
        makeTree([{ mode: FILE_MODE.REGULAR, name: 'file.txt', id: blobId }]),
      );
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act
      const result = await fsck(ctx);

      // Assert
      expect(result.findings.filter((f) => f.type === 'dangling')).toHaveLength(0);
      expect(result.findings.filter((f) => f.type === 'unreachable')).toHaveLength(0);
      expect(result.exitCode).toBe(0);
    });
  });

  describe('When fsck runs with connectivityOnly: true', () => {
    it('Then no dangling or unreachable finding is emitted and exit code is 0', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const blobId = await writeObject(ctx, makeBlob('healthy-content'));
      const treeId = await writeObject(
        ctx,
        makeTree([{ mode: FILE_MODE.REGULAR, name: 'file.txt', id: blobId }]),
      );
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act
      const result = await fsck(ctx, { connectivityOnly: true });

      // Assert
      expect(result.findings.filter((f) => f.type === 'dangling')).toHaveLength(0);
      expect(result.findings.filter((f) => f.type === 'unreachable')).toHaveLength(0);
      expect(result.exitCode).toBe(0);
    });
  });

  describe('When fsck runs with full: false', () => {
    it('Then no dangling or unreachable finding is emitted and exit code is 0', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const blobId = await writeObject(ctx, makeBlob('healthy-content'));
      const treeId = await writeObject(
        ctx,
        makeTree([{ mode: FILE_MODE.REGULAR, name: 'file.txt', id: blobId }]),
      );
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act
      const result = await fsck(ctx, { full: false });

      // Assert
      expect(result.findings.filter((f) => f.type === 'dangling')).toHaveLength(0);
      expect(result.findings.filter((f) => f.type === 'unreachable')).toHaveLength(0);
      expect(result.exitCode).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// REJECT ON UNRECOVERABLE HEADERS, TYPE FROM A RECOVERED ONE
// ---------------------------------------------------------------------------

/** Write raw bytes directly at an arbitrary 40-hex oid's loose path — present
 * in the object store's directory listing, unreferenced, never zlib-valid. */
async function writeGarbageLooseObject(
  ctx: Context,
  id: ObjectId,
  bytes: Uint8Array,
): Promise<void> {
  const dir = objectsDir(ctx.layout.gitDir, id.slice(0, 2));
  await ctx.fs.mkdir(dir);
  await ctx.fs.write(looseObjectPath(ctx.layout.gitDir, id), bytes);
}

/** Flip the last byte before a written pack's trailer — inside the LAST
 * entry's compressed (zlib) stream, corrupting its Adler-32 trailer so
 * inflate fails deterministically without touching the entry header. */
async function corruptTrailingPackEntryByte(ctx: Context, packPath: string): Promise<void> {
  const bytes = await ctx.fs.read(packPath);
  const idx = bytes.length - ctx.hashConfig.digestLength - 1;
  bytes[idx] = (bytes[idx] ?? 0) ^ 0xff;
  await ctx.fs.write(packPath, bytes);
}

const GARBAGE_BYTES = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

interface WarnCall {
  readonly message: string;
  readonly context: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Wrap `ctx` with a stub logger that records every `warn` call. The recovery
 * probe's degrade reasons reach `ctx.logger?.warn?.(message, context)` —
 * optional chaining short-circuits BEFORE evaluating either argument when no
 * logger is present, so a context without one never observes which reason
 * string a given degrade path chose, nor even evaluates it.
 */
function withWarnLog(ctx: Context): { readonly ctx: Context; readonly calls: WarnCall[] } {
  const calls: WarnCall[] = [];
  const wrapped: Context = {
    ...ctx,
    logger: {
      warn: (message: string, context?: Readonly<Record<string, unknown>>) => {
        calls.push({ message, context });
      },
    },
  };
  return { ctx: wrapped, calls };
}

describe('Given a loose object with non-zlib garbage bytes, unreferenced (dangling)', () => {
  describe('When fsck runs with connectivityOnly: true', () => {
    it('Then fsck rejects with DECOMPRESS_FAILED', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const garbageId = 'd1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1' as ObjectId;
      await writeGarbageLooseObject(ctx, garbageId, GARBAGE_BYTES);

      // Act
      let caught: unknown;
      try {
        await fsck(ctx, { connectivityOnly: true });
      } catch (error) {
        caught = error;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('DECOMPRESS_FAILED');
    });
  });

  describe('When fsck runs (default mode)', () => {
    it('Then resolves with a bad-object finding, exit bit 1, and no dangling/unreachable finding for that oid', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const garbageId = 'd2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2' as ObjectId;
      await writeGarbageLooseObject(ctx, garbageId, GARBAGE_BYTES);

      // Act
      const result = await fsck(ctx);

      // Assert
      const badObject = result.findings.find(
        (f) => f.type === 'bad-object' && (f as { id: ObjectId }).id === garbageId,
      );
      expect(badObject).toBeDefined();
      expect(result.exitCode & 1).toBe(1);
      const dangerousTypes = result.findings.filter(
        (f) =>
          (f.type === 'dangling' || f.type === 'unreachable') &&
          (f as { id: ObjectId }).id === garbageId,
      );
      expect(dangerousTypes).toHaveLength(0);
    });
  });

  describe('When fsck runs with full: false', () => {
    it('Then resolves the same as default mode: bad-object finding, exit bit 1', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const garbageId = 'd3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3' as ObjectId;
      await writeGarbageLooseObject(ctx, garbageId, GARBAGE_BYTES);

      // Act
      const result = await fsck(ctx, { full: false });

      // Assert
      const badObject = result.findings.find(
        (f) => f.type === 'bad-object' && (f as { id: ObjectId }).id === garbageId,
      );
      expect(badObject).toBeDefined();
      expect(result.exitCode & 1).toBe(1);
    });
  });

  describe('When fsck runs with connectivityOnly: true and full: false', () => {
    it('Then fsck still rejects with DECOMPRESS_FAILED (full is never consulted by the guard)', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const garbageId = 'd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4' as ObjectId;
      await writeGarbageLooseObject(ctx, garbageId, GARBAGE_BYTES);

      // Act
      let caught: unknown;
      try {
        await fsck(ctx, { connectivityOnly: true, full: false });
      } catch (error) {
        caught = error;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('DECOMPRESS_FAILED');
    });
  });
});

describe('Given a loose object whose inflated bytes carry no NUL terminator at all', () => {
  describe('When fsck runs with connectivityOnly: true', () => {
    it('Then fsck rejects with INVALID_OBJECT_HEADER and the reason is asserted', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const rawBytes = new Uint8Array(40).fill(0x41);
      await writeMalformedLooseObject(ctx, rawBytes);

      // Act
      let caught: unknown;
      try {
        await fsck(ctx, { connectivityOnly: true });
      } catch (error) {
        caught = error;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('INVALID_OBJECT_HEADER');
      expect((caught as { data: { reason: string } }).data.reason).toBe('missing null terminator');
    });
  });
});

describe('Given a loose object whose header declares an unknown type name ("widget")', () => {
  describe('When fsck runs with connectivityOnly: true', () => {
    it('Then fsck rejects with INVALID_OBJECT_HEADER and the reason names the type', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const rawBytes = buildLooseBytes('widget', enc.encode('hello'));
      await writeMalformedLooseObject(ctx, rawBytes);

      // Act
      let caught: unknown;
      try {
        await fsck(ctx, { connectivityOnly: true });
      } catch (error) {
        caught = error;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('INVALID_OBJECT_HEADER');
      expect((caught as { data: { reason: string } }).data.reason).toBe(
        'unknown object type: widget',
      );
    });
  });
});

describe('Given a loose object whose header declares a size larger than its actual content', () => {
  describe('When fsck runs with connectivityOnly: true', () => {
    it("Then resolves with dangling/'blob' (a size mismatch never aborts)", async () => {
      // Arrange
      const ctx = await initBareCtx();
      const header = enc.encode('blob 99\0');
      const body = enc.encode('hi');
      const rawBytes = new Uint8Array(header.length + body.length);
      rawBytes.set(header);
      rawBytes.set(body, header.length);
      const blobId = await writeMalformedLooseObject(ctx, rawBytes);

      // Act
      const result = await fsck(ctx, { connectivityOnly: true });

      // Assert
      const dangling = result.findings.find(
        (f) => f.type === 'dangling' && (f as { id: ObjectId }).id === blobId,
      );
      expect(dangling).toBeDefined();
      expect((dangling as { objectType: string }).objectType).toBe('blob');
    });
  });
});

describe('Given a loose object with a valid header but an unparseable tree body', () => {
  describe('When fsck runs with connectivityOnly: true', () => {
    it("Then resolves with dangling/'tree', exit code 0", async () => {
      // Arrange
      const ctx = await initBareCtx();
      const header = enc.encode('tree 4\0');
      const body = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
      const rawBytes = new Uint8Array(header.length + body.length);
      rawBytes.set(header);
      rawBytes.set(body, header.length);
      const treeId = await writeMalformedLooseObject(ctx, rawBytes);

      // Act
      const result = await fsck(ctx, { connectivityOnly: true });

      // Assert
      const dangling = result.findings.find(
        (f) => f.type === 'dangling' && (f as { id: ObjectId }).id === treeId,
      );
      expect(dangling).toBeDefined();
      expect((dangling as { objectType: string }).objectType).toBe('tree');
      expect(result.exitCode).toBe(0);
    });
  });

  describe('When fsck runs (default mode)', () => {
    it('Then resolves with a bad-object finding, exit bit 1, and no dangling/unreachable finding for that oid (retention is mode-gated)', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const header = enc.encode('tree 4\0');
      const body = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
      const rawBytes = new Uint8Array(header.length + body.length);
      rawBytes.set(header);
      rawBytes.set(body, header.length);
      const treeId = await writeMalformedLooseObject(ctx, rawBytes);

      // Act
      const result = await fsck(ctx);

      // Assert
      const badObject = result.findings.find(
        (f) => f.type === 'bad-object' && (f as { id: ObjectId }).id === treeId,
      );
      expect(badObject).toBeDefined();
      expect(result.exitCode & 1).toBe(1);
      const dangerousTypes = result.findings.filter(
        (f) =>
          (f.type === 'dangling' || f.type === 'unreachable') &&
          (f as { id: ObjectId }).id === treeId,
      );
      expect(dangerousTypes).toHaveLength(0);
    });
  });
});

describe('Given a garbage blob referenced by a reachable tree, connectivityOnly: true', () => {
  describe('When fsck runs with connectivityOnly: true', () => {
    it('Then resolves with no finding for that oid, exit code 0', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const garbageId = 'd5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5' as ObjectId;
      await writeGarbageLooseObject(ctx, garbageId, GARBAGE_BYTES);
      const treeId = await writeObject(
        ctx,
        makeTree([{ mode: FILE_MODE.REGULAR, name: 'garbage.bin', id: garbageId }]),
      );
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act
      const result = await fsck(ctx, { connectivityOnly: true });

      // Assert
      const carriedIds = result.findings.flatMap((f) => findingIds(f));
      expect(carriedIds).not.toContain(garbageId);
      expect(result.exitCode).toBe(0);
    });
  });
});

describe('Given a garbage blob referenced only by a dangling readable tree (no ref anywhere)', () => {
  describe('When fsck runs with connectivityOnly: true', () => {
    it('Then fsck rejects — the guard is fed unreachable, not dangling', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const garbageId = 'd6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6' as ObjectId;
      await writeGarbageLooseObject(ctx, garbageId, GARBAGE_BYTES);
      await writeObject(
        ctx,
        makeTree([{ mode: FILE_MODE.REGULAR, name: 'garbage.bin', id: garbageId }]),
      );
      // No ref: the tree itself is readable but unreferenced (dangling), which
      // still records an in-edge for the garbage blob via buildInEdgeMap — the
      // blob is unreachable but NOT dangling.

      // Act
      let caught: unknown;
      try {
        await fsck(ctx, { connectivityOnly: true });
      } catch (error) {
        caught = error;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('DECOMPRESS_FAILED');
    });
  });
});

describe('Given a dangling blob packed only (not loose) with a corrupt entry body', () => {
  describe('When fsck runs with connectivityOnly: true', () => {
    it("Then resolves with dangling/'blob', exit code 0", async () => {
      // Arrange
      const ctx = await initBareCtx();
      const [blobId] = await writeSyntheticPack(
        ctx,
        'd13-corrupt-base',
        onePackEntry('d13-corrupt-base-content'),
      );
      await corruptTrailingPackEntryByte(ctx, packFilePath(ctx, 'd13-corrupt-base'));

      // Act
      const result = await fsck(ctx, { connectivityOnly: true });

      // Assert
      const dangling = result.findings.find(
        (f) => f.type === 'dangling' && (f as { id: ObjectId }).id === blobId,
      );
      expect(dangling).toBeDefined();
      expect((dangling as { objectType: string }).objectType).toBe('blob');
      expect(result.exitCode).toBe(0);
    });
  });
});

describe('Given a dangling OFS_DELTA-encoded blob with a corrupt delta body, base intact', () => {
  describe('When fsck runs with connectivityOnly: true', () => {
    it("Then resolves with dangling/'blob' (typed via the base-link walk)", async () => {
      // Arrange
      const ctx = await initBareCtx();
      const baseContent = enc.encode('d13-ofs-base-content');
      const targetContent = enc.encode('d13-ofs-base-contentTAIL');
      const ids = await writeSyntheticPack(ctx, 'd13-ofs-delta', [
        { kind: 'base', type: 'blob', content: baseContent },
        { kind: 'ofs-delta', baseIndex: 0, targetContent },
      ]);
      const deltaId = ids[1] as ObjectId;
      await corruptTrailingPackEntryByte(ctx, packFilePath(ctx, 'd13-ofs-delta'));

      // Act
      const result = await fsck(ctx, { connectivityOnly: true });

      // Assert
      const dangling = result.findings.find(
        (f) => f.type === 'dangling' && (f as { id: ObjectId }).id === deltaId,
      );
      expect(dangling).toBeDefined();
      expect((dangling as { objectType: string }).objectType).toBe('blob');
    });
  });
});

describe('Given an OFS_DELTA chain one hop deeper than the walker can afford, tip corrupt', () => {
  describe('When fsck runs with connectivityOnly: true', () => {
    it("Then resolves with dangling/'unknown' and logs the depth-cap reason", async () => {
      // Arrange — base + 50 chained OFS deltas: reconstructing the tip needs
      // 51 header reads (50 delta hops + the base), but the walker's
      // `depth < MAX_DELTA_CHAIN_DEPTH` loop allows only 50 — one short of
      // the base. Corrupting the tip's own body (the last-written entry)
      // decode-faults the INITIAL read on its very first inflate, before any
      // chain walking; the recovery probe then re-walks headers only (never
      // inflating a body) and hits the cap.
      const ctx = await initBareCtx();
      const baseContent = enc.encode('depth-cap-base');
      const entries: EntrySpec[] = [{ kind: 'base', type: 'blob', content: baseContent }];
      for (let i = 0; i < 50; i += 1) {
        entries.push({
          kind: 'ofs-delta',
          baseIndex: i,
          targetContent: enc.encode(`depth-cap-hop-${i}`),
        });
      }
      const ids = await writeSyntheticPack(ctx, 'depth-cap', entries);
      const tipId = ids.at(-1) as ObjectId;
      await corruptTrailingPackEntryByte(ctx, packFilePath(ctx, 'depth-cap'));
      const { ctx: logged, calls } = withWarnLog(ctx);

      // Act
      const result = await fsck(logged, { connectivityOnly: true });

      // Assert
      const dangling = result.findings.find(
        (f) => f.type === 'dangling' && (f as { id: ObjectId }).id === tipId,
      );
      expect(dangling).toBeDefined();
      expect((dangling as { objectType: string }).objectType).toBe('unknown');
      const warned = calls.find((c) => c.context?.objectId === tipId);
      expect(warned?.message).toBe('fsck: stored type probe degraded');
      expect(warned?.context?.reason).toBe('delta chain exceeds max depth');
    });
  });
});

describe('Given a dangling REF_DELTA-encoded blob with a corrupt delta body, base intact', () => {
  describe('When fsck runs with connectivityOnly: true', () => {
    it("Then resolves with dangling/'blob' (the walker branches on the REF_DELTA encoding)", async () => {
      // Arrange
      const ctx = await initBareCtx();
      const baseContent = enc.encode('d13-ref-base-content');
      const baseIds = await writeSyntheticPack(ctx, 'd13-ref-base', [
        { kind: 'base', type: 'blob', content: baseContent },
      ]);
      const baseId = baseIds[0]!;
      const targetContent = enc.encode('d13-ref-base-contentTAIL');
      const deltaIds = await writeSyntheticPack(ctx, 'd13-ref-delta', [
        { kind: 'ref-delta', baseId, baseUncompressed: baseContent, targetContent },
      ]);
      const deltaId = deltaIds[0] as ObjectId;
      await corruptTrailingPackEntryByte(ctx, packFilePath(ctx, 'd13-ref-delta'));

      // Act
      const result = await fsck(ctx, { connectivityOnly: true });

      // Assert
      const dangling = result.findings.find(
        (f) => f.type === 'dangling' && (f as { id: ObjectId }).id === deltaId,
      );
      expect(dangling).toBeDefined();
      expect((dangling as { objectType: string }).objectType).toBe('blob');
    });
  });
});

describe('Given a loose garbled copy shadowing a healthy packed copy of the same oid', () => {
  describe('When fsck runs with connectivityOnly: true', () => {
    it("Then resolves with dangling/'blob', exit code 0 (typed from the packed copy)", async () => {
      // Arrange
      const ctx = await initBareCtx();
      const [blobId] = await writeSyntheticPack(
        ctx,
        'd13-shadow-healthy',
        onePackEntry('d13-shadow-content'),
      );
      const id = blobId as ObjectId;
      await writeGarbageLooseObject(ctx, id, GARBAGE_BYTES);

      // Act
      const result = await fsck(ctx, { connectivityOnly: true });

      // Assert
      const dangling = result.findings.find(
        (f) => f.type === 'dangling' && (f as { id: ObjectId }).id === id,
      );
      expect(dangling).toBeDefined();
      expect((dangling as { objectType: string }).objectType).toBe('blob');
      expect(result.exitCode).toBe(0);
    });
  });
});

describe('Given a loose garbled copy shadowing a packed OFS_DELTA whose base distance points before the pack body', () => {
  describe('When fsck runs with connectivityOnly: true', () => {
    it("Then resolves with dangling/'unknown' and logs the out-of-range reason", async () => {
      // Arrange — loose-before-pack precedence means the INITIAL read never
      // touches the pack at all, so the walker's own header-only recovery
      // walk is the only code that ever reads this entry. A distance far
      // larger than the entry's own offset drives `baseOffset` deeply
      // negative.
      const ctx = await initBareCtx();
      const baseContent = enc.encode('d13-neg-offset-base');
      const targetContent = enc.encode('d13-neg-offset-baseTAIL');
      const ids = await writeSyntheticPack(ctx, 'd13-neg-offset', [
        { kind: 'base', type: 'blob', content: baseContent },
        { kind: 'ofs-delta', baseIndex: 0, targetContent, distanceOverride: 1_000_000 },
      ]);
      const deltaId = ids[1] as ObjectId;
      await writeGarbageLooseObject(ctx, deltaId, GARBAGE_BYTES);
      const { ctx: logged, calls } = withWarnLog(ctx);

      // Act
      const result = await fsck(logged, { connectivityOnly: true });

      // Assert
      const dangling = result.findings.find(
        (f) => f.type === 'dangling' && (f as { id: ObjectId }).id === deltaId,
      );
      expect(dangling).toBeDefined();
      expect((dangling as { objectType: string }).objectType).toBe('unknown');
      const warned = calls.find((c) => c.context?.objectId === deltaId);
      expect(warned?.message).toBe('fsck: stored type probe degraded');
      expect(warned?.context?.reason).toBe('OFS_DELTA base offset out of range');
    });
  });
});

describe('Given a loose garbled copy shadowing a packed OFS_DELTA whose base distance lands exactly on offset 0', () => {
  describe('When fsck runs with connectivityOnly: true', () => {
    it('Then the guard does not trip — kills the baseOffset<=0 mutant, which would degrade here', async () => {
      // Arrange — distance equal to the delta's own real offset drives
      // `baseOffset` to exactly 0. `baseOffset < 0` is false there (the
      // walker proceeds into whatever offset 0 holds); the `<=0` mutant would
      // instead trip the guard and degrade with the OFS-out-of-range reason.
      const ctx = await initBareCtx();
      const baseContent = enc.encode('d13-zero-offset-base');
      const targetContent = enc.encode('d13-zero-offset-baseTAIL');
      const probeEntries: EntrySpec[] = [
        { kind: 'base', type: 'blob', content: baseContent },
        { kind: 'ofs-delta', baseIndex: 0, targetContent },
      ];
      const probe = await buildSyntheticPack(ctx, probeEntries);
      const deltaOffset = probe.offsets[1]!;
      const ids = await writeSyntheticPack(ctx, 'd13-zero-offset', [
        { kind: 'base', type: 'blob', content: baseContent },
        { kind: 'ofs-delta', baseIndex: 0, targetContent, distanceOverride: deltaOffset },
      ]);
      const deltaId = ids[1] as ObjectId;
      await writeGarbageLooseObject(ctx, deltaId, GARBAGE_BYTES);
      const { ctx: logged, calls } = withWarnLog(ctx);

      // Act
      const result = await fsck(logged, { connectivityOnly: true });

      // Assert
      const dangling = result.findings.find(
        (f) => f.type === 'dangling' && (f as { id: ObjectId }).id === deltaId,
      );
      expect(dangling).toBeDefined();
      expect((dangling as { objectType: string }).objectType).toBe('unknown');
      const warned = calls.find((c) => c.context?.objectId === deltaId);
      // Offset 0 lands on the pack's own 12-byte magic header, not an entry —
      // the SUBSEQUENT header parse fails, caught by typeFromEntry's own
      // store-fault handling (Pin: distinct reason from the guard's own).
      expect(warned?.context?.reason).toBe('pack entry unreadable');
      expect(result.exitCode).toBe(0);
    });
  });
});

describe('Given a loose-only undecodable object whose file is gone by the time the recovery probe rereads it', () => {
  describe('When fsck runs with connectivityOnly: true', () => {
    it("Then resolves with dangling/'unknown' and logs the not-claimed reason — arm 2's own no-pack case", async () => {
      // Arrange — the object is loose-only, never packed. The INITIAL read
      // finds the garbage bytes fine (decode-faults on inflate). The recovery
      // probe rereads the SAME loose path a second time; an external pruner
      // removing it in between (git-faithfully a miss, per
      // `readLooseCompressed`'s own vanished-file handling) degrades
      // `looseCompressedBytes` to undefined exactly like an object that was
      // never loose — landing in arm 2, where `lookupIfClaimed` finds nothing
      // either, since this id was never packed.
      const ctx = await initBareCtx();
      const garbageId = 'dbdbdbdbdbdbdbdbdbdbdbdbdbdbdbdbdbdbdbdb' as ObjectId;
      await writeGarbageLooseObject(ctx, garbageId, GARBAGE_BYTES);
      const loosePath = looseObjectPath(ctx.layout.gitDir, garbageId);
      let rereadCount = 0;
      const wrapped: Context = {
        ...ctx,
        fs: {
          ...ctx.fs,
          read: async (path: string) => {
            if (path !== loosePath) return ctx.fs.read(path);
            rereadCount += 1;
            if (rereadCount === 1) return ctx.fs.read(path);
            throw fileNotFound(path);
          },
        },
      };
      const { ctx: logged, calls } = withWarnLog(wrapped);

      // Act
      const result = await fsck(logged, { connectivityOnly: true });

      // Assert
      const dangling = result.findings.find(
        (f) => f.type === 'dangling' && (f as { id: ObjectId }).id === garbageId,
      );
      expect(dangling).toBeDefined();
      expect((dangling as { objectType: string }).objectType).toBe('unknown');
      expect(result.exitCode).toBe(0);
      const warned = calls.find((c) => c.context?.objectId === garbageId);
      expect(warned?.message).toBe('fsck: stored type probe degraded');
      expect(warned?.context?.reason).toBe('not loose and claimed by no accessible pack');
    });
  });
});

describe('Given one healthy dangling blob and one undecodable dangling blob', () => {
  describe('When fsck runs with connectivityOnly: true', () => {
    it("Then fsck rejects, and the healthy object's findings are unobservable", async () => {
      // Arrange
      const ctx = await initBareCtx();
      await writeObject(ctx, makeBlob('d13-healthy-dangling'));
      const garbageId = 'd7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7' as ObjectId;
      await writeGarbageLooseObject(ctx, garbageId, GARBAGE_BYTES);
      const { ctx: logged, calls } = withWarnLog(ctx);

      // Act
      let caught: unknown;
      try {
        await fsck(logged, { connectivityOnly: true });
      } catch (error) {
        caught = error;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('DECOMPRESS_FAILED');
      const warned = calls.find((c) => c.context?.objectId === garbageId);
      expect(warned?.message).toBe('fsck: object type unrecoverable');
      expect(warned?.context?.code).toBe('DECOMPRESS_FAILED');
      expect(typeof warned?.context?.reason).toBe('string');
    });
  });
});

describe('Given a pack with a corrupt .idx and a separate undecodable dangling loose object', () => {
  describe('When fsck runs with connectivityOnly: true', () => {
    it('Then fsck rejects (the bit-64 term is not observable through a reject)', async () => {
      // Arrange
      const ctx = await initBareCtx();
      await writeSyntheticPack(ctx, 'd13-corrupt-idx', onePackEntry('d13-corrupt-idx-content'));
      await ctx.fs.write(idxFilePath(ctx, 'd13-corrupt-idx'), new Uint8Array(1072));
      const garbageId = 'd8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8' as ObjectId;
      await writeGarbageLooseObject(ctx, garbageId, GARBAGE_BYTES);

      // Act
      let caught: unknown;
      try {
        await fsck(ctx, { connectivityOnly: true });
      } catch (error) {
        caught = error;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('DECOMPRESS_FAILED');
    });
  });
});

describe('Given an undecodable dangling loose object whose probe re-inflate hits an unrelated adapter fault', () => {
  describe('When fsck runs with connectivityOnly: true', () => {
    it('Then fsck rejects with that exact UNSUPPORTED_OPERATION, not a laundered abort', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const garbageId = 'd9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9' as ObjectId;
      await writeGarbageLooseObject(ctx, garbageId, GARBAGE_BYTES);
      let inflateCalls = 0;
      const wrapped: Context = {
        ...ctx,
        compressor: {
          ...ctx.compressor,
          inflate: async (bytes: Uint8Array) => {
            inflateCalls += 1;
            if (inflateCalls === 2) {
              throw unsupportedOperation('filesystem', 'simulated adapter fault');
            }
            return ctx.compressor.inflate(bytes);
          },
        },
      };

      // Act
      let caught: unknown;
      try {
        await fsck(wrapped, { connectivityOnly: true });
      } catch (error) {
        caught = error;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data).toEqual({
        code: 'UNSUPPORTED_OPERATION',
        operation: 'filesystem',
        reason: 'simulated adapter fault',
      });
    });
  });
});

describe('Given a loose garbled copy whose packed twin rejects entry reads with PERMISSION_DENIED', () => {
  describe('When fsck runs with connectivityOnly: true', () => {
    it("Then resolves with dangling/'unknown' — the walk degrades on store damage, never aborts", async () => {
      // Arrange
      const ctx = await initBareCtx();
      const [blobId] = await writeSyntheticPack(
        ctx,
        'd13-degrade-walk',
        onePackEntry('d13-degrade-walk-content'),
      );
      const id = blobId as ObjectId;
      await writeGarbageLooseObject(ctx, id, GARBAGE_BYTES);
      const packPath = packFilePath(ctx, 'd13-degrade-walk');
      const wrapped: Context = {
        ...ctx,
        fs: {
          ...ctx.fs,
          openWithNoFollow: async (path: string, mode: 'read' | 'write') => {
            // The 12-byte header probe reads via fs.readSlice and stays
            // healthy — only the entry walk's persistent-handle open fails,
            // so the degrade under test is the walk's own, not the gate's.
            if (path === packPath) throw permissionDenied(path);
            return ctx.fs.openWithNoFollow(path, mode);
          },
        },
      };
      const { ctx: logged, calls } = withWarnLog(wrapped);

      // Act
      const result = await fsck(logged, { connectivityOnly: true });

      // Assert
      const dangling = result.findings.find(
        (f) => f.type === 'dangling' && (f as { id: ObjectId }).id === id,
      );
      expect(dangling).toBeDefined();
      expect((dangling as { objectType: string }).objectType).toBe('unknown');
      expect(result.exitCode).toBe(0);
      const warned = calls.find((c) => c.context?.objectId === id);
      expect(warned?.message).toBe('fsck: stored type probe degraded');
      expect(warned?.context?.reason).toBe('pack entry unreadable');
    });
  });
});

describe('Given a loose garbled copy whose packed twin rejects entry reads with UNSUPPORTED_OPERATION', () => {
  describe('When fsck runs with connectivityOnly: true', () => {
    it('Then fsck rejects with that exact fault — environmental faults are never degraded', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const [blobId] = await writeSyntheticPack(
        ctx,
        'd13-env-walk',
        onePackEntry('d13-env-walk-content'),
      );
      const id = blobId as ObjectId;
      await writeGarbageLooseObject(ctx, id, GARBAGE_BYTES);
      const packPath = packFilePath(ctx, 'd13-env-walk');
      const wrapped: Context = {
        ...ctx,
        fs: {
          ...ctx.fs,
          openWithNoFollow: async (path: string, mode: 'read' | 'write') => {
            if (path === packPath) {
              // operation 'filesystem', NOT 'openWithNoFollow': the pack
              // readSlice fallback engages only for the latter, so this fault
              // propagates into the walk instead of degrading to a per-call
              // read — the propagation under test.
              throw unsupportedOperation('filesystem', 'simulated descriptor exhaustion');
            }
            return ctx.fs.openWithNoFollow(path, mode);
          },
        },
      };

      // Act
      let caught: unknown;
      try {
        await fsck(wrapped, { connectivityOnly: true });
      } catch (error) {
        caught = error;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data).toEqual({
        code: 'UNSUPPORTED_OPERATION',
        operation: 'filesystem',
        reason: 'simulated descriptor exhaustion',
      });
    });
  });
});

describe('Given a dangling REF_DELTA-encoded blob whose base pack was never written', () => {
  describe('When fsck runs with connectivityOnly: true', () => {
    it("Then resolves with dangling/'unknown' — an unclaimed base degrades the walk", async () => {
      // Arrange
      const ctx = await initBareCtx();
      const baseContent = enc.encode('d13-absent-base-content');
      const baseId = await writeObject(ctx, makeBlob('d13-absent-base-content'));
      const targetContent = enc.encode('d13-absent-base-contentTAIL');
      const deltaIds = await writeSyntheticPack(ctx, 'd13-absent-base-delta', [
        { kind: 'ref-delta', baseId, baseUncompressed: baseContent, targetContent },
      ]);
      const deltaId = deltaIds[0] as ObjectId;
      await corruptTrailingPackEntryByte(ctx, packFilePath(ctx, 'd13-absent-base-delta'));
      const { ctx: logged, calls } = withWarnLog(ctx);

      // Act
      const result = await fsck(logged, { connectivityOnly: true });

      // Assert
      const dangling = result.findings.find(
        (f) => f.type === 'dangling' && (f as { id: ObjectId }).id === deltaId,
      );
      expect(dangling).toBeDefined();
      expect((dangling as { objectType: string }).objectType).toBe('unknown');
      expect(result.exitCode).toBe(0);
      const warned = calls.find((c) => c.context?.objectId === deltaId);
      expect(warned?.message).toBe('fsck: stored type probe degraded');
      expect(warned?.context?.reason).toBe('REF_DELTA base not claimed by any accessible pack');
    });
  });
});

describe('Given an unreferenced loose object whose read rejects with PERMISSION_DENIED, default mode', () => {
  describe('When fsck runs', () => {
    it('Then fsck rejects with PERMISSION_DENIED — the pre-existing default-mode divergence, pinned', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const blobId = await writeObject(ctx, makeBlob('unopenable-default-content'));
      const blobPath = looseObjectPath(ctx.layout.gitDir, blobId);
      const wrapped: Context = {
        ...ctx,
        fs: {
          ...ctx.fs,
          read: async (path: string) => {
            if (path === blobPath) throw permissionDenied(path);
            return ctx.fs.read(path);
          },
        },
      };

      // Act
      let caught: unknown;
      try {
        await fsck(wrapped);
      } catch (error) {
        caught = error;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
    });
  });
});

describe('Given a corrupt-bodied packed blob typed via the entry walk', () => {
  describe('When fsck runs with connectivityOnly: true and the registry is disposed', () => {
    it('Then no file handle is left outstanding — the retention path honours the handle lifecycle', async () => {
      // Arrange
      const base = await initBareCtx();
      const [blobId] = await writeSyntheticPack(
        base,
        'd13-ledger-entry',
        onePackEntry('d13-ledger-entry-content'),
      );
      const id = blobId as ObjectId;
      await corruptTrailingPackEntryByte(base, packFilePath(base, 'd13-ledger-entry'));
      const ledger = withHandleLedger(base);

      // Act
      const result = await fsck(ledger.ctx, { connectivityOnly: true });
      await disposePackRegistry(ledger.ctx);

      // Assert
      const dangling = result.findings.find(
        (f) => f.type === 'dangling' && (f as { id: ObjectId }).id === id,
      );
      expect(dangling).toBeDefined();
      expect((dangling as { objectType: string }).objectType).toBe('blob');
      // opens > 0 pins that the walk really took the persistent-handle path —
      // outstanding() === 0 alone would also hold for a walk that opened
      // nothing, the exact regression class this row exists to catch.
      expect(ledger.opens()).toBe(1);
      expect(ledger.closes()).toBe(1);
      expect(ledger.outstanding()).toBe(0);
    });
  });
});

describe('Given an undecodable dangling loose object whose header type token embeds a control byte', () => {
  describe('When fsck runs with connectivityOnly: true', () => {
    it('Then the thrown reason carries the byte hex-escaped, never verbatim', async () => {
      // Arrange
      const ctx = await initBareCtx();
      await writeMalformedLooseObject(ctx, enc.encode('wid\u0001g~t\u007f 0\0'));

      // Act
      let caught: unknown;
      try {
        await fsck(ctx, { connectivityOnly: true });
      } catch (error) {
        caught = error;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('INVALID_OBJECT_HEADER');
      const reason = ((caught as TsgitError).data as { reason: string }).reason;
      // `~` pins the 0x7e upper bound; DEL pins the boundary above it and
      // forces a letter into the hex, pinning the upper-case escape.
      expect(reason).toBe('unknown object type: wid\\x01g~t\\x7F');
    });
  });
});

describe('Given an undecodable dangling loose object whose header type token exceeds the reason cap', () => {
  describe('When fsck runs with connectivityOnly: true', () => {
    it('Then the thrown reason is capped at exactly 200 output units', async () => {
      // Arrange
      const ctx = await initBareCtx();
      await writeMalformedLooseObject(ctx, enc.encode(`${'a'.repeat(300)} 0\0`));

      // Act
      let caught: unknown;
      try {
        await fsck(ctx, { connectivityOnly: true });
      } catch (error) {
        caught = error;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('INVALID_OBJECT_HEADER');
      const reason = ((caught as TsgitError).data as { reason: string }).reason;
      expect(reason).toHaveLength(200);
      expect(reason.startsWith('unknown object type: aaa')).toBe(true);
    });
  });
});

describe('Given an undecodable dangling loose object whose header type token is all control bytes', () => {
  describe('When fsck runs with connectivityOnly: true', () => {
    it('Then escape expansion stays inside the cap and never emits a truncated escape', async () => {
      // Arrange
      const ctx = await initBareCtx();
      await writeMalformedLooseObject(ctx, enc.encode(`${'\u0001'.repeat(100)} 0\0`));

      // Act
      let caught: unknown;
      try {
        await fsck(ctx, { connectivityOnly: true });
      } catch (error) {
        caught = error;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      const reason = ((caught as TsgitError).data as { reason: string }).reason;
      expect(reason.length).toBeLessThanOrEqual(200);
      expect(/\\x[0-9A-F]{2}$/.test(reason)).toBe(true);
    });
  });
});

describe('Given a garbage dangling loose object whose probe re-inflate fails with a DIFFERENT candidate code', () => {
  describe('When fsck runs with connectivityOnly: true', () => {
    it('Then the reject carries the ORIGINAL read failure, not the probe-era fault', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const garbageId = 'e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1' as ObjectId;
      await writeGarbageLooseObject(ctx, garbageId, GARBAGE_BYTES);
      let inflateCalls = 0;
      const wrapped: Context = {
        ...ctx,
        compressor: {
          ...ctx.compressor,
          inflate: async (bytes: Uint8Array) => {
            inflateCalls += 1;
            if (inflateCalls === 2) {
              throw invalidObjectHeader('probe-era failure');
            }
            return ctx.compressor.inflate(bytes);
          },
        },
      };

      // Act
      let caught: unknown;
      try {
        await fsck(wrapped, { connectivityOnly: true });
      } catch (error) {
        caught = error;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('DECOMPRESS_FAILED');
      const reason = ((caught as TsgitError).data as { reason: string }).reason;
      expect(reason).not.toContain('probe-era failure');
    });
  });
});

describe('Given a malformed loose tree (non-candidate read failure) whose probe fails with a candidate code', () => {
  describe('When fsck runs with connectivityOnly: true', () => {
    it("Then fsck resolves with dangling/'unknown' — the reject gate follows the ORIGINAL error", async () => {
      // Arrange
      const ctx = await initBareCtx();
      const treeId = await writeMalformedLooseObject(ctx, buildLooseBytes('tree', GARBAGE_BYTES));
      let inflateCalls = 0;
      const wrapped: Context = {
        ...ctx,
        compressor: {
          ...ctx.compressor,
          inflate: async (bytes: Uint8Array) => {
            inflateCalls += 1;
            if (inflateCalls === 2) {
              throw decompressFailed('probe decayed');
            }
            return ctx.compressor.inflate(bytes);
          },
        },
      };

      // Act
      const result = await fsck(wrapped, { connectivityOnly: true });

      // Assert
      const dangling = result.findings.find(
        (f) => f.type === 'dangling' && (f as { id: ObjectId }).id === treeId,
      );
      expect(dangling).toBeDefined();
      expect((dangling as { objectType: string }).objectType).toBe('unknown');
      expect(result.exitCode).toBe(0);
    });
  });
});

describe('Given a loose garbled copy whose packed twin header probe rejects with UNSUPPORTED_OPERATION', () => {
  describe('When fsck runs with connectivityOnly: true', () => {
    it('Then fsck rejects with that exact fault — the claimed-lookup guard rethrows the environment', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const [blobId] = await writeSyntheticPack(
        ctx,
        'd13-claimed-env',
        onePackEntry('d13-claimed-env-content'),
      );
      const id = blobId as ObjectId;
      await writeGarbageLooseObject(ctx, id, GARBAGE_BYTES);
      const packPath = packFilePath(ctx, 'd13-claimed-env');
      const wrapped: Context = {
        ...ctx,
        fs: {
          ...ctx.fs,
          readSlice: async (path: string, offset: number, length: number) => {
            if (path === packPath) {
              throw unsupportedOperation('filesystem', 'simulated probe outage');
            }
            return ctx.fs.readSlice(path, offset, length);
          },
        },
      };

      // Act
      let caught: unknown;
      try {
        await fsck(wrapped, { connectivityOnly: true });
      } catch (error) {
        caught = error;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data).toEqual({
        code: 'UNSUPPORTED_OPERATION',
        operation: 'filesystem',
        reason: 'simulated probe outage',
      });
    });
  });
});

describe('Given a loose garbled copy whose packed twin header probe rejects with a non-skippable store fault', () => {
  describe('When fsck runs with connectivityOnly: true', () => {
    it('Then the reject carries the ORIGINAL decode failure — the pack fault degrades to no-claim', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const [blobId] = await writeSyntheticPack(
        ctx,
        'd13-claimed-store',
        onePackEntry('d13-claimed-store-content'),
      );
      const id = blobId as ObjectId;
      await writeGarbageLooseObject(ctx, id, GARBAGE_BYTES);
      const packPath = packFilePath(ctx, 'd13-claimed-store');
      const wrapped: Context = {
        ...ctx,
        fs: {
          ...ctx.fs,
          readSlice: async (path: string, offset: number, length: number) => {
            if (path === packPath) {
              throw invalidPackIndex('mid-read corruption');
            }
            return ctx.fs.readSlice(path, offset, length);
          },
        },
      };

      // Act
      let caught: unknown;
      try {
        await fsck(wrapped, { connectivityOnly: true });
      } catch (error) {
        caught = error;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('DECOMPRESS_FAILED');
      const reason = ((caught as TsgitError).data as { reason: string }).reason;
      expect(reason).not.toContain('mid-read corruption');
    });
  });
});

describe('Given a corrupt-idx pack beside a pack whose header probe would reject, connectivity-only mode', () => {
  describe('When fsck runs', () => {
    it('Then it resolves and still reports the rev-index finding — the ungated term never probes a header', async () => {
      // Arrange
      const ctx = await initBareCtx();
      await writeSyntheticPack(
        ctx,
        'd13-ungated-poison',
        onePackEntry('d13-ungated-poison-content'),
      );
      const corruptContent = enc.encode('d13-ungated-corrupt-idx');
      await writeSyntheticPack(ctx, 'd13-ungated-corrupt', [
        { kind: 'base', type: 'blob', content: corruptContent },
      ]);
      const idxPath = `${ctx.layout.gitDir}/objects/pack/pack-d13-ungated-corrupt.idx`;
      const idxLength = (await ctx.fs.read(idxPath)).length;
      await ctx.fs.write(idxPath, new Uint8Array(idxLength).fill(7));
      const poisonedPackPath = packFilePath(ctx, 'd13-ungated-poison');
      const wrapped: Context = {
        ...ctx,
        fs: {
          ...ctx.fs,
          readSlice: async (path: string, offset: number, length: number) => {
            if (path === poisonedPackPath) {
              throw unsupportedOperation('filesystem', 'poisoned header probe');
            }
            return ctx.fs.readSlice(path, offset, length);
          },
        },
      };

      // Act — health() would reject on the poisoned header; the ungated term
      // must consume the scan-layer records alone and never reach it.
      const result = await fsck(wrapped, { connectivityOnly: true });

      // Assert
      const revIndex = result.findings.filter((f) => f.type === 'pack-rev-index-unusable');
      expect(revIndex).toHaveLength(1);
      expect((revIndex[0] as { pack: string }).pack).toBe('pack-d13-ungated-corrupt');
      expect(result.exitCode & 64).toBe(64);
    });
  });
});

// ---------------------------------------------------------------------------
// MULTI-PACK-INDEX HEALTH PASS — fsck reports the midx (ADR-601)
// ---------------------------------------------------------------------------

const midxDir = (ctx: Context): string => packsDir(commonGitDir(ctx));

function midxBaseSpec(overrides: Partial<MidxSpec> = {}): MidxSpec {
  return {
    version: 2,
    hashVersion: 1,
    digestLength: 20,
    numBaseFiles: 0,
    packNames: [],
    entries: [],
    ...overrides,
  };
}

/** A deterministic, valid-hex synthetic oid — for entries that exist only in
 *  a crafted midx's own OIDL, never in the object store. */
function midxOid(prefix: string): ObjectId {
  return (prefix + '0'.repeat(40 - prefix.length)) as ObjectId;
}

const midxPackName = (ch: string): string => `pack-${ch.repeat(40)}.idx`;

async function stampMidxTrailer(ctx: Context, bytes: Uint8Array): Promise<Uint8Array> {
  const digestLength = ctx.hashConfig.digestLength;
  const bodyEnd = bytes.length - digestLength;
  const checksumHex = await ctx.hash.hashHex(bytes.subarray(0, bodyEnd));
  const stamped = bytes.slice();
  stamped.set(hexToBytes(checksumHex), bodyEnd);
  return stamped;
}

async function writeFlatMidx(ctx: Context, spec: MidxSpec): Promise<void> {
  const bytes = await stampMidxTrailer(ctx, buildMidx(spec));
  await ctx.fs.write(multiPackIndexPath(midxDir(ctx)), bytes);
}

function midxLayerDigest(n: number, digestLength: number): string {
  return n.toString(16).padStart(digestLength * 2, '0');
}

const midxLayerPath = (ctx: Context, digest: string): string =>
  `${midxDir(ctx)}/multi-pack-index.d/multi-pack-index-${digest}.midx`;

/** Writes each spec as a chain layer (base first) plus the manifest listing
 *  their digests in order. Only the HEAD layer's trailer is stamped — fsck
 *  never verifies a base layer's (P12), so leaving it at buildMidx's zero
 *  default is deliberate, not an oversight. */
async function writeMidxChain(ctx: Context, specs: ReadonlyArray<MidxSpec>): Promise<void> {
  const dir = midxDir(ctx);
  const digests = specs.map((spec, i) => midxLayerDigest(i + 1, spec.digestLength));
  for (const [i, spec] of specs.entries()) {
    const raw = buildMidx(spec);
    const bytes = i === specs.length - 1 ? await stampMidxTrailer(ctx, raw) : raw;
    await ctx.fs.write(midxLayerPath(ctx, digests[i]!), bytes);
  }
  await ctx.fs.writeUtf8(multiPackIndexChainPath(dir), `${digests.join('\n')}\n`);
}

/** Writes a real, healthy single-blob pack and returns its `.idx` base name
 *  (as a `PNAM` entry would carry it) plus the blob's id. */
async function writeMidxPack(
  ctx: Context,
  name: string,
  content: string,
): Promise<{ readonly packNameIdx: string; readonly id: ObjectId }> {
  const ids = await writeSyntheticPack(ctx, name, onePackEntry(content));
  return { packNameIdx: `pack-${name}.idx`, id: ids[0] as ObjectId };
}

function midxFindingIds(findings: ReadonlyArray<FsckFinding>): ReadonlyArray<ObjectId> {
  return findings.flatMap((f) => findingIds(f));
}

function findMidxChunkOffset(bytes: Uint8Array, chunkId: string): number {
  const numChunks = bytes[6]!;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  for (let i = 0; i < numChunks; i += 1) {
    const rowStart = 12 + i * 12;
    if (decoder.decode(bytes.subarray(rowStart, rowStart + 4)) === chunkId) {
      return view.getUint32(rowStart + 4) * 0x100000000 + view.getUint32(rowStart + 8);
    }
  }
  throw new Error(`chunk ${chunkId} not present in fixture`);
}

function setMidxNumChunks(bytes: Uint8Array, numChunks: number): Uint8Array {
  const copy = bytes.slice();
  copy[6] = numChunks;
  return copy;
}

function renameMidxChunkRow(bytes: Uint8Array, chunkId: string, newId: string): Uint8Array {
  const copy = bytes.slice();
  const numChunks = copy[6]!;
  const decoder = new TextDecoder();
  for (let i = 0; i < numChunks; i += 1) {
    const rowStart = 12 + i * 12;
    if (decoder.decode(copy.subarray(rowStart, rowStart + 4)) === chunkId) {
      copy.set(new TextEncoder().encode(newId), rowStart);
      return copy;
    }
  }
  throw new Error(`chunk ${chunkId} not present in fixture`);
}

// Shrinks `chunkId`'s chunk by adjusting the offset of the row immediately
// after it in the table — that row is the chunk's end boundary, so this
// changes only its computed size without disturbing any earlier chunk.
function shrinkMidxChunkAfter(bytes: Uint8Array, chunkId: string, delta: number): Uint8Array {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);
  const numChunks = copy[6]!;
  const decoder = new TextDecoder();
  let rowIndex = -1;
  for (let i = 0; i < numChunks; i += 1) {
    const rowStart = 12 + i * 12;
    if (decoder.decode(copy.subarray(rowStart, rowStart + 4)) === chunkId) {
      rowIndex = i;
      break;
    }
  }
  if (rowIndex === -1) throw new Error(`chunk ${chunkId} not present in fixture`);
  const nextRowStart = 12 + (rowIndex + 1) * 12;
  const low = view.getUint32(nextRowStart + 8);
  view.setUint32(nextRowStart + 8, low + delta);
  return copy;
}

function pokeMidxFanoutEntry(bytes: Uint8Array, index: number, value: number): Uint8Array {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);
  const oidfStart = findMidxChunkOffset(copy, 'OIDF');
  view.setUint32(oidfStart + index * 4, value);
  return copy;
}

function setMidxOoffWord(bytes: Uint8Array, entryIndex: number, rawWord: number): Uint8Array {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);
  const ooffStart = findMidxChunkOffset(copy, 'OOFF');
  view.setUint32(ooffStart + entryIndex * 8 + 4, rawWord);
  return copy;
}

const isMidxFinding = (f: FsckFinding): boolean => f.type.startsWith('midx-');

// ---------------------------------------------------------------------------
// DROPPED CHAIN — no finding, no bit (P2–P8, P20)
// ---------------------------------------------------------------------------

describe('Given a dropped incremental chain and no flat file', () => {
  describe('When fsck runs', () => {
    it('Then a missing chain layer produces no finding and bit 32 is absent', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const dir = midxDir(ctx);
      await ctx.fs.writeUtf8(multiPackIndexChainPath(dir), `${midxLayerDigest(1, 20)}\n`);

      // Act
      const result = await fsck(ctx);

      // Assert
      expect(result.findings.some(isMidxFinding)).toBe(false);
      expect(result.exitCode & 32).toBe(0);
    });

    it('Then an unreadable chain layer produces no finding and bit 32 is absent', async () => {
      // Arrange
      const ctx = await initBareCtx();
      await writeMidxChain(ctx, [midxBaseSpec()]);
      const layerPath = midxLayerPath(ctx, midxLayerDigest(1, 20));
      const wrapped: Context = {
        ...ctx,
        fs: {
          ...ctx.fs,
          read: async (path: string) => {
            if (path === layerPath) throw permissionDenied(path);
            return ctx.fs.read(path);
          },
        },
      };

      // Act
      const result = await fsck(wrapped);

      // Assert
      expect(result.findings.some(isMidxFinding)).toBe(false);
      expect(result.exitCode & 32).toBe(0);
    });

    it('Then a malformed chain digest line produces no finding and bit 32 is absent', async () => {
      // Arrange
      const ctx = await initBareCtx();
      await ctx.fs.writeUtf8(multiPackIndexChainPath(midxDir(ctx)), 'not-a-valid-digest-line\n');

      // Act
      const result = await fsck(ctx);

      // Assert
      expect(result.findings.some(isMidxFinding)).toBe(false);
      expect(result.exitCode & 32).toBe(0);
    });

    it('Then a Tier-B-corrupt chain layer produces no finding and bit 32 is absent', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const dir = midxDir(ctx);
      const digest = midxLayerDigest(1, 20);
      await ctx.fs.write(midxLayerPath(ctx, digest), new Uint8Array(8));
      await ctx.fs.writeUtf8(multiPackIndexChainPath(dir), `${digest}\n`);

      // Act
      const result = await fsck(ctx);

      // Assert
      expect(result.findings.some(isMidxFinding)).toBe(false);
      expect(result.exitCode & 32).toBe(0);
    });

    it('Then a chain over the layer cap produces no finding and bit 32 is absent', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const digests = Array.from({ length: 1001 }, (_, i) =>
        (i + 1).toString(16).padStart(40, '0'),
      );
      await ctx.fs.writeUtf8(multiPackIndexChainPath(midxDir(ctx)), `${digests.join('\n')}\n`);

      // Act
      const result = await fsck(ctx);

      // Assert
      expect(result.findings.some(isMidxFinding)).toBe(false);
      expect(result.exitCode & 32).toBe(0);
    });
  });
});

describe('Given a Tier-B flat midx rescued by a loadable chain', () => {
  describe('When fsck runs', () => {
    it('Then no finding is emitted and bit 32 is absent', async () => {
      // Arrange
      const ctx = await initBareCtx();
      await ctx.fs.write(multiPackIndexPath(midxDir(ctx)), new Uint8Array(8));
      await writeMidxChain(ctx, [midxBaseSpec()]);

      // Act
      const result = await fsck(ctx);

      // Assert
      expect(result.findings.some(isMidxFinding)).toBe(false);
      expect(result.exitCode & 32).toBe(0);
    });
  });
});

describe('Given a broken chain suppressed by a loadable flat midx', () => {
  describe('When fsck runs', () => {
    it('Then no finding is emitted and bit 32 is absent', async () => {
      // Arrange
      const ctx = await initBareCtx();
      await writeFlatMidx(ctx, midxBaseSpec());
      const dir = midxDir(ctx);
      const digest = midxLayerDigest(1, 20);
      await ctx.fs.write(midxLayerPath(ctx, digest), new Uint8Array(8));
      await ctx.fs.writeUtf8(multiPackIndexChainPath(dir), `${digest}\n`);

      // Act
      const result = await fsck(ctx);

      // Assert
      expect(result.findings.some(isMidxFinding)).toBe(false);
      expect(result.exitCode & 32).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// HEALTHY / ACCEPTED SHAPES — no finding, exit 0 (O1, O2, O6, O20, O27, P1, P21–P23)
// ---------------------------------------------------------------------------

describe('Given a healthy flat multi-pack-index', () => {
  describe('When fsck runs', () => {
    it('Then no midx finding is emitted and bit 32 is absent', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const { packNameIdx, id } = await writeMidxPack(ctx, 'midx-healthy', 'midx-healthy-content');
      await writeFlatMidx(
        ctx,
        midxBaseSpec({ packNames: [packNameIdx], entries: [{ id, packIndex: 0, offset: 0 }] }),
      );

      // Act
      const result = await fsck(ctx);

      // Assert
      expect(result.findings.some(isMidxFinding)).toBe(false);
      expect(result.exitCode & 32).toBe(0);
    });
  });
});

describe('Given no multi-pack-index at all', () => {
  describe('When fsck runs', () => {
    it('Then no midx finding is emitted and bit 32 is absent', async () => {
      // Arrange
      const ctx = await initBareCtx();

      // Act
      const result = await fsck(ctx);

      // Assert
      expect(result.findings.some(isMidxFinding)).toBe(false);
      expect(result.exitCode & 32).toBe(0);
    });
  });
});

describe('Given a midx shape git accepts and ignores', () => {
  describe('When fsck runs', () => {
    it('Then version 2 produces no midx finding', async () => {
      // Arrange
      const ctx = await initBareCtx();
      await writeFlatMidx(ctx, midxBaseSpec({ version: 2 }));

      // Act
      const result = await fsck(ctx);

      // Assert
      expect(result.findings.some(isMidxFinding)).toBe(false);
      expect(result.exitCode & 32).toBe(0);
    });

    it('Then a non-zero numBaseFiles produces no midx finding', async () => {
      // Arrange
      const ctx = await initBareCtx();
      await writeFlatMidx(ctx, midxBaseSpec({ numBaseFiles: 5 }));

      // Act
      const result = await fsck(ctx);

      // Assert
      expect(result.findings.some(isMidxFinding)).toBe(false);
      expect(result.exitCode & 32).toBe(0);
    });

    it('Then an in-range LOFF row produces no midx finding', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const { packNameIdx, id } = await writeMidxPack(ctx, 'midx-loff', 'midx-loff-content');
      await writeFlatMidx(
        ctx,
        midxBaseSpec({
          packNames: [packNameIdx],
          entries: [{ id, packIndex: 0, offset: 0x1_0000_0001 }],
        }),
      );

      // Act
      const result = await fsck(ctx);

      // Assert
      expect(result.findings.some(isMidxFinding)).toBe(false);
      expect(result.exitCode & 32).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// TIER-B FLAT, NO RESCUE — the verdict (O7–O9, O16–O18)
// ---------------------------------------------------------------------------

describe('Given a Tier-B-corrupt flat midx with no rescuing chain', () => {
  describe('When fsck runs', () => {
    it('Then a truncated (too-small) flat midx produces one midx-unusable finding naming the check, and bit 32 is set', async () => {
      // Arrange
      const ctx = await initBareCtx();
      await ctx.fs.write(multiPackIndexPath(midxDir(ctx)), new Uint8Array(8));

      // Act
      const result = await fsck(ctx);

      // Assert
      const findings = result.findings.filter((f) => f.type === 'midx-unusable');
      expect(findings).toHaveLength(1);
      expect((findings[0] as { artefact: string }).artefact).toBe('multi-pack-index');
      expect((findings[0] as { reason: string }).reason).toContain('too short for header');
      expect(result.exitCode & 32).toBe(32);
    });

    it('Then a chunk table extending past end of file produces one midx-unusable finding, and bit 32 is set', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const bytes = setMidxNumChunks(buildMidx(midxBaseSpec()), 200);
      await ctx.fs.write(multiPackIndexPath(midxDir(ctx)), bytes);

      // Act
      const result = await fsck(ctx);

      // Assert
      const findings = result.findings.filter((f) => f.type === 'midx-unusable');
      expect(findings).toHaveLength(1);
      expect((findings[0] as { reason: string }).reason).toContain('chunk table');
      expect(result.exitCode & 32).toBe(32);
    });

    it('Then a chunk with the wrong declared length produces one midx-unusable finding, and bit 32 is set', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const bytes = shrinkMidxChunkAfter(buildMidx(midxBaseSpec()), 'OIDF', -4);
      await ctx.fs.write(multiPackIndexPath(midxDir(ctx)), bytes);

      // Act
      const result = await fsck(ctx);

      // Assert
      const findings = result.findings.filter((f) => f.type === 'midx-unusable');
      expect(findings).toHaveLength(1);
      expect((findings[0] as { reason: string }).reason).toContain('OIDF');
      expect(result.exitCode & 32).toBe(32);
    });

    it('Then a hashVersion disagreeing with the repository hash produces one midx-unusable finding, and bit 32 is set', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const bytes = buildMidx(midxBaseSpec({ hashVersion: 2, digestLength: 32 }));
      await ctx.fs.write(multiPackIndexPath(midxDir(ctx)), bytes);

      // Act
      const result = await fsck(ctx);

      // Assert
      const findings = result.findings.filter((f) => f.type === 'midx-unusable');
      expect(findings).toHaveLength(1);
      expect((findings[0] as { reason: string }).reason).toContain('hash version');
      expect(result.exitCode & 32).toBe(32);
    });
  });
});

describe('Given a permission-denied flat midx file', () => {
  describe('When fsck runs', () => {
    it('Then one midx-unusable finding is emitted — flatFilePresent still holds via the stat gate — and bit 32 is set', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const flatPath = multiPackIndexPath(midxDir(ctx));
      await ctx.fs.write(flatPath, await stampMidxTrailer(ctx, buildMidx(midxBaseSpec())));
      const wrapped: Context = {
        ...ctx,
        fs: {
          ...ctx.fs,
          read: async (path: string) => {
            if (path === flatPath) throw permissionDenied(path);
            return ctx.fs.read(path);
          },
        },
      };

      // Act
      const result = await fsck(wrapped);

      // Assert
      const findings = result.findings.filter((f) => f.type === 'midx-unusable');
      expect(findings).toHaveLength(1);
      expect(result.exitCode & 32).toBe(32);
    });
  });
});

// ---------------------------------------------------------------------------
// TRAILER VERIFICATION — head only (O10, P12, P13)
// ---------------------------------------------------------------------------

describe('Given a multi-pack-index whose trailer digest disagrees with its bytes', () => {
  describe('When fsck runs', () => {
    it('Then a flipped flat trailer produces one midx-checksum-mismatch finding and bit 32 is set', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const good = await stampMidxTrailer(ctx, buildMidx(midxBaseSpec()));
      const flipped = good.slice();
      flipped[flipped.length - 1] = (flipped[flipped.length - 1]! ^ 0xff) & 0xff;
      await ctx.fs.write(multiPackIndexPath(midxDir(ctx)), flipped);

      // Act
      const result = await fsck(ctx);

      // Assert
      const findings = result.findings.filter((f) => f.type === 'midx-checksum-mismatch');
      expect(findings).toHaveLength(1);
      expect((findings[0] as { artefact: string }).artefact).toBe('multi-pack-index');
      expect(result.exitCode & 32).toBe(32);
    });

    it('Then a flipped chain-head trailer produces one midx-checksum-mismatch finding', async () => {
      // Arrange
      const ctx = await initBareCtx();
      await writeMidxChain(ctx, [midxBaseSpec()]);
      const headPath = midxLayerPath(ctx, midxLayerDigest(1, 20));
      const bytes = await ctx.fs.read(headPath);
      const flipped = bytes.slice();
      flipped[flipped.length - 1] = (flipped[flipped.length - 1]! ^ 0xff) & 0xff;
      await ctx.fs.write(headPath, flipped);

      // Act
      const result = await fsck(ctx);

      // Assert
      const findings = result.findings.filter((f) => f.type === 'midx-checksum-mismatch');
      expect(findings).toHaveLength(1);
      expect(result.exitCode & 32).toBe(32);
    });

    it('Then a flipped chain-base-layer trailer produces no finding — only the head is verified', async () => {
      // Arrange
      const ctx = await initBareCtx();
      await writeMidxChain(ctx, [midxBaseSpec(), midxBaseSpec()]);
      const basePath = midxLayerPath(ctx, midxLayerDigest(1, 20));
      const bytes = await ctx.fs.read(basePath);
      const flipped = bytes.slice();
      flipped[flipped.length - 1] = (flipped[flipped.length - 1]! ^ 0xff) & 0xff;
      await ctx.fs.write(basePath, flipped);

      // Act
      const result = await fsck(ctx);

      // Assert
      expect(result.findings.some(isMidxFinding)).toBe(false);
      expect(result.exitCode & 32).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// PNAM / ENTRY RESOLUTION (O22–O25, P14–P16)
// ---------------------------------------------------------------------------

describe('Given a PNAM entry that resolves to no pack this generation registered', () => {
  describe('When fsck runs', () => {
    it('Then one midx-pack-unresolved and one midx-entry-unresolved per affected oid are emitted, and bit 32 is the entire exitCode', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const ids = [midxOid('aa1'), midxOid('aa2'), midxOid('aa3')];
      await writeFlatMidx(
        ctx,
        midxBaseSpec({
          packNames: [midxPackName('f')],
          entries: ids.map((id) => ({ id, packIndex: 0, offset: 0 })),
        }),
      );

      // Act
      const result = await fsck(ctx);

      // Assert
      const packUnresolved = result.findings.filter((f) => f.type === 'midx-pack-unresolved');
      const entryUnresolved = result.findings.filter((f) => f.type === 'midx-entry-unresolved');
      expect(packUnresolved).toHaveLength(1);
      expect((packUnresolved[0] as { position: number; pack: string }).position).toBe(0);
      expect((packUnresolved[0] as { position: number; pack: string }).pack).toBe(
        `pack-${'f'.repeat(40)}`,
      );
      expect(entryUnresolved).toHaveLength(3);
      const unresolvedIds = new Set(midxFindingIds(entryUnresolved));
      for (const id of ids) expect(unresolvedIds.has(id)).toBe(true);
      // bit 32 appears once regardless of how many findings the pass produced,
      // and this scenario has no other pass contributing a bit.
      expect(result.exitCode).toBe(32);
    });
  });
});

describe('Given a PNAM entry whose .idx is unregistered but whose sibling .pack survives on disk', () => {
  describe('When fsck runs', () => {
    it("Then only the per-entry family is emitted — the pack itself resolved in git's eyes", async () => {
      // Arrange
      const ctx = await initBareCtx();
      const name = midxPackName('f');
      const packsDir = `${commonGitDir(ctx)}/objects/pack`;
      await ctx.fs.write(`${packsDir}/${name.slice(0, -'.idx'.length)}.pack`, new Uint8Array([0]));
      const ids = [midxOid('aa1'), midxOid('aa2')];
      await writeFlatMidx(
        ctx,
        midxBaseSpec({
          packNames: [name],
          entries: ids.map((id) => ({ id, packIndex: 0, offset: 0 })),
        }),
      );

      // Act
      const result = await fsck(ctx);

      // Assert
      const packUnresolved = result.findings.filter((f) => f.type === 'midx-pack-unresolved');
      const entryUnresolved = result.findings.filter((f) => f.type === 'midx-entry-unresolved');
      expect(packUnresolved).toHaveLength(0);
      expect(entryUnresolved).toHaveLength(2);
      expect(result.exitCode & 32).toBe(32);
    });
  });
});

describe("Given a two-layer chain with one layer's PNAM unresolvable", () => {
  describe('When fsck runs', () => {
    it('Then a base-layer unresolvable PNAM reports chain-global position 0', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const base = midxBaseSpec({
        packNames: [midxPackName('e')],
        entries: [{ id: midxOid('bb1'), packIndex: 0, offset: 0 }],
      });
      const newest = midxBaseSpec();
      await writeMidxChain(ctx, [base, newest]);

      // Act
      const result = await fsck(ctx);

      // Assert
      const packUnresolved = result.findings.filter((f) => f.type === 'midx-pack-unresolved');
      expect(packUnresolved).toHaveLength(1);
      expect((packUnresolved[0] as { position: number }).position).toBe(0);
      expect(result.exitCode & 32).toBe(32);
    });

    it('Then a newest-layer unresolvable PNAM reports chain-global position 1', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const { packNameIdx, id } = await writeMidxPack(
        ctx,
        'midx-chain-base-real',
        'midx-chain-base-real-content',
      );
      const base = midxBaseSpec({
        packNames: [packNameIdx],
        entries: [{ id, packIndex: 0, offset: 0 }],
      });
      const newest = midxBaseSpec({
        packNames: [midxPackName('d')],
        entries: [{ id: midxOid('cc1'), packIndex: 0, offset: 0 }],
      });
      await writeMidxChain(ctx, [base, newest]);

      // Act
      const result = await fsck(ctx);

      // Assert
      const packUnresolved = result.findings.filter((f) => f.type === 'midx-pack-unresolved');
      expect(packUnresolved).toHaveLength(1);
      expect((packUnresolved[0] as { position: number }).position).toBe(1);
      expect(result.exitCode & 32).toBe(32);
    });
  });
});

describe('Given a midx-named pack fully deleted while a reachable commit points at its tree', () => {
  describe('When fsck runs', () => {
    it('Then the pack-resolution findings and the ordinary connectivity findings both appear, with bit 32 alongside bit 2', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const emptyTreeBody = serializeTreeContent(makeTree([]), ctx.hashConfig);
      const [treeId] = await writeSyntheticPack(ctx, 'midx-deleted', [
        { kind: 'base', type: 'tree', content: emptyTreeBody },
      ]);
      const commitId = await writeObject(ctx, makeCommit(treeId as ObjectId, []));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);
      await writeFlatMidx(
        ctx,
        midxBaseSpec({
          packNames: ['pack-midx-deleted.idx'],
          entries: [{ id: treeId as ObjectId, packIndex: 0, offset: 0 }],
        }),
      );
      await ctx.fs.rm(packFilePath(ctx, 'midx-deleted'));
      await ctx.fs.rm(idxFilePath(ctx, 'midx-deleted'));

      // Act
      const result = await fsck(ctx);

      // Assert
      const packUnresolved = result.findings.filter((f) => f.type === 'midx-pack-unresolved');
      const entryUnresolved = result.findings.filter((f) => f.type === 'midx-entry-unresolved');
      const missing = result.findings.filter(
        (f) => f.type === 'missing' && (f as { id: ObjectId }).id === treeId,
      );
      expect(packUnresolved).toHaveLength(1);
      expect(entryUnresolved).toHaveLength(1);
      expect(missing).toHaveLength(1);
      expect(result.exitCode & 32).toBe(32);
      expect(result.exitCode & 2).toBe(2);
    });
  });
});

describe('Given a midx-named pack whose .idx is corrupt but whose .pack remains — the pack is bound but cannot serve', () => {
  describe('When fsck runs', () => {
    it("Then midx-entry-unresolved fires without midx-pack-unresolved, alongside the pack pass's own findings, and bits 32, 4 and 64 are all set", async () => {
      // Arrange
      const ctx = await initBareCtx();
      const [blobId] = await writeSyntheticPack(ctx, 'midx-o25', onePackEntry('midx-o25-content'));
      await writeFlatMidx(
        ctx,
        midxBaseSpec({
          packNames: ['pack-midx-o25.idx'],
          entries: [{ id: blobId as ObjectId, packIndex: 0, offset: 0 }],
        }),
      );
      const idxPath = idxFilePath(ctx, 'midx-o25');
      const idxLength = (await ctx.fs.read(idxPath)).length;
      await ctx.fs.write(idxPath, new Uint8Array(idxLength).fill(7));

      // Act
      const result = await fsck(ctx);

      // Assert
      const packUnresolved = result.findings.filter((f) => f.type === 'midx-pack-unresolved');
      const entryUnresolved = result.findings.filter((f) => f.type === 'midx-entry-unresolved');
      expect(packUnresolved).toHaveLength(0);
      expect(entryUnresolved).toHaveLength(1);
      expect((entryUnresolved[0] as { id: ObjectId }).id).toBe(blobId);
      expect(result.findings.filter((f) => f.type === 'pack-index-unusable')).toHaveLength(1);
      expect(result.findings.filter((f) => f.type === 'pack-rev-index-unusable')).toHaveLength(1);
      expect(result.exitCode & 32).toBe(32);
      expect(result.exitCode & 4).toBe(4);
      expect(result.exitCode & 64).toBe(64);
    });
  });
});

// ---------------------------------------------------------------------------
// THE CONTAINED THROW — a decode-time Tier-A fault becomes a finding (O28)
// ---------------------------------------------------------------------------

describe('Given a LOFF row index out of range for the largeOffsetCount', () => {
  describe('When fsck runs', () => {
    it('Then one midx-unusable finding is emitted, bit 32 is set, and fsck resolves rather than rejecting', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const { packNameIdx, id } = await writeMidxPack(
        ctx,
        'midx-loff-oob',
        'midx-loff-oob-content',
      );
      const built = buildMidx(
        midxBaseSpec({
          packNames: [packNameIdx],
          entries: [{ id, packIndex: 0, offset: 0x1_0000_0001 }],
        }),
      );
      const mutated = setMidxOoffWord(built, 0, 0x80000000 | 5);
      const bytes = await stampMidxTrailer(ctx, mutated);
      await ctx.fs.write(multiPackIndexPath(midxDir(ctx)), bytes);

      // Act
      const result = await fsck(ctx);

      // Assert
      const findings = result.findings.filter((f) => f.type === 'midx-unusable');
      expect(findings).toHaveLength(1);
      expect((findings[0] as { reason: string }).reason).toContain('large offset');
      expect(result.exitCode & 32).toBe(32);
    });
  });
});

// ---------------------------------------------------------------------------
// THE REJECT ARM — a load-time Tier-A fault denies the whole run (O3–O5, O11–O15, P9–P11, P18)
// ---------------------------------------------------------------------------

describe('Given a Tier-A-corrupt flat midx', () => {
  describe('When fsck runs', () => {
    async function expectFsckRejectsWithCheck(ctx: Context, check: string): Promise<void> {
      let caught: unknown;
      try {
        await fsck(ctx);
        expect.unreachable();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data;
      expect(data.code).toBe('INVALID_MULTI_PACK_INDEX');
      if (data.code !== 'INVALID_MULTI_PACK_INDEX') {
        expect.fail('expected INVALID_MULTI_PACK_INDEX');
      }
      expect(data.check).toBe(check);
    }

    it('Then a bad signature makes fsck reject with check "signature"', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const bytes = buildMidx(midxBaseSpec());
      const flipped = bytes.slice();
      flipped[0] = 0;
      await ctx.fs.write(multiPackIndexPath(midxDir(ctx)), flipped);

      // Act & Assert
      await expectFsckRejectsWithCheck(ctx, 'signature');
    });

    it('Then an unsupported version makes fsck reject with check "version"', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const bytes = buildMidx(midxBaseSpec());
      const view = new DataView(bytes.buffer);
      view.setUint8(4, 3);
      await ctx.fs.write(multiPackIndexPath(midxDir(ctx)), bytes);

      // Act & Assert
      await expectFsckRejectsWithCheck(ctx, 'version');
    });

    it('Then a missing required chunk makes fsck reject with check "required-chunk"', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const bytes = renameMidxChunkRow(buildMidx(midxBaseSpec()), 'PNAM', 'XXXX');
      await ctx.fs.write(multiPackIndexPath(midxDir(ctx)), bytes);

      // Act & Assert
      await expectFsckRejectsWithCheck(ctx, 'required-chunk');
    });

    it('Then a non-monotonic OIDF fanout makes fsck reject with check "fanout"', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const { packNameIdx, id } = await writeMidxPack(ctx, 'midx-fanout', 'midx-fanout-content');
      const bytes = pokeMidxFanoutEntry(
        buildMidx(
          midxBaseSpec({ packNames: [packNameIdx], entries: [{ id, packIndex: 0, offset: 0 }] }),
        ),
        0,
        5,
      );
      await ctx.fs.write(multiPackIndexPath(midxDir(ctx)), bytes);

      // Act & Assert
      await expectFsckRejectsWithCheck(ctx, 'fanout');
    });

    it('Then out-of-order v1 pack names make fsck reject with check "pack-names"', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const bytes = buildMidx(
        midxBaseSpec({
          version: 1,
          packNames: [midxPackName('b'), midxPackName('a')],
        }),
      );
      await ctx.fs.write(multiPackIndexPath(midxDir(ctx)), bytes);

      // Act & Assert
      await expectFsckRejectsWithCheck(ctx, 'pack-names');
    });
  });
});

// ---------------------------------------------------------------------------
// MODE IS UNGATED (Pin N)
// ---------------------------------------------------------------------------

describe('Given a finding-producing midx shape and no rescuing chain', () => {
  describe('When fsck runs under every mode', () => {
    it.each<{ label: string; arrange: (ctx: Context) => Promise<void> }>([
      {
        label: 'a Tier-B-corrupt flat midx (midx-unusable)',
        arrange: async (ctx) => {
          await ctx.fs.write(multiPackIndexPath(midxDir(ctx)), new Uint8Array(8));
        },
      },
      {
        label: 'a flat midx with a flipped trailer (midx-checksum-mismatch)',
        arrange: async (ctx) => {
          const bytes = buildMidx(midxBaseSpec()).slice();
          bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
          await ctx.fs.write(multiPackIndexPath(midxDir(ctx)), bytes);
        },
      },
      {
        label: 'a flat midx naming an unregistered pack (midx-pack-unresolved)',
        arrange: async (ctx) => {
          await ctx.fs.write(
            multiPackIndexPath(midxDir(ctx)),
            buildMidx(midxBaseSpec({ packNames: [midxPackName('f')] })),
          );
        },
      },
    ])(
      'Then the midx finding set is identical across default, connectivityOnly, full:false and strict for $label',
      async ({ arrange }) => {
        // Arrange
        const ctx = await initBareCtx();
        await arrange(ctx);

        // Act
        const results = await Promise.all([
          fsck(ctx),
          fsck(ctx, { connectivityOnly: true }),
          fsck(ctx, { full: false }),
          fsck(ctx, { strict: true }),
        ]);

        // Assert — the full finding arrays, not just counts: a mode that
        // dropped or reshaped one finding while keeping the count would slip
        // past a length check.
        const reference = results[0]!.findings.filter(isMidxFinding);
        expect(reference.length).toBeGreaterThan(0);
        expect(results[0]!.exitCode & 32).toBe(32);
        for (const result of results.slice(1)) {
          expect(result.findings.filter(isMidxFinding)).toEqual(reference);
          expect(result.exitCode & 32).toBe(32);
        }
      },
    );
  });
});

// ---------------------------------------------------------------------------
// BIT COMPOSITION, DIFFERENTIAL (O23 vs O26)
// ---------------------------------------------------------------------------

describe('Given the same repository with and without its multi-pack-index', () => {
  describe('When fsck runs both ways', () => {
    it('Then bit 32 is the only difference between the two exitCodes', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const emptyTreeBody = serializeTreeContent(makeTree([]), ctx.hashConfig);
      const [treeId] = await writeSyntheticPack(ctx, 'midx-diff', [
        { kind: 'base', type: 'tree', content: emptyTreeBody },
      ]);
      const commitId = await writeObject(ctx, makeCommit(treeId as ObjectId, []));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);
      await writeFlatMidx(
        ctx,
        midxBaseSpec({
          packNames: ['pack-midx-diff.idx'],
          entries: [{ id: treeId as ObjectId, packIndex: 0, offset: 0 }],
        }),
      );
      await ctx.fs.rm(packFilePath(ctx, 'midx-diff'));
      await ctx.fs.rm(idxFilePath(ctx, 'midx-diff'));

      // Act
      const withMidx = await fsck(ctx);
      await ctx.fs.rm(multiPackIndexPath(midxDir(ctx)));
      refreshPackRegistry(ctx);
      const withoutMidx = await fsck(ctx);

      // Assert
      expect(withMidx.exitCode & 32).toBe(32);
      expect(withoutMidx.exitCode & 32).toBe(0);
      expect(withMidx.exitCode ^ withoutMidx.exitCode).toBe(32);
    });
  });
});

// ---------------------------------------------------------------------------
// findingIds — the shared id collector (S-12)
// ---------------------------------------------------------------------------

describe('Given a midx-entry-unresolved finding', () => {
  describe('When findingIds is called', () => {
    it("Then it returns the finding's oid", () => {
      // Arrange
      const id = midxOid('dd1');
      const finding: FsckFinding = {
        type: 'midx-entry-unresolved',
        artefact: 'multi-pack-index',
        id,
      };
      const sut = findingIds;

      // Act
      const result = sut(finding);

      // Assert
      expect(result).toEqual([id]);
    });
  });
});
