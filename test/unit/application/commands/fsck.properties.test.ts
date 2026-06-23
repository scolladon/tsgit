/**
 * Property tests for the fsck command — lens 2 (compositional invariants):
 * the reachability closure satisfies algebraic invariants regardless of
 * the specific objects involved.
 *
 * Invariants under test:
 *   I1. An empty / healthy repo with all objects reachable yields no
 *       dangling or unreachable findings.
 *   I2. Adding exactly one unreachable blob (tip, no in-edge) adds exactly
 *       one `dangling` finding and at least one `unreachable` finding.
 *   I3. A present object that references a missing oid yields at least one
 *       `missing` finding and at least one `broken-link` finding, and sets
 *       exit code bit 2.
 *   I4. dangling ⊆ unreachable (every dangling object is also unreachable).
 *   I5. unreachable ∩ reached = ∅ (no reachable object is unreachable).
 */
import fc from 'fast-check';
import { describe, it } from 'vitest';
import { fsck } from '../../../../src/application/commands/fsck.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import { buildSeededContext } from '../primitives/fixtures.js';

const sut = fsck;

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

/** Arbitrary blob content: a non-empty printable ASCII string. */
const arbBlobContent = (): fc.Arbitrary<string> =>
  fc.string({ minLength: 1, maxLength: 64, unit: 'grapheme' }).filter((s) => s.length > 0);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeBlob = (content: string) => ({
  type: 'blob' as const,
  id: '' as ObjectId,
  content: enc.encode(content),
});

const makeTree = (entries: ReadonlyArray<{ mode: string; name: string; id: ObjectId }>) => ({
  type: 'tree' as const,
  id: '' as ObjectId,
  entries: entries.map((e) => ({
    mode: e.mode as typeof FILE_MODE.REGULAR,
    name: e.name,
    id: e.id,
  })),
});

const makeCommit = (tree: ObjectId, parents: ReadonlyArray<ObjectId>, msg: string) => ({
  type: 'commit' as const,
  id: '' as ObjectId,
  data: {
    tree,
    parents: [...parents],
    author: {
      name: 'Test',
      email: 'test@example.com',
      timestamp: 1_700_000_000,
      timezoneOffset: '+0000',
    },
    committer: {
      name: 'Test',
      email: 'test@example.com',
      timestamp: 1_700_000_000,
      timezoneOffset: '+0000',
    },
    message: msg,
    extraHeaders: [],
  },
});

// ---------------------------------------------------------------------------
// I1: empty/healthy repo → no dangling or unreachable findings
// ---------------------------------------------------------------------------

describe('Given an arbitrary healthy repo (all objects reachable)', () => {
  describe('When fsck runs', () => {
    it('Then there are no dangling or unreachable findings', async () => {
      await fc.assert(
        fc.asyncProperty(arbBlobContent(), async (content) => {
          // Arrange
          const ctx = await buildSeededContext();
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');

          const blobId = await writeObject(ctx, makeBlob(content));
          const treeId = await writeObject(
            ctx,
            makeTree([{ mode: FILE_MODE.REGULAR, name: 'file.txt', id: blobId }]),
          );
          const commitId = await writeObject(ctx, makeCommit(treeId, [], 'init'));
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

          // Act
          const result = await sut(ctx);

          // Assert
          const dangling = result.findings.filter((f) => f.type === 'dangling');
          const unreachable = result.findings.filter((f) => f.type === 'unreachable');
          return dangling.length === 0 && unreachable.length === 0 && result.exitCode === 0;
        }),
        { numRuns: 100 },
      );
    });
  });
});

// ---------------------------------------------------------------------------
// I2: adding one unreachable blob tip adds exactly one dangling finding
// ---------------------------------------------------------------------------

