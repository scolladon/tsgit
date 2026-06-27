import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { bundleCreate } from '../../../../src/application/commands/bundle-create.js';
import { bundleListHeads } from '../../../../src/application/commands/bundle-list-heads.js';
import { createCommit } from '../../../../src/application/primitives/create-commit.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { parseBundleHeader } from '../../../../src/domain/bundle/index.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type {
  AuthorIdentity,
  FileMode,
  ObjectId,
  Tag,
} from '../../../../src/domain/objects/index.js';
import type { RefName } from '../../../../src/domain/objects/object-id.js';
import type { Context } from '../../../../src/ports/context.js';

// ─────────────────────────────────────────────────────────────────────────────
// System under test
// ─────────────────────────────────────────────────────────────────────────────

const sut = bundleListHeads;

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

const buildRepoWithTagAndBranch = async (): Promise<{
  readonly ctx: Context;
  readonly commit1: ObjectId;
  readonly commit2: ObjectId;
  readonly tagOid: ObjectId;
}> => {
  const ctx = await initRepo();
  const tree1 = await writeTree(ctx, []);
  const commit1 = await makeCommitObj(ctx, tree1, [], 'first commit', 1);
  const blob = await makeBlob(ctx, 'hello');
  const tree2 = await writeTree(ctx, [{ mode: BLOB_MODE, name: 'a.txt', id: blob }]);
  const commit2 = await makeCommitObj(ctx, tree2, [commit1], 'second commit', 2);
  await setRef(ctx, 'refs/heads/main', commit2);
  const tag: Tag = {
    type: 'tag',
    id: '' as ObjectId,
    data: {
      object: commit1,
      objectType: 'commit',
      tagName: 'v1.0',
      message: 'release v1.0',
      extraHeaders: [],
    },
  };
  const tagOid = await writeObject(ctx, tag);
  await setRef(ctx, 'refs/tags/v1.0', tagOid);
  return { ctx, commit1, commit2, tagOid };
};

const BUNDLE_PATH = '/repo/test.bundle';

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('bundleListHeads', () => {
  // ── no filter: all refs in header order ──────────────────────────────────

  describe('Given a bundle with multiple refs (branch + annotated tag)', () => {
    describe('When bundleListHeads is called with no filter', () => {
      it('Then returns all refs in header order with correct version', async () => {
        // Arrange
        const { ctx } = await buildRepoWithTagAndBranch();
        const createResult = await bundleCreate(ctx, { all: true });
        await ctx.fs.write(BUNDLE_PATH, createResult.bytes);

        // Act
        const result = await sut(ctx, { path: BUNDLE_PATH });

        // Assert
        expect(result.version).toBe(2);
        expect(result.refs).toHaveLength(createResult.refs.length);
        const refNames = result.refs.map((r) => r.name);
        expect(refNames).toEqual(createResult.refs.map((r) => r.name));
      });
    });
  });

  // ── exact full-name filter ────────────────────────────────────────────────

  describe('Given a bundle with refs/heads/main and refs/tags/v1.0', () => {
    describe("When bundleListHeads is called with names ['refs/tags/v1.0']", () => {
      it('Then returns only the refs/tags/v1.0 ref', async () => {
        // Arrange
        const { ctx, tagOid } = await buildRepoWithTagAndBranch();
        const createResult = await bundleCreate(ctx, { all: true });
        await ctx.fs.write(BUNDLE_PATH, createResult.bytes);

        // Act
        const result = await sut(ctx, {
          path: BUNDLE_PATH,
          names: ['refs/tags/v1.0' as RefName],
        });

        // Assert
        expect(result.refs).toHaveLength(1);
        expect(result.refs[0]?.name).toBe('refs/tags/v1.0');
        expect(result.refs[0]?.oid).toBe(tagOid);
      });
    });
  });

  // ── near-miss filters: no match ───────────────────────────────────────────

  describe("Given a bundle with refs/tags/v1.0, When bundleListHeads is called with names ['v1.0']", () => {
    it('Then returns empty (short name does not match)', async () => {
      // Arrange
      const { ctx } = await buildRepoWithTagAndBranch();
      const createResult = await bundleCreate(ctx, { all: true });
      await ctx.fs.write(BUNDLE_PATH, createResult.bytes);

      // Act
      const result = await sut(ctx, { path: BUNDLE_PATH, names: ['v1.0' as RefName] });

      // Assert
      expect(result.refs).toHaveLength(0);
    });
  });

  describe("Given a bundle with refs/tags/v1.0, When bundleListHeads is called with names ['tags/v1.0']", () => {
    it('Then returns empty (partial path does not match)', async () => {
      // Arrange
      const { ctx } = await buildRepoWithTagAndBranch();
      const createResult = await bundleCreate(ctx, { all: true });
      await ctx.fs.write(BUNDLE_PATH, createResult.bytes);

      // Act
      const result = await sut(ctx, { path: BUNDLE_PATH, names: ['tags/v1.0' as RefName] });

      // Assert
      expect(result.refs).toHaveLength(0);
    });
  });

  describe("Given a bundle with refs/heads/main, When bundleListHeads is called with names ['main']", () => {
    it('Then returns empty (branch short name does not match)', async () => {
      // Arrange
      const { ctx } = await buildRepoWithTagAndBranch();
      const createResult = await bundleCreate(ctx, { all: true });
      await ctx.fs.write(BUNDLE_PATH, createResult.bytes);

      // Act
      const result = await sut(ctx, { path: BUNDLE_PATH, names: ['main' as RefName] });

      // Assert
      expect(result.refs).toHaveLength(0);
    });
  });

  // ── pack never touched ────────────────────────────────────────────────────

  describe('Given a bundle with a deliberately corrupt pack body', () => {
    describe('When bundleListHeads is called (header-only operation)', () => {
      it('Then succeeds without reading the pack', async () => {
        // Arrange
        const { ctx } = await buildRepoWithTagAndBranch();
        const createResult = await bundleCreate(ctx, { all: true });
        // Corrupt every byte in the pack region (after the bundle header)
        const bundleHeader = parseBundleHeader(createResult.bytes, 'x');
        const corruptBytes = new Uint8Array(createResult.bytes);
        for (let i = bundleHeader.packOffset; i < corruptBytes.length; i++) {
          corruptBytes[i] = 0xff;
        }
        await ctx.fs.write(BUNDLE_PATH, corruptBytes);

        // Act & Assert: should NOT throw
        const result = await sut(ctx, { path: BUNDLE_PATH });
        expect(result.refs).toBeDefined();
        expect(result.version).toBe(2);
      });
    });
  });

  // ── missing path ──────────────────────────────────────────────────────────

  describe('Given a path that does not exist', () => {
    describe('When bundleListHeads is called', () => {
      it('Then throws BUNDLE_READ_FAILED', async () => {
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
      });
    });
  });

  // ── plain-text non-bundle file ────────────────────────────────────────────

  describe('Given a path that contains plain text (not a bundle)', () => {
    describe('When bundleListHeads is called', () => {
      it('Then throws BUNDLE_BAD_HEADER', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const NOT_BUNDLE_PATH = '/repo/not-a-bundle.txt';
        await ctx.fs.write(NOT_BUNDLE_PATH, new TextEncoder().encode('not a bundle\n'));

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
      });
    });
  });
});
