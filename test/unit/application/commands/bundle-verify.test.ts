import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { bundleCreate } from '../../../../src/application/commands/bundle-create.js';
import {
  type BundleVerifyResult,
  bundleVerify,
} from '../../../../src/application/commands/bundle-verify.js';
import { createCommit } from '../../../../src/application/primitives/create-commit.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { parseBundleHeader, serializeBundleHeader } from '../../../../src/domain/bundle/index.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { AuthorIdentity, FileMode, ObjectId } from '../../../../src/domain/objects/index.js';
import type { RefName } from '../../../../src/domain/objects/object-id.js';
import type { Context } from '../../../../src/ports/context.js';
import type { FileStat } from '../../../../src/ports/file-system.js';
import { buildSyntheticPack, type EntrySpec } from '../primitives/pack-fixture.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

const AUTHOR: AuthorIdentity = {
  name: 'Test',
  email: 't@t.com',
  timestamp: 1_000_000_000,
  timezoneOffset: '+0000',
};

const BLOB_MODE = '100644' as FileMode;

const enc = new TextEncoder();

const makeBlob = async (ctx: Context, content: string): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'blob',
    id: '' as ObjectId,
    content: enc.encode(content),
  });

const makeCommitObj = async (
  ctx: Context,
  tree: ObjectId,
  parents: ReadonlyArray<ObjectId>,
  message: string,
  ts: number,
): Promise<ObjectId> =>
  createCommit(ctx, {
    tree,
    parents,
    author: { ...AUTHOR, timestamp: ts },
    committer: { ...AUTHOR, timestamp: ts },
    message,
  });

