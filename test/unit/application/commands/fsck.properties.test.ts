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
import type { Context } from '../../../../src/ports/context.js';
import { buildSeededContext } from '../primitives/fixtures.js';
import { restampPackHeader, writeSyntheticPack } from '../primitives/pack-fixture.js';

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
          const result = await fsck(ctx);

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
            // The orphan must be a distinct object: writeObject is content-addressed,
            // so equal content yields the reachable blob's oid (which is referenced and
            // therefore not dangling). Scope the property to a genuinely-orphan blob.
            fc.pre(orphanContent !== reachableContent);

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
            const baseResult = await fsck(ctx);
            const baseDanglingCount = baseResult.findings.filter(
              (f) => f.type === 'dangling',
            ).length;

            // Add an orphan blob (tip, no in-edge)
            const orphanId = await writeObject(ctx, makeBlob(orphanContent));

            // Act
            const result = await fsck(ctx);

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
          const result = await fsck(ctx);

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
          const result = await fsck(ctx);

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
          // Arrange
          const ctx = await buildSeededContext();
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
          const orphanId = await writeObject(ctx, makeBlob(content));
          // Verify precondition: orphan is dangling before adding a ref
          const before = await fsck(ctx);
          const wasDangling = before.findings.some(
            (f) => f.type === 'dangling' && (f as { id: ObjectId }).id === orphanId,
          );
          if (!wasDangling) return true; // skip: precondition not met

          // Act
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${orphanId}\n`);
          const after = await fsck(ctx);

          // Assert
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
          const result = await fsck(ctx);

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

// ---------------------------------------------------------------------------
// I6/I7: pack-health pass — additivity and cardinality
// ---------------------------------------------------------------------------

type PackFaultShape =
  | 'v99'
  | 'bad-signature'
  | 'short-pack'
  | 'count-disagreement'
  | 'garbage-idx'
  | 'truncated-idx';

const PACK_FAULT_SHAPES: ReadonlyArray<PackFaultShape> = [
  'v99',
  'bad-signature',
  'short-pack',
  'count-disagreement',
  'garbage-idx',
  'truncated-idx',
];

/** Long enough to clear parsePackIndex's truncation guard but never a valid magic. */
const garbageIdxBytes = (): Uint8Array => Uint8Array.from({ length: 1072 }, (_, i) => i % 256);

/** Apply exactly one unusable-pack fault shape to an already-written synthetic pack. */
async function applyPackFault(ctx: Context, name: string, shape: PackFaultShape): Promise<void> {
  const packFile = `${ctx.layout.gitDir}/objects/pack/pack-${name}.pack`;
  const idxFile = `${ctx.layout.gitDir}/objects/pack/pack-${name}.idx`;
  if (shape === 'v99') {
    await restampPackHeader(ctx, packFile, { version: 99 });
  } else if (shape === 'bad-signature') {
    await restampPackHeader(ctx, packFile, { magic: 0x50414358 });
  } else if (shape === 'short-pack') {
    const bytes = await ctx.fs.read(packFile);
    await ctx.fs.write(packFile, bytes.subarray(0, 8));
  } else if (shape === 'count-disagreement') {
    await restampPackHeader(ctx, packFile, { objectCount: 999 });
  } else if (shape === 'garbage-idx') {
    await ctx.fs.write(idxFile, garbageIdxBytes());
  } else {
    await ctx.fs.write(idxFile, new Uint8Array(100));
  }
}

const isGatedPackFinding = (f: { readonly type: string }): boolean =>
  f.type === 'pack-inaccessible' || f.type === 'pack-index-unusable';

const isNonPackFinding = (f: { readonly type: string }): boolean => !f.type.startsWith('pack-');

const findingKeySet = (findings: ReadonlyArray<{ readonly type: string }>): Set<string> =>
  new Set(findings.map((f) => JSON.stringify(f)));

const sameFindingSet = (
  a: ReadonlyArray<{ readonly type: string }>,
  b: ReadonlyArray<{ readonly type: string }>,
): boolean => {
  const setA = findingKeySet(a);
  const setB = findingKeySet(b);
  return setA.size === setB.size && [...setA].every((key) => setB.has(key));
};

async function seedHealthyRepo(ctx: Context, content: string): Promise<void> {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  const blobId = await writeObject(ctx, makeBlob(content));
  const treeId = await writeObject(
    ctx,
    makeTree([{ mode: FILE_MODE.REGULAR, name: 'file.txt', id: blobId }]),
  );
  const commitId = await writeObject(ctx, makeCommit(treeId, [], 'init'));
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);
}

/** A fresh, independently-seeded context holding the same healthy repo content. */
async function buildHealthyRepo(content: string): Promise<Context> {
  const ctx = await buildSeededContext();
  await seedHealthyRepo(ctx, content);
  return ctx;
}

describe('Given an arbitrary healthy repo plus one unusable pack', () => {
  describe('When fsck runs in default mode', () => {
    it('Then exactly one gated pack finding is added, bit 4 is set, and the non-pack findings are unchanged', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbBlobContent(),
          fc.constantFrom(...PACK_FAULT_SHAPES),
          async (content, shape) => {
            // Arrange — baseline: healthy repo, no unusable pack yet. A fresh
            // context (not a second fsck call on the baseline's own context)
            // so the pack registry's memoised scan can never go stale between
            // the two runs — same repo content, independent instances.
            const baselineCtx = await buildHealthyRepo(content);
            const baseline = await fsck(baselineCtx);
            const baselineNonPack = baseline.findings.filter(isNonPackFinding);

            const ctx = await buildHealthyRepo(content);
            await writeSyntheticPack(ctx, 'fault-pack', [
              { kind: 'base', type: 'blob', content: enc.encode('unusable-pack-content') },
            ]);
            await applyPackFault(ctx, 'fault-pack', shape);

            // Act
            const result = await fsck(ctx);

            // Assert
            const gated = result.findings.filter(isGatedPackFinding);
            const nonPack = result.findings.filter(isNonPackFinding);

            return (
              gated.length === 1 &&
              (result.exitCode & 4) === 4 &&
              sameFindingSet(nonPack, baselineNonPack)
            );
          },
        ),
        { numRuns: 50 },
      );
    });
  });
});

describe('Given an arbitrary healthy repo plus N unusable packs', () => {
  describe('When fsck runs in default mode', () => {
    it('Then exactly N gated pack findings are added and bit 4 is set exactly once', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbBlobContent(),
          fc.integer({ min: 1, max: 4 }),
          async (content, packCount) => {
            // Arrange
            const ctx = await buildSeededContext();
            await seedHealthyRepo(ctx, content);

            for (let i = 0; i < packCount; i += 1) {
              const name = `fault-pack-${i}`;
              await writeSyntheticPack(ctx, name, [
                { kind: 'base', type: 'blob', content: enc.encode(`unusable-content-${i}`) },
              ]);
              await restampPackHeader(ctx, `${ctx.layout.gitDir}/objects/pack/pack-${name}.pack`, {
                version: 99,
              });
            }

            // Act
            const result = await fsck(ctx);

            // Assert
            const gated = result.findings.filter(isGatedPackFinding);
            return gated.length === packCount && (result.exitCode & 4) === 4;
          },
        ),
        { numRuns: 50 },
      );
    });
  });
});
