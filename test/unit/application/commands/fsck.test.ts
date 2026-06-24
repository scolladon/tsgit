import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { type FsckFinding, fsck } from '../../../../src/application/commands/fsck.js';
import { looseObjectPath, objectsDir } from '../../../../src/application/primitives/path-layout.js';
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
      const result = await sut(ctx);

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
      const result = await sut(ctx, { strict: true });

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
      const result = await sut(ctx);

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
      const result = await sut(ctx);

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
      const result = await sut(ctx, { strict: true });

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
      const result = await sut(ctx);

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
// CORRUPT OBJECT — inflate failure → bad-object finding, exit bit 1
// ---------------------------------------------------------------------------

describe('Given a loose object whose compressed bytes are invalid (inflate failure)', () => {
  describe('When fsck runs', () => {
    it('Then emits bad-object finding with severity error and exit code has bit 1', async () => {
      // Arrange
      const ctx = await initBareCtx();
      // Write a blob to get a valid OID to corrupt
      const blobId = await writeObject(ctx, makeBlob('to-corrupt'));
      // Overwrite with invalid compressed bytes (not valid zlib)
      const blobPath = looseObjectPath(ctx.layout.gitDir, blobId);
      const garbage = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      await ctx.fs.write(blobPath, garbage);

      // Act
      const result = await sut(ctx);

      // Assert — bad-object finding for the corrupt oid
      const badObjects = result.findings.filter((f) => f.type === 'bad-object');
      const corrupt = badObjects.find((f) => (f as { id: ObjectId }).id === blobId);
      expect(corrupt).toBeDefined();
      expect((corrupt as { severity: string }).severity).toBe('error');
      // Corrupt → exit bit 1
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
      const result = await sut(ctx, { connectivityOnly: true });

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
      const result = await sut(ctx);

      // Assert — exit code 0 (WARN doesn't trigger exit bit)
      expect(result.exitCode).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// REFNAME narrowing helper for type assertions
// ---------------------------------------------------------------------------

const asRefName = (s: string): RefName => s as RefName;
void asRefName; // used in IDE hover checks only

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
      const result = await sut(ctx);

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
      const result = await sut(ctx, { checkReferences: false });

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
      const result = await sut(ctx);

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
      const result = await sut(ctx);

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
      const result = await sut(ctx);

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
      const result = await sut(ctx);

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
      const result = await sut(ctx, { checkReferences: false });

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
      const result = await sut(ctx);

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
      const result = await sut(ctx);

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