const setRef = async (ctx: Context, refPath: string, oid: ObjectId): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${refPath}`, `${oid}\n`);

const initRepo = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  return ctx;
};

/** A SHA-256 repository with one commit on main — for cross-format fixtures. */
const buildSha256SingleCommitRepo = async (): Promise<Context> => {
  const ctx = createMemoryContext({ algorithm: 'sha256' });
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  const tree = await writeTree(ctx, []);
  const commit = await makeCommitObj(ctx, tree, [], 'sha256 commit', 1);
  await setRef(ctx, 'refs/heads/main', commit);
  return ctx;
};

interface SingleCommitRepo {
  readonly ctx: Context;
  readonly commit1: ObjectId;
}

const buildSingleCommitRepo = async (): Promise<SingleCommitRepo> => {
  const ctx = await initRepo();
  const tree1 = await writeTree(ctx, []);
  const commit1 = await makeCommitObj(ctx, tree1, [], 'initial commit', 1);
  await setRef(ctx, 'refs/heads/main', commit1);
  return { ctx, commit1 };
};

interface TwoCommitRepo {
  readonly ctx: Context;
  readonly commit1: ObjectId;
  readonly commit2: ObjectId;
}

const buildTwoCommitRepo = async (): Promise<TwoCommitRepo> => {
  const ctx = await initRepo();
  const tree1 = await writeTree(ctx, []);
  const commit1 = await makeCommitObj(ctx, tree1, [], 'first commit', 1);
  const blob = await makeBlob(ctx, 'hello');
  const tree2 = await writeTree(ctx, [{ mode: BLOB_MODE, name: 'a.txt', id: blob }]);
  const commit2 = await makeCommitObj(ctx, tree2, [commit1], 'second commit', 2);
  await setRef(ctx, 'refs/heads/main', commit2);
  return { ctx, commit1, commit2 };
};

const MOCK_STAT: FileStat = {
  ctimeMs: 0,
  mtimeMs: 0,
  dev: 0,
  ino: 0,
  mode: 0o644,
  uid: 0,
  gid: 0,
  size: 0,
  isFile: true,
  isDirectory: false,
  isSymbolicLink: false,
};

const withReadPermissionDenied = (
  ctx: Context,
  targetPath: string,
  isDirectory: boolean,
): Context => ({
  ...ctx,
  fs: {
    ...ctx.fs,
    read: async (p: string): Promise<Uint8Array> => {
      if (p === targetPath) throw new TsgitError({ code: 'PERMISSION_DENIED', path: p });
      return ctx.fs.read(p);
    },
    stat: async (p: string): Promise<FileStat> => {
      if (p === targetPath) return { ...MOCK_STAT, isFile: !isDirectory, isDirectory };
      return ctx.fs.stat(p);
    },
  },
});

const BUNDLE_PATH = '/repo/test.bundle';

/** A bundle whose pack contains a REF_DELTA against `prereqOid` (thin pack). */
const buildThinBundle = async (ctx: Context, prereqOid: ObjectId): Promise<Uint8Array> => {
  const baseContent = enc.encode('base blob from prereq commit');
  const baseHeader = enc.encode(`blob ${baseContent.length}\0`);
  const baseRaw = new Uint8Array(baseHeader.length + baseContent.length);
  baseRaw.set(baseHeader, 0);
  baseRaw.set(baseContent, baseHeader.length);
  const baseId = await ctx.hash.hashHex(baseRaw);

  const targetContent = enc.encode('derived blob content');
  const targetHeader = enc.encode(`blob ${targetContent.length}\0`);
  const targetRaw = new Uint8Array(targetHeader.length + targetContent.length);
  targetRaw.set(targetHeader, 0);
  targetRaw.set(targetContent, targetHeader.length);
  const targetId = await ctx.hash.hashHex(targetRaw);

  const { packBytes } = await buildSyntheticPack(ctx, [
    {
      kind: 'ref-delta',
      baseId,
      baseUncompressed: baseContent,
      targetContent,
    } as EntrySpec,
  ]);

  const headerBytes = serializeBundleHeader({
    version: 2,
    hashAlgorithm: 'sha1',
    prerequisites: [{ oid: prereqOid, comment: 'test prereq' }],
    refs: [{ oid: targetId as ObjectId, name: 'refs/heads/main' as RefName }],
  });

  const bundleBytes = new Uint8Array(headerBytes.length + packBytes.length);
  bundleBytes.set(headerBytes, 0);
  bundleBytes.set(packBytes, headerBytes.length);
  return bundleBytes;
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('bundleVerify', () => {
  // ── complete-history bundle ────────────────────────────────────────────────

  describe('Given a complete-history bundle written to a path', () => {
    describe('When bundleVerify is called', () => {
      it('Then returns recordsCompleteHistory=true, prerequisitesPresent=true, refs and hashAlgorithm match', async () => {
        // Arrange
        const { ctx } = await buildSingleCommitRepo();
        const createResult = await bundleCreate(ctx, { all: true });
        await ctx.fs.write(BUNDLE_PATH, createResult.bytes);

        // Act
        const result = await bundleVerify(ctx, { path: BUNDLE_PATH });

        // Assert
        expect(result.version).toBe(2);
        expect(result.hashAlgorithm).toBe('sha1');
        expect(result.recordsCompleteHistory).toBe(true);
        expect(result.prerequisitesPresent).toBe(true);
        expect(result.missingPrerequisites).toEqual([]);
        expect(result.refs).toHaveLength(createResult.refs.length);
        expect(result.refs).toEqual(createResult.refs);
      });
    });
  });

  // ── prerequisite presence (CQS) ──────────────────────────────────────────

  describe('Given a range bundle and a repo that contains the prerequisite commit', () => {
    describe('When bundleVerify is called', () => {
      it('Then prerequisitesPresent is true and missingPrerequisites is empty', async () => {
        // Arrange
        const { ctx, commit1 } = await buildTwoCommitRepo();
        const createResult = await bundleCreate(ctx, {
          revs: [{ range: ['refs/heads/main~1', 'refs/heads/main'] }],
        });
        await ctx.fs.write(BUNDLE_PATH, createResult.bytes);

        // Act
        const result: BundleVerifyResult = await bundleVerify(ctx, { path: BUNDLE_PATH });

        // Assert
        expect(result.prerequisitesPresent).toBe(true);
        expect(result.missingPrerequisites).toEqual([]);
        expect(result.prerequisites).toEqual([{ oid: commit1, comment: 'first commit' }]);
      });
    });
  });

  describe('Given a bundle verified where its prerequisite is absent from the target repo', () => {
    describe('When bundleVerify is called', () => {
      it.each([
        {
          label: 'a range bundle bytes verified in a fresh empty repo',
          buildScenario: async (): Promise<{ ctx: Context; missing: ObjectId }> => {
            const { ctx: sourceCtx, commit1 } = await buildTwoCommitRepo();
            const createResult = await bundleCreate(sourceCtx, {
              revs: [{ range: ['refs/heads/main~1', 'refs/heads/main'] }],
            });
            const emptyCtx = await initRepo();
            await emptyCtx.fs.write(BUNDLE_PATH, createResult.bytes);
            return { ctx: emptyCtx, missing: commit1 };
          },
        },
        {
          label: 'a thin bundle whose REF_DELTA base is absent (no pack walk attempted)',
          buildScenario: async (): Promise<{ ctx: Context; missing: ObjectId }> => {
            const sourceCtx = await initRepo();
            const baseContent = enc.encode('base blob from prereq commit');
            const prereqOid = await writeObject(sourceCtx, {
              type: 'blob',
              id: '' as ObjectId,
              content: baseContent,
            });
            const bundleBytes = await buildThinBundle(sourceCtx, prereqOid);
            const emptyCtx = await initRepo();
            await emptyCtx.fs.write(BUNDLE_PATH, bundleBytes);
            return { ctx: emptyCtx, missing: prereqOid };
          },
        },
        {
          label: 'a range bundle with a corrupt pack trailer (no throw despite corruption)',
          buildScenario: async (): Promise<{ ctx: Context; missing: ObjectId }> => {
            const { ctx: sourceCtx, commit1 } = await buildTwoCommitRepo();
            const createResult = await bundleCreate(sourceCtx, {
              revs: [{ range: ['refs/heads/main~1', 'refs/heads/main'] }],
            });
            const corruptBytes = new Uint8Array(createResult.bytes);
            // Corrupt the pack trailer (last 20 bytes = SHA-1 digest)
            corruptBytes.set(new Uint8Array(20).fill(0xff), corruptBytes.length - 20);
            const emptyCtx = await initRepo();
            await emptyCtx.fs.write(BUNDLE_PATH, corruptBytes);
            return { ctx: emptyCtx, missing: commit1 };
          },
        },
      ])(
        'Then prerequisitesPresent is false and missingPrerequisites contains the boundary oid — $label',
        async ({ buildScenario }) => {
          // Arrange
          const { ctx, missing } = await buildScenario();

          // Act
          const result: BundleVerifyResult = await bundleVerify(ctx, { path: BUNDLE_PATH });

          // Assert
          expect(result.prerequisitesPresent).toBe(false);
          expect(result.missingPrerequisites).toContain(missing);
          expect(result.missingPrerequisites).toHaveLength(1);
        },
      );
    });
  });

  // ── isMissingObject: non-OBJECT_NOT_FOUND error → rethrow ────────────────

  describe('Given a range bundle whose prerequisite object exists but is unreadable (PERMISSION_DENIED)', () => {
    describe('When bundleVerify is called', () => {
      it('Then rethrows PERMISSION_DENIED (isMissingObject does not swallow non-OBJECT_NOT_FOUND errors)', async () => {
        // Arrange — build a two-commit repo, create a range bundle so commit1
        // is a prerequisite, then intercept reads of commit1's loose path.
        const { ctx, commit1 } = await buildTwoCommitRepo();
        const createResult = await bundleCreate(ctx, {
          revs: [{ range: ['refs/heads/main~1', 'refs/heads/main'] }],
        });
        await ctx.fs.write(BUNDLE_PATH, createResult.bytes);
        // F2.3 also populates the delta cache when `bundleCreate` reads
        // commit1's loose bytes above; drop that entry so the injected
        // PERMISSION_DENIED below is actually reached instead of being
        // masked by a cache hit.
        ctx.deltaCache.delete(commit1);

        const prereqLoosePath = `${ctx.layout.gitDir}/objects/${commit1.slice(0, 2)}/${commit1.slice(2)}`;
        const spyCtx: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            read: async (p: string): Promise<Uint8Array> => {
              if (p === prereqLoosePath) {
                throw new TsgitError({ code: 'PERMISSION_DENIED', path: p });
              }
              return ctx.fs.read(p);
            },
          },
        };

        // Act
        let thrown: unknown;
        try {
          await bundleVerify(spyCtx, { path: BUNDLE_PATH });
        } catch (err) {
          thrown = err;
        }

        // Assert — isMissingObject rethrows the PERMISSION_DENIED error
        expect(thrown).toBeInstanceOf(TsgitError);
        expect((thrown as TsgitError).data.code).toBe('PERMISSION_DENIED');
      });
    });
  });

  // ── full pack parse (corrupt pack) ────────────────────────────────────────

  describe('Given bundle bytes with a flipped byte in the pack body', () => {
    describe('When bundleVerify is called', () => {
      it('Then throws INVALID_PACK_HEADER (pack-header parse failure)', async () => {
        // Arrange
        const { ctx } = await buildSingleCommitRepo();
        const createResult = await bundleCreate(ctx, { all: true });
        const bundleHeader = parseBundleHeader(createResult.bytes, 'test');
        const corruptBytes = new Uint8Array(createResult.bytes);
        // Flip a byte in the pack body (after the 12-byte pack header)
        const PACK_HEADER_SIZE = 12;
        const flipIdx = bundleHeader.packOffset + PACK_HEADER_SIZE;
        corruptBytes.set([((corruptBytes[flipIdx] ?? 0) ^ 0xff) & 0xff], flipIdx);
        await ctx.fs.write(BUNDLE_PATH, corruptBytes);

        // Act
        let thrown: unknown;
        try {
          await bundleVerify(ctx, { path: BUNDLE_PATH });
        } catch (err) {
          thrown = err;
        }

        // Assert
        expect(thrown).toBeInstanceOf(TsgitError);
        const tsErr = thrown as TsgitError;
        expect(tsErr.data.code).toBe('INVALID_PACK_HEADER');
      });
    });
  });

  // ── read-failure: BUNDLE_READ_FAILED (three converging causes) ─────────────

  describe('Given a path whose read failure classifies as BUNDLE_READ_FAILED', () => {
    describe('When bundleVerify is called', () => {
      it.each([
        {
          label: 'a path that does not exist (default fs behaviour, no interception)',
          path: '/repo/missing.bundle',
          buildCtx: (_path: string): Context => createMemoryContext(),
        },
        {
          label: 'a path that is unreadable (PERMISSION_DENIED + stat says not a directory)',
          path: '/repo/unreadable.bundle',
          buildCtx: (path: string): Context =>
            withReadPermissionDenied(createMemoryContext(), path, false),
        },
        {
          label: 'a path where read throws PERMISSION_DENIED and stat also throws',
          path: '/repo/unreadable.bundle',
          buildCtx: (path: string): Context => {
            const baseCtx = createMemoryContext();
            return {
              ...baseCtx,
              fs: {
                ...baseCtx.fs,
                read: async (p: string): Promise<Uint8Array> => {
                  if (p === path) throw new TsgitError({ code: 'PERMISSION_DENIED', path: p });
                  return baseCtx.fs.read(p);
                },
                stat: async (p: string) => {
                  if (p === path) throw new TsgitError({ code: 'FILE_NOT_FOUND', path: p });
                  return baseCtx.fs.stat(p);
                },
              },
            };
          },
        },
      ])('Then throws BUNDLE_READ_FAILED with the path — $label', async ({ path, buildCtx }) => {
        // Arrange
        const ctx = buildCtx(path);

        // Act
        let thrown: unknown;
        try {
          await bundleVerify(ctx, { path });
        } catch (err) {
          thrown = err;
        }

        // Assert
        expect(thrown).toBeInstanceOf(TsgitError);
        const tsErr = thrown as TsgitError;
        expect(tsErr.data.code).toBe('BUNDLE_READ_FAILED');
        expect((tsErr.data as { path: string }).path).toBe(path);
      });
    });
  });

  // ── read-failure: directory path ──────────────────────────────────────────

  describe('Given a path that is a directory (PERMISSION_DENIED + isDirectory)', () => {
    describe('When bundleVerify is called', () => {
      it('Then throws BUNDLE_BAD_HEADER with reason not-a-bundle', async () => {
        // Arrange
        const baseCtx = createMemoryContext();
        const DIR_PATH = '/repo/some-dir';
        const ctx = withReadPermissionDenied(baseCtx, DIR_PATH, true);

        // Act
        let thrown: unknown;
        try {
          await bundleVerify(ctx, { path: DIR_PATH });
        } catch (err) {
          thrown = err;
        }

        // Assert — classifyReadFailure sets reason='not-a-bundle' for a directory path
        expect(thrown).toBeInstanceOf(TsgitError);
        const tsErr = thrown as TsgitError;
        expect(tsErr.data.code).toBe('BUNDLE_BAD_HEADER');
        expect((tsErr.data as { path: string }).path).toBe(DIR_PATH);
        expect((tsErr.data as { reason: string }).reason).toBe('not-a-bundle');
      });
    });
  });

  // ── read-failure: plain-text non-bundle file ──────────────────────────────

  describe('Given a path that contains plain text (not a bundle)', () => {
    describe('When bundleVerify is called', () => {
      it('Then throws BUNDLE_BAD_HEADER', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const NOT_BUNDLE_PATH = '/repo/not-a-bundle.txt';
        await ctx.fs.write(NOT_BUNDLE_PATH, new TextEncoder().encode('hello world\n'));

        // Act
        let thrown: unknown;
        try {
          await bundleVerify(ctx, { path: NOT_BUNDLE_PATH });
        } catch (err) {
          thrown = err;
        }

        // Assert
        expect(thrown).toBeInstanceOf(TsgitError);
        const tsErr = thrown as TsgitError;
        expect(tsErr.data.code).toBe('BUNDLE_BAD_HEADER');
        expect((tsErr.data as { path: string }).path).toBe(NOT_BUNDLE_PATH);
      });
    });
  });

  // ── read-failure: v3 bundle file ──────────────────────────────────────────

  describe("Given a path containing a '# v3 git bundle' magic line and no pack bytes", () => {
    describe('When bundleVerify is called', () => {
      it('Then the header parses (v3 is no longer refused) and the empty pack fails its own validation', async () => {
        // Arrange — the header alone is well-formed; this fixture carries no
        // pack bytes at all, which is an independent pack-validation failure,
        // not a version refusal.
        const ctx = createMemoryContext();
        const V3_PATH = '/repo/v3.bundle';
        await ctx.fs.write(
          V3_PATH,
          new TextEncoder().encode('# v3 git bundle\n@object-format=sha1\n\n'),
        );

        // Act
        let thrown: unknown;
        try {
          await bundleVerify(ctx, { path: V3_PATH });
        } catch (err) {
          thrown = err;
        }

        // Assert
        expect(thrown).toBeInstanceOf(TsgitError);
        const tsErr = thrown as TsgitError;
        expect(tsErr.data.code).toBe('INVALID_PACK_HEADER');
      });
    });
  });

  // ── thin-pack completion ──────────────────────────────────────────────────

  describe('Given a bundle whose pack contains a REF_DELTA against a prerequisite blob', () => {
    describe('When bundleVerify is called in a repo where the prerequisite blob is present', () => {
      it('Then prerequisitesPresent is true and verify completes without error', async () => {
        // Arrange
        const ctx = await initRepo();
        // Write the base blob into the repo so the external resolver can find it
        const baseContent = enc.encode('base blob from prereq commit');
        const prereqOid = await writeObject(ctx, {
          type: 'blob',
          id: '' as ObjectId,
          content: baseContent,
        });
        const bundleBytes = await buildThinBundle(ctx, prereqOid);
        await ctx.fs.write(BUNDLE_PATH, bundleBytes);

        // Act
        const result: BundleVerifyResult = await bundleVerify(ctx, { path: BUNDLE_PATH });

        // Assert
        expect(result.prerequisitesPresent).toBe(true);
        expect(result.missingPrerequisites).toEqual([]);
        expect(result.recordsCompleteHistory).toBe(false);
      });
    });
  });

  // ── read-failure: unexpected TsgitError code is rethrown unchanged ──────────

  describe('Given a path where read throws a TsgitError with an unexpected code', () => {
    describe('When bundleVerify is called', () => {
      it('Then rethrows the unexpected TsgitError without reclassifying it', async () => {
        // Arrange — inject an error code that is neither FILE_NOT_FOUND nor
        // PERMISSION_DENIED; readOrThrow must rethrow it unchanged.
        const baseCtx = createMemoryContext();
        const SOME_PATH = '/repo/some.bundle';
        const ctx: Context = {
          ...baseCtx,
          fs: {
            ...baseCtx.fs,
            read: async (p: string): Promise<Uint8Array> => {
              if (p === SOME_PATH)
                throw new TsgitError({ code: 'OBJECT_NOT_FOUND', oid: 'a'.repeat(40) } as never);
              return baseCtx.fs.read(p);
            },
          },
        };

        // Act
        let thrown: unknown;
        try {
          await bundleVerify(ctx, { path: SOME_PATH });
        } catch (err) {
          thrown = err;
        }

        // Assert — original unexpected TsgitError is rethrown, not reclassified
        expect(thrown).toBeInstanceOf(TsgitError);
        const tsErr = thrown as TsgitError;
        expect(tsErr.data.code).toBe('OBJECT_NOT_FOUND');
      });
    });
  });

  // ── read-failure: directory path via FILE_NOT_FOUND (memory/OPFS adapter) ─

  describe('Given a path where read throws FILE_NOT_FOUND and stat reports a directory', () => {
    describe('When bundleVerify is called', () => {
      it('Then throws BUNDLE_BAD_HEADER with the path', async () => {
        // Arrange
        const baseCtx = createMemoryContext();
        const DIR_PATH = '/repo/some-dir';
        const ctx: Context = {
          ...baseCtx,
          fs: {
            ...baseCtx.fs,
            read: async (p: string): Promise<Uint8Array> => {
              if (p === DIR_PATH) throw new TsgitError({ code: 'FILE_NOT_FOUND', path: p });
              return baseCtx.fs.read(p);
            },
            stat: async (p: string) => {
              if (p === DIR_PATH) return { ...MOCK_STAT, isFile: false, isDirectory: true };
              return baseCtx.fs.stat(p);
            },
          },
        };

        // Act
        let thrown: unknown;
        try {
          await bundleVerify(ctx, { path: DIR_PATH });
        } catch (err) {
          thrown = err;
        }

        // Assert
        expect(thrown).toBeInstanceOf(TsgitError);
        const tsErr = thrown as TsgitError;
        expect(tsErr.data.code).toBe('BUNDLE_BAD_HEADER');
        expect((tsErr.data as { path: string }).path).toBe(DIR_PATH);
      });
    });
  });

  // ── resolver: OBJECT_NOT_FOUND → undefined → INVALID_PACK_HEADER ─────────

  describe('Given a bundle with all prerequisites present but the REF_DELTA base absent from the store', () => {
    describe('When bundleVerify is called', () => {
      it('Then throws INVALID_PACK_HEADER for the unresolvable delta entry', async () => {
        // Arrange — write a blob that serves as the prerequisite (present in store)
        const ctx = await initRepo();
        const prereqContent = enc.encode('prerequisite blob');
        const prereqOid = await writeObject(ctx, {
          type: 'blob',
          id: '' as ObjectId,
          content: prereqContent,
        });

        // Build a pack with a REF_DELTA whose base OID is NOT in the store.
        // The base content is used only to compute the delta bytes; the absent
        // base OID ensures the external resolver returns undefined.
        const absentBaseId = `${'abcdef0123456789'.repeat(2)}01234567`; // 40 hex chars, never written
        const baseContent = enc.encode('base content for delta computation');
        const targetContent = enc.encode('derived content');
        const { packBytes, ids } = await buildSyntheticPack(ctx, [
          {
            kind: 'ref-delta',
            baseId: absentBaseId,
            baseUncompressed: baseContent,
            targetContent,
          } as EntrySpec,
        ]);

        const headerBytes = serializeBundleHeader({
          version: 2,
          hashAlgorithm: 'sha1',
          prerequisites: [{ oid: prereqOid, comment: 'prereq' }],
          refs: [{ oid: ids[0] as ObjectId, name: 'refs/heads/main' as RefName }],
        });
        const bundleBytes = new Uint8Array(headerBytes.length + packBytes.length);
        bundleBytes.set(headerBytes, 0);
        bundleBytes.set(packBytes, headerBytes.length);
        await ctx.fs.write(BUNDLE_PATH, bundleBytes);

        // Act
        let thrown: unknown;
        try {
          await bundleVerify(ctx, { path: BUNDLE_PATH });
        } catch (err) {
          thrown = err;
        }

        // Assert — resolver returns undefined (OBJECT_NOT_FOUND is swallowed);
        // the entry stays unresolvable, triggering INVALID_PACK_HEADER
        expect(thrown).toBeInstanceOf(TsgitError);
        const tsErr = thrown as TsgitError;
        expect(tsErr.data.code).toBe('INVALID_PACK_HEADER');
        expect((tsErr.data as { readonly reason: string }).reason).toContain('unresolved');
      });
    });
  });

  // ── resolver: non-OBJECT_NOT_FOUND error → rethrow ────────────────────────

  describe('Given a bundle where the REF_DELTA base object exists but is unreadable (PERMISSION_DENIED)', () => {
    describe('When bundleVerify is called', () => {
      it('Then rethrows the PERMISSION_DENIED error from the external base resolver', async () => {
        // Arrange — write two objects: blobA (prerequisite, always readable) and
        // blobB (REF_DELTA base, read intercepted to throw PERMISSION_DENIED).
        const ctx = await initRepo();

        const prereqContent = enc.encode('prerequisite blob — always readable');
        const prereqOid = await writeObject(ctx, {
          type: 'blob',
          id: '' as ObjectId,
          content: prereqContent,
        });

        const baseContent = enc.encode('base blob for REF_DELTA');
        const baseOid = await writeObject(ctx, {
          type: 'blob',
          id: '' as ObjectId,
          content: baseContent,
        });

        const targetContent = enc.encode('derived content');
        const { packBytes, ids } = await buildSyntheticPack(ctx, [
          {
            kind: 'ref-delta',
            baseId: baseOid as string,
            baseUncompressed: baseContent,
            targetContent,
          } as EntrySpec,
        ]);

        const headerBytes = serializeBundleHeader({
          version: 2,
          hashAlgorithm: 'sha1',
          prerequisites: [{ oid: prereqOid, comment: 'prereq' }],
          refs: [{ oid: ids[0] as ObjectId, name: 'refs/heads/main' as RefName }],
        });
        const bundleBytes = new Uint8Array(headerBytes.length + packBytes.length);
        bundleBytes.set(headerBytes, 0);
        bundleBytes.set(packBytes, headerBytes.length);
        await ctx.fs.write(BUNDLE_PATH, bundleBytes);

        // Intercept reads of blobB's loose object path to simulate PERMISSION_DENIED.
        // The file still exists in the store (exists() returns true), but read() throws.
        const baseLoosePath = `${ctx.layout.gitDir}/objects/${baseOid.slice(0, 2)}/${baseOid.slice(2)}`;
        const spyCtx: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            read: async (p: string): Promise<Uint8Array> => {
              if (p === baseLoosePath) {
                throw new TsgitError({ code: 'PERMISSION_DENIED', path: p });
              }
              return ctx.fs.read(p);
            },
          },
        };

        // Act
        let thrown: unknown;
        try {
          await bundleVerify(spyCtx, { path: BUNDLE_PATH });
        } catch (err) {
          thrown = err;
        }

        // Assert — resolveExternalBase rethrows the non-OBJECT_NOT_FOUND error
        expect(thrown).toBeInstanceOf(TsgitError);
        const tsErr = thrown as TsgitError;
        expect(tsErr.data.code).toBe('PERMISSION_DENIED');
      });
    });
  });

  // ── memoized external-base resolver ────────────────────────────────────────

  describe('Given a bundle with two REF_DELTA entries sharing the same external base blob', () => {
    const buildTwoRefDeltaBundle = async (
      ctx: Context,
      prereqOid: ObjectId,
      baseContent: Uint8Array,
    ): Promise<Uint8Array> => {
      const target1Content = enc.encode('derived 1');
      const target2Content = enc.encode('derived 2');
      const { packBytes, ids } = await buildSyntheticPack(ctx, [
        {
          kind: 'ref-delta',
          baseId: prereqOid as string,
          baseUncompressed: baseContent,
          targetContent: target1Content,
        },
        {
          kind: 'ref-delta',
          baseId: prereqOid as string,
          baseUncompressed: baseContent,
          targetContent: target2Content,
        },
      ]);
      const refs = ids.map((id, i) => ({
        oid: id as ObjectId,
        name: `refs/heads/branch${i + 1}` as RefName,
      }));
      const headerBytes = serializeBundleHeader({
        version: 2,
        hashAlgorithm: 'sha1',
        prerequisites: [{ oid: prereqOid, comment: 'prereq' }],
        refs,
      });
      const bundleBytes = new Uint8Array(headerBytes.length + packBytes.length);
      bundleBytes.set(headerBytes, 0);
      bundleBytes.set(packBytes, headerBytes.length);
      return bundleBytes;
    };

    describe('When bundleVerify is called in a repo where the base object is present', () => {
      it('Then the external base object is read from the object store exactly once — the prereq check warms the shared delta cache and every resolver lookup hits it', async () => {
        // Arrange
        const ctx = await initRepo();
        const baseContent = enc.encode('shared external base blob');
        const prereqOid = await writeObject(ctx, {
          type: 'blob',
          id: '' as ObjectId,
          content: baseContent,
        });
        const bundleBytes = await buildTwoRefDeltaBundle(ctx, prereqOid, baseContent);
        await ctx.fs.write(BUNDLE_PATH, bundleBytes);

        let baseReadCount = 0;
        const baseLoosePath = `${ctx.layout.gitDir}/objects/${prereqOid.slice(0, 2)}/${prereqOid.slice(2)}`;
        const spyCtx: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            read: async (p: string): Promise<Uint8Array> => {
              if (p === baseLoosePath) baseReadCount += 1;
              return ctx.fs.read(p);
            },
          },
        };

        // Act
        const result = await bundleVerify(spyCtx, { path: BUNDLE_PATH });

        // Assert — verify succeeds with both prerequisites present
        expect(result.prerequisitesPresent).toBe(true);
        // Assert — the prereq check's loose read populates the shared delta
        // cache (F2.3), so both the resolver's own memo and every REF_DELTA
        // entry's base lookup thereafter are cache hits — one physical read.
        expect(baseReadCount).toBe(1);
      });
    });
  });

  // ── cross-format prerequisite refusal ─────────────────────────────────────

  describe('Given a SHA-256 bundle whose prerequisite is verified against a SHA-1 repository', () => {
    describe('When bundleVerify is called', () => {
      it("Then it throws the cross-format refusal with oid, bundleAlgorithm 'sha256' and localAlgorithm 'sha1'", async () => {
        // Arrange — hand-built v3/sha256 header; the pack bytes are irrelevant
        // because the guard fires before any pack read is attempted.
        const ctx = await initRepo(); // sha1 repository
        const prereqOid = 'a'.repeat(64);
        const refOid = 'b'.repeat(64);
        const headerText =
          `# v3 git bundle\n@object-format=sha256\n` +
          `-${prereqOid} boundary commit\n${refOid} refs/heads/main\n\n`;
        await ctx.fs.write(BUNDLE_PATH, enc.encode(headerText));

        // Act
        let thrown: unknown;
        try {
          await bundleVerify(ctx, { path: BUNDLE_PATH });
        } catch (err) {
          thrown = err;
        }

        // Assert
        expect(thrown).toBeInstanceOf(TsgitError);
        const data = (thrown as TsgitError).data as {
          code: string;
          oid: string;
          bundleAlgorithm: string;
          localAlgorithm: string;
        };
        expect(data.code).toBe('BUNDLE_PREREQUISITE_ALGORITHM_MISMATCH');
        expect(data.oid).toBe(prereqOid);
        expect(data.bundleAlgorithm).toBe('sha256');
        expect(data.localAlgorithm).toBe('sha1');
      });
    });
  });

  describe('Given a same-format bundle whose prerequisite commit is absent from the target repo', () => {
    describe('When bundleVerify is called', () => {
      it('Then the prerequisite is still reported in missingPrerequisites — the narrowing guard does not swallow the absent-prerequisite path', async () => {
        // Arrange
        const { ctx: sourceCtx, commit1 } = await buildTwoCommitRepo();
        const createResult = await bundleCreate(sourceCtx, {
          revs: [{ range: ['refs/heads/main~1', 'refs/heads/main'] }],
        });
        const emptyCtx = await initRepo();
        await emptyCtx.fs.write(BUNDLE_PATH, createResult.bytes);

        // Act
        const result = await bundleVerify(emptyCtx, { path: BUNDLE_PATH });

        // Assert — exit-1 shape (missing, not thrown) survives the new guard
        expect(result.prerequisitesPresent).toBe(false);
        expect(result.missingPrerequisites).toContain(commit1);
      });
    });
  });

  describe('Given a SHA-256 bundle with no prerequisites, verified from within a SHA-1 repository', () => {
    describe('When bundleVerify is called', () => {
      it("Then it verifies successfully — the guard does not fire on a complete bundle, and the pack is framed at the bundle's own algorithm rather than the repository's", async () => {
        // Arrange — a complete (0-prerequisite) SHA-256 bundle, verified from a
        // SHA-1 repository. Framing the pack trailer/entries at the repository's
        // 20-byte width instead of the bundle's own 32-byte width would fail the
        // trailer digest check, so a successful verify is itself the proof.
        const sha256Ctx = await buildSha256SingleCommitRepo();
        const created = await bundleCreate(sha256Ctx, { all: true });
        const sha1Ctx = await initRepo();
        await sha1Ctx.fs.write(BUNDLE_PATH, created.bytes);

        // Act
        const result = await bundleVerify(sha1Ctx, { path: BUNDLE_PATH });

        // Assert
        expect(result.recordsCompleteHistory).toBe(true);
        expect(result.prerequisitesPresent).toBe(true);
        expect(result.hashAlgorithm).toBe('sha256');
        expect(result.refs[0]?.oid).toMatch(/^[0-9a-f]{64}$/);
      });
    });
  });

  describe('Given a cross-format bundle and a hash service that cannot switch algorithms', () => {
    describe('When bundleVerify is called', () => {
      it("Then it refuses rather than silently framing the pack at the repository's width", async () => {
        // Arrange — `withAlgorithm` is optional on the port precisely so a
        // caller-supplied service may omit it. Without it the bundle's own
        // width is unreachable, and no bundle path may fall back to the
        // surrounding repository's width.
        const sha256Ctx = await buildSha256SingleCommitRepo();
        const created = await bundleCreate(sha256Ctx, { all: true });
        const base = await initRepo();
        const { withAlgorithm: _omitted, ...hashWithoutSwitch } = base.hash;
        const sha1Ctx: Context = { ...base, hash: hashWithoutSwitch };
        await sha1Ctx.fs.write(BUNDLE_PATH, created.bytes);
        const sut = bundleVerify;

        // Act
        let caught: unknown;
        try {
          await sut(sha1Ctx, { path: BUNDLE_PATH });
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('UNSUPPORTED_OPERATION');
        if (data.code !== 'UNSUPPORTED_OPERATION') expect.unreachable();
        expect(data.reason).toContain('sha256');
      });
    });
  });

  // ── filter capability exposure ────────────────────────────────────────────

  describe('Given a v3 bundle whose header declares a @filter capability', () => {
    describe('When bundleVerify is called', () => {
      it('Then the result exposes filter alongside version and hashAlgorithm', async () => {
        // Arrange — reuse a real pack from bundleCreate, but hand-write the v3
        // header text so it carries @filter (bundleCreate has no --filter yet).
        const { ctx } = await buildSingleCommitRepo();
        const created = await bundleCreate(ctx, { all: true });
        const originalHeader = parseBundleHeader(created.bytes, '<fixture>');
        const packBytes = created.bytes.subarray(originalHeader.packOffset);
        const refLines = originalHeader.refs.map((r) => `${r.oid} ${r.name}\n`).join('');
        const headerText = `# v3 git bundle\n@object-format=sha1\n@filter=blob:none\n${refLines}\n`;
        const headerEncoded = enc.encode(headerText);
        const bundleBytes = new Uint8Array(headerEncoded.length + packBytes.length);
        bundleBytes.set(headerEncoded, 0);
        bundleBytes.set(packBytes, headerEncoded.length);
        await ctx.fs.write(BUNDLE_PATH, bundleBytes);

        // Act
        const result = await bundleVerify(ctx, { path: BUNDLE_PATH });

        // Assert
        expect(result.version).toBe(3);
        expect(result.hashAlgorithm).toBe('sha1');
        expect(result.filter).toEqual({ kind: 'blob-none' });
      });
    });
  });
});