describe('Given a healthy repo plus one orphan blob tip', () => {
  describe('When fsck runs', () => {
    it('Then exactly one dangling finding is added for the orphan blob', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbBlobContent(),
          arbBlobContent(),
          async (reachableContent, orphanContent) => {
            // Arrange
            const ctx = await buildSeededContext();
            await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');

            const reachableBlobId = await writeObject(ctx, makeBlob(reachableContent));
            const treeId = await writeObject(
              ctx,
              makeTree([{ mode: FILE_MODE.REGULAR, name: 'file.txt', id: reachableBlobId }]),
            );
            const commitId = await writeObject(ctx, makeCommit(treeId, [], 'init'));
            await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

            // Baseline: no orphan blobs
            const baseResult = await sut(ctx);
            const baseDanglingCount = baseResult.findings.filter(
              (f) => f.type === 'dangling',
            ).length;

            // Add an orphan blob (tip, no in-edge)
            const orphanId = await writeObject(ctx, makeBlob(orphanContent));

            // Act
            const result = await sut(ctx);

            // Assert
            const danglingIds = result.findings
              .filter((f) => f.type === 'dangling')
              .map((f) => (f as { id: ObjectId }).id);

            // The orphan is dangling
            if (!danglingIds.includes(orphanId)) return false;
            // Exactly one new dangling finding added
            if (danglingIds.length !== baseDanglingCount + 1) return false;
            // It's also unreachable
            const unreachableIds = result.findings
              .filter((f) => f.type === 'unreachable')
              .map((f) => (f as { id: ObjectId }).id);
            if (!unreachableIds.includes(orphanId)) return false;

            return true;
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});

// ---------------------------------------------------------------------------
// I3: a commit referencing a missing tree → missing + broken-link + exit bit 2
// ---------------------------------------------------------------------------

describe('Given a commit pointing at a missing tree oid', () => {
  describe('When fsck runs', () => {
    it('Then emits at least one missing and one broken-link finding and exit code has bit 2', async () => {
      await fc.assert(
        fc.asyncProperty(fc.constant(null), async () => {
          // Arrange
          const ctx = await buildSeededContext();
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');

          // Use a stable "missing" oid (not written anywhere)
          const ghostTree = '0000000000000000000000000000000000009999' as ObjectId;
          const commitId = await writeObject(ctx, makeCommit(ghostTree, [], 'broken'));
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

          // Act
          const result = await sut(ctx);

          // Assert
          const missingCount = result.findings.filter((f) => f.type === 'missing').length;
          const brokenCount = result.findings.filter((f) => f.type === 'broken-link').length;

          return missingCount >= 1 && brokenCount >= 1 && (result.exitCode & 2) === 2;
        }),
        { numRuns: 50 },
      );
    });
  });
});

// ---------------------------------------------------------------------------
// I4: dangling ⊆ unreachable
// ---------------------------------------------------------------------------

describe('Given an arbitrary repo state', () => {
  describe('When fsck runs', () => {
    it('Then every dangling object is also unreachable (dangling ⊆ unreachable)', async () => {
      await fc.assert(
        fc.asyncProperty(arbBlobContent(), async (content) => {
          // Arrange: healthy repo + one orphan blob tip
          const ctx = await buildSeededContext();
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
          const blobId = await writeObject(ctx, makeBlob(content));
          const treeId = await writeObject(
            ctx,
            makeTree([{ mode: FILE_MODE.REGULAR, name: 'f.txt', id: blobId }]),
          );
          const commitId = await writeObject(ctx, makeCommit(treeId, [], 'c'));
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);
          // Add orphan blob
          await writeObject(ctx, makeBlob(`orphan-${content}`));

          // Act
          const result = await sut(ctx);

          // Assert: dangling ⊆ unreachable
          const unreachableSet = new Set(
            result.findings
              .filter((f) => f.type === 'unreachable')
              .map((f) => (f as { id: ObjectId }).id),
          );
          const danglingIds = result.findings
            .filter((f) => f.type === 'dangling')
            .map((f) => (f as { id: ObjectId }).id);

          return danglingIds.every((id) => unreachableSet.has(id));
        }),
        { numRuns: 100 },
      );
    });

    it('Then adding a root ref makes a previously-dangling object no longer dangling or unreachable', async () => {
      await fc.assert(
        fc.asyncProperty(arbBlobContent(), async (content) => {
          // Arrange: orphan blob, no refs except HEAD (unborn)
          const ctx = await buildSeededContext();
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
          const orphanId = await writeObject(ctx, makeBlob(content));

          // Without any ref: orphan is dangling
          const before = await sut(ctx);
          const wasDangling = before.findings.some(
            (f) => f.type === 'dangling' && (f as { id: ObjectId }).id === orphanId,
          );
          if (!wasDangling) return true; // skip: may not be the only state

          // Add a ref pointing at the blob (unusual but valid for the property)
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${orphanId}\n`);

          const after = await sut(ctx);
          const isDanglingAfter = after.findings.some(
            (f) => f.type === 'dangling' && (f as { id: ObjectId }).id === orphanId,
          );
          const isUnreachableAfter = after.findings.some(
            (f) => f.type === 'unreachable' && (f as { id: ObjectId }).id === orphanId,
          );

          return !isDanglingAfter && !isUnreachableAfter;
        }),
        { numRuns: 100 },
      );
    });
  });
});

// ---------------------------------------------------------------------------
// I5: unreachable objects are not in the reachable set (structural soundness)
// ---------------------------------------------------------------------------

describe('Given a repo with a mix of reachable and unreachable objects', () => {
  describe('When fsck runs', () => {
    it('Then no object appears in both unreachable and root/tagged findings', async () => {
      await fc.assert(
        fc.asyncProperty(arbBlobContent(), arbBlobContent(), async (reachable, orphan) => {
          // Arrange
          const ctx = await buildSeededContext();
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');

          const blobId = await writeObject(ctx, makeBlob(reachable));
          const treeId = await writeObject(
            ctx,
            makeTree([{ mode: FILE_MODE.REGULAR, name: 'a.txt', id: blobId }]),
          );
          const commitId = await writeObject(ctx, makeCommit(treeId, [], 'c'));
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);
          await writeObject(ctx, makeBlob(orphan)); // unreachable

          // Act
          const result = await sut(ctx);

          // Assert: unreachable ids do not appear in root/tagged
          const unreachableSet = new Set(
            result.findings
              .filter((f) => f.type === 'unreachable')
              .map((f) => (f as { id: ObjectId }).id),
          );
          const rootAndTaggedIds = result.findings
            .filter((f) => f.type === 'root' || f.type === 'tagged')
            .map((f) => (f as { id: ObjectId }).id);

          return rootAndTaggedIds.every((id) => !unreachableSet.has(id));
        }),
        { numRuns: 100 },
      );
    });
  });
});
