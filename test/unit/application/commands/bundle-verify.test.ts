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
import { parseBundleHeader } from '../../../../src/domain/bundle/index.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { AuthorIdentity, FileMode, ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import type { FileStat } from '../../../../src/ports/file-system.js';

// ─────────────────────────────────────────────────────────────────────────────
// System under test
// ─────────────────────────────────────────────────────────────────────────────

const sut = bundleVerify;

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
        const result = await sut(ctx, { path: BUNDLE_PATH });

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
        const result: BundleVerifyResult = await sut(ctx, { path: BUNDLE_PATH });

        // Assert
        expect(result.prerequisitesPresent).toBe(true);
        expect(result.missingPrerequisites).toEqual([]);
        expect(result.prerequisites).toEqual([{ oid: commit1, comment: 'first commit' }]);
      });
    });
  });

  describe('Given the same range bundle bytes in a fresh empty repo', () => {
    describe('When bundleVerify is called', () => {
      it('Then prerequisitesPresent is false and missingPrerequisites contains the boundary oid', async () => {
        // Arrange
        const { ctx: sourceCtx, commit1 } = await buildTwoCommitRepo();
        const createResult = await bundleCreate(sourceCtx, {
          revs: [{ range: ['refs/heads/main~1', 'refs/heads/main'] }],
        });
        const emptyCtx = await initRepo();
        await emptyCtx.fs.write(BUNDLE_PATH, createResult.bytes);

        // Act
        const result: BundleVerifyResult = await sut(emptyCtx, { path: BUNDLE_PATH });

        // Assert
        expect(result.prerequisitesPresent).toBe(false);
        expect(result.missingPrerequisites).toContain(commit1);
        expect(result.missingPrerequisites).toHaveLength(1);
      });
    });
  });

  // ── full pack parse (corrupt pack) ────────────────────────────────────────

  describe('Given bundle bytes with a flipped byte in the pack body', () => {
    describe('When bundleVerify is called', () => {
      it('Then throws a pack-malformation error that is NOT a BUNDLE_ code', async () => {
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
          await sut(ctx, { path: BUNDLE_PATH });
        } catch (err) {
          thrown = err;
        }

        // Assert
        expect(thrown).toBeInstanceOf(TsgitError);
        const tsErr = thrown as TsgitError;
        expect(tsErr.data.code).not.toMatch(/^BUNDLE_/);
      });
    });
  });

  // ── read-failure: missing file ─────────────────────────────────────────────

  describe('Given a path that does not exist', () => {
    describe('When bundleVerify is called', () => {
      it('Then throws BUNDLE_READ_FAILED with the path', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        let thrown: unknown;
        try {
          await sut(ctx, { path: '/repo/missing.bundle' });
        } catch (err) {
          thrown = err;
        }

        // Assert
        expect(thrown).toBeInstanceOf(TsgitError);
        const tsErr = thrown as TsgitError;
        expect(tsErr.data.code).toBe('BUNDLE_READ_FAILED');
        expect((tsErr.data as { path: string }).path).toBe('/repo/missing.bundle');
      });
    });
  });

  // ── read-failure: directory path ──────────────────────────────────────────

  describe('Given a path that is a directory (PERMISSION_DENIED + isDirectory)', () => {
    describe('When bundleVerify is called', () => {
      it('Then throws BUNDLE_BAD_HEADER', async () => {
        // Arrange
        const baseCtx = createMemoryContext();
        const DIR_PATH = '/repo/some-dir';
        const ctx = withReadPermissionDenied(baseCtx, DIR_PATH, true);

        // Act
        let thrown: unknown;
        try {
          await sut(ctx, { path: DIR_PATH });
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

  // ── read-failure: unreadable file (permission denied, not directory) ───────

  describe('Given a path that is unreadable (PERMISSION_DENIED + not a directory)', () => {
    describe('When bundleVerify is called', () => {
      it('Then throws BUNDLE_READ_FAILED with the path', async () => {
        // Arrange
        const baseCtx = createMemoryContext();
        const FILE_PATH = '/repo/unreadable.bundle';
        const ctx = withReadPermissionDenied(baseCtx, FILE_PATH, false);

        // Act
        let thrown: unknown;
        try {
          await sut(ctx, { path: FILE_PATH });
        } catch (err) {
          thrown = err;
        }

        // Assert
        expect(thrown).toBeInstanceOf(TsgitError);
        const tsErr = thrown as TsgitError;
        expect(tsErr.data.code).toBe('BUNDLE_READ_FAILED');
        expect((tsErr.data as { path: string }).path).toBe(FILE_PATH);
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
          await sut(ctx, { path: NOT_BUNDLE_PATH });
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

  describe("Given a path containing a '# v3 git bundle' magic line", () => {
    describe('When bundleVerify is called', () => {
      it('Then throws BUNDLE_UNSUPPORTED_VERSION with version 3', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const V3_PATH = '/repo/v3.bundle';
        await ctx.fs.write(
          V3_PATH,
          new TextEncoder().encode('# v3 git bundle\n@object-format=sha1\n\n'),
        );

        // Act
        let thrown: unknown;
        try {
          await sut(ctx, { path: V3_PATH });
        } catch (err) {
          thrown = err;
        }

        // Assert
        expect(thrown).toBeInstanceOf(TsgitError);
        const tsErr = thrown as TsgitError;
        expect(tsErr.data.code).toBe('BUNDLE_UNSUPPORTED_VERSION');
        expect((tsErr.data as { version: number }).version).toBe(3);
        expect((tsErr.data as { path: string }).path).toBe(V3_PATH);
      });
    });
  });
});