describe('bundleVerify on a repository the acceptance tier rejected', () => {
  const refused = (ctx: Context, verdict: Partial<Context['layout']>): Context => ({
    ...ctx,
    layout: { ...ctx.layout, ...verdict },
  });

  describe('Given a layout refused for dubious ownership alone', () => {
    describe('When bundleVerify runs', () => {
      it('Then it refuses as repository-ABSENT, never touching the bundle', async () => {
        // Arrange — git demotes such a repository to absent for this verb
        // (exit 1, `need a repository to verify a bundle`) rather than raising
        // its ownership fatal, so the family here is deliberately not the
        // acceptance tier's.
        const ctx = await initRepo();
        const sut = bundleVerify;

        // Act
        let caught: TsgitError | undefined;
        try {
          await sut(refused(ctx, { untrusted: true }), { path: '/nonexistent.bundle' });
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data.code).toBe('NOT_A_REPOSITORY');
      });
    });
  });

  describe('Given a layout refused for an implicit bare repository alone', () => {
    describe('When bundleVerify runs', () => {
      it('Then it refuses as repository-ABSENT', async () => {
        // Arrange
        const ctx = await initRepo();
        const sut = bundleVerify;

        // Act
        let caught: TsgitError | undefined;
        try {
          await sut(refused(ctx, { implicitBare: true }), { path: '/nonexistent.bundle' });
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data.code).toBe('NOT_A_REPOSITORY');
      });
    });
  });

  describe('Given a layout refused for an unsupported repository format alone', () => {
    describe('When bundleVerify runs', () => {
      it('Then it refuses as repository-ABSENT', async () => {
        // Arrange — the third disjunct of the guard, isolated from the two
        // trust ones so each condition is proven on its own.
        const ctx = await initRepo();
        const sut = bundleVerify;

        // Act
        let caught: TsgitError | undefined;
        try {
          await sut(refused(ctx, { formatRefusal: { kind: 'version', version: 99 } }), {
            path: '/nonexistent.bundle',
          });
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data.code).toBe('NOT_A_REPOSITORY');
      });
    });
  });

  describe('Given an accepted layout', () => {
    describe('When bundleVerify runs against a missing bundle file', () => {
      it('Then the guard does not fire — it refuses on the bundle, not the repository', async () => {
        // Arrange — proves the guard is conditional rather than unconditional.
        const ctx = await initRepo();
        const sut = bundleVerify;

        // Act
        let caught: TsgitError | undefined;
        try {
          await sut(ctx, { path: '/nonexistent.bundle' });
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data.code).not.toBe('NOT_A_REPOSITORY');
      });
    });
  });
});

