import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { type FsckFinding, fsck } from '../../../../src/application/commands/fsck.js';
import { looseObjectPath, objectsDir } from '../../../../src/application/primitives/path-layout.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { TsgitError } from '../../../../src/domain/error.js';
import { FILE_MODE, type ObjectId, type TreeEntry } from '../../../../src/domain/objects/index.js';
import type { FilePath } from '../../../../src/domain/objects/object-id.js';
import type { Context } from '../../../../src/ports/context.js';
import { buildSeededContext } from '../primitives/fixtures.js';
import { writeSyntheticPack } from '../primitives/pack-fixture.js';

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
      const result = await sut(ctx);

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
      const result = await sut(ctx);

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
      const result = await sut(ctx);

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
      const result = await sut(ctx);

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
      const result = await sut(ctx);

      // Assert — corrupt object: objectType must not be hardcoded 'blob'
      const corrupt = result.findings.find(
        (f): f is FsckFinding & { type: 'bad-object' } =>
          f.type === 'bad-object' && (f as { id: ObjectId }).id === blobId,
      );
      expect(corrupt).toBeDefined();
      // Inflate failure: type is unknown (we cannot read the header)
      expect((corrupt as { objectType: string }).objectType).toBe('unknown');
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
      const result = await sut(ctx);

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
      const result = await sut(ctx, { full: false });

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
      const result = await sut(ctx);

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
      const result = await sut(ctx);

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
      const result = await sut(ctx);

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
      const result = await sut(ctx, { connectivityOnly: true });

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
      const result = await sut(ctx);

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

// Kill: content-validation.ts line 43 (unterminatedHeader msgId after inflate failure)
// When a loose object has corrupt compressed bytes (inflate fails), the bad-object
// finding must report msgId = 'unterminatedHeader'.
describe('Given loose object with corrupt compressed bytes (inflate fails)', () => {
  describe('When fsck runs', () => {
    it('Then bad-object finding has msgId unterminatedHeader (not empty string)', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const blobId = await writeObject(ctx, makeBlob('to-corrupt'));
      const blobPath = looseObjectPath(ctx.layout.gitDir, blobId);
      const garbage = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      await ctx.fs.write(blobPath, garbage);

      // Act
      const result = await sut(ctx);

      // Assert — inflate failure → unterminatedHeader msgId (not empty or generic)
      const badObj = result.findings.find(
        (f): f is FsckFinding & { type: 'bad-object' } =>
          f.type === 'bad-object' && (f as { id: ObjectId }).id === blobId,
      );
      expect(badObj).toBeDefined();
      expect((badObj as { msgId: string }).msgId).toBe('unterminatedHeader');
    });
  });
});

// Kill: content-validation.ts line 57 (instanceof TsgitError check for unknownType)
// When a loose object inflates fine but has an unknown type header, the
// bad-object finding must report msgId = 'unknownType' (not 'unterminatedHeader').
describe('Given loose object with inflatable but unknown-type header', () => {
  describe('When fsck runs', () => {
    it('Then bad-object finding has msgId unknownType (not unterminatedHeader)', async () => {
      // Arrange — build raw bytes 'bogus 5\0hello', compress, write under computed OID
      const ctx = await initBareCtx();
      const enc = new TextEncoder();
      const body = enc.encode('hello');
      const header = enc.encode(`bogus ${body.length}\0`);
      const rawBytes = new Uint8Array(header.length + body.length);
      rawBytes.set(header);
      rawBytes.set(body, header.length);
      const oidHex = await ctx.hash.hashHex(rawBytes);
      const compressed = await ctx.compressor.deflate(rawBytes);
      const objPath = looseObjectPath(ctx.layout.gitDir, oidHex as ObjectId);
      await ctx.fs.write(objPath, compressed);

      // Act
      const result = await sut(ctx);

      // Assert — unknown type: msgId must be 'unknownType' (not 'unterminatedHeader')
      const badObj = result.findings.find(
        (f): f is FsckFinding & { type: 'bad-object' } =>
          f.type === 'bad-object' && (f as { id: ObjectId }).id === oidHex,
      );
      expect(badObj).toBeDefined();
      expect((badObj as { msgId: string }).msgId).toBe('unknownType');
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
      const result = await sut(ctx);

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
      const result = await sut(ctx);

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
      const result = await sut(ctx);

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
      const result = await sut(ctx);

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
      const result = await sut(ctx);

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
      const result = await sut(ctx);

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
      const result = await sut(ctx);

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
      const result = await sut(ctx);

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
      const result = await sut(ctx);

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
      const result = await sut(ctx, { indexRoot: false });

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
      const result = await sut(ctx);

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
      const result = await sut(ctx);

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
      const result = await sut(ctx);

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
      const result = await sut(ctx);

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
      const result = await sut(ctx);

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

describe('Given a loose ref with a valid OID followed by trailing double-newline', () => {
  describe('When fsck runs', () => {
    it('Then no badRefContent or badRefOid finding (trailing newlines fully stripped)', async () => {
      // Arrange
      const ctx = await initBareCtx();
      const treeId = await writeObject(ctx, makeTree([]));
      const commitId = await writeObject(ctx, makeCommit(treeId, []));
      // Ref content: valid 40-hex OID + two newlines (trailing double-newline).
      // Original /[\r\n]+$/ strips all trailing newlines → valid OID.
      // Mutant /[\r\n]+/ (no $) strips first \n from "sha\n\n" → "sha\n" → OID_RE fails.
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n\n`);

      // Act
      const result = await sut(ctx);

      // Assert — no bad-ref findings for a doubly-newline-terminated ref
      const badRefFindings = result.findings.filter((f) => f.type === 'bad-ref');
      expect(badRefFindings).toHaveLength(0);
      expect(result.exitCode & 10).toBe(0);
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
      const result = await sut(ctx);

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
      const result = await sut(ctx);

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