describe('bundleVerify and the optional withAlgorithm capability', () => {
  describe('Given a same-format bundle and a hash service that cannot switch algorithms', () => {
    describe('When bundleVerify is called', () => {
      it('Then it verifies without ever asking the service to switch', async () => {
        // Arrange — a bundle framed at the repository's OWN algorithm needs no
        // switch, so the missing capability must not be reached at all.
        const { ctx } = await buildSingleCommitRepo();
        const created = await bundleCreate(ctx, { all: true });
        const { withAlgorithm: _omitted, ...hashWithoutSwitch } = ctx.hash;
        const restricted: Context = { ...ctx, hash: hashWithoutSwitch };
        await restricted.fs.write(BUNDLE_PATH, created.bytes);
        const sut = bundleVerify;

        // Act
        const result = await sut(restricted, { path: BUNDLE_PATH });

        // Assert
        expect(result.hashAlgorithm).toBe('sha1');
        expect(result.prerequisitesPresent).toBe(true);
        expect(result.recordsCompleteHistory).toBe(true);
      });
    });
  });
});

describe('bundleVerify filter key exposure', () => {
  describe('Given a bundle whose header declares no filter capability', () => {
    describe('When bundleVerify is called', () => {
      it('Then the result omits the filter key rather than carrying it as undefined', async () => {
        // Arrange
        const { ctx } = await buildSingleCommitRepo();
        const created = await bundleCreate(ctx, { all: true });
        await ctx.fs.write(BUNDLE_PATH, created.bytes);
        const sut = bundleVerify;

        // Act
        const result = await sut(ctx, { path: BUNDLE_PATH });

        // Assert — key PRESENCE is the oracle: `toEqual` cannot tell an absent
        // optional key from one explicitly present with the value `undefined`.
        expect('filter' in result).toBe(false);
      });
    });
  });
});
