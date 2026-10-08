import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import type { ArchiveEntry } from '../../../../src/application/commands/archive.js';
import { archive } from '../../../../src/application/commands/archive.js';
import { describe as describeCommit } from '../../../../src/application/commands/describe.js';
import { readMailmap } from '../../../../src/application/commands/internal/read-mailmap.js';
import {
  abbreviateObjectId,
  abbreviateObjectIdFrom,
} from '../../../../src/application/primitives/abbreviate-object-id.js';
import { readBlobContentInStreamOrder } from '../../../../src/application/primitives/internal/blob-source.js';
import { loadRefDecorations } from '../../../../src/application/primitives/internal/ref-decorations.js';
import { verifyCommitSignature } from '../../../../src/application/primitives/internal/verify-commit-signature.js';
import { readBlob } from '../../../../src/application/primitives/read-blob.js';
import { readRawObject } from '../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { TsgitError } from '../../../../src/domain/error.js';
import {
  FILE_MODE,
  type FileMode,
  type ObjectId,
  type TreeEntry,
} from '../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
import { buildCharsetEncoder } from '../../../../src/domain/pretty/reencode.js';
import { type Context, createSession } from '../../../../src/ports/context.js';
import {
  buildTreeChain,
  deepIndexPath,
  instrumentedContext,
  seedMaxTreeDepth,
} from '../primitives/fixtures.js';
import { writeSyntheticPackIn } from '../primitives/pack-fixture.js';
import { asBareContext } from './fixtures.js';

vi.mock(
  '../../../../src/application/primitives/abbreviate-object-id.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../../src/application/primitives/abbreviate-object-id.js')
      >();
    return {
      ...actual,
      abbreviateObjectId: vi.fn(actual.abbreviateObjectId),
      abbreviateObjectIdFrom: vi.fn(actual.abbreviateObjectIdFrom),
    };
  },
);

vi.mock(
  '../../../../src/application/primitives/internal/ref-decorations.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../../src/application/primitives/internal/ref-decorations.js')
      >();
    return { ...actual, loadRefDecorations: vi.fn(actual.loadRefDecorations) };
  },
);

vi.mock('../../../../src/application/commands/internal/read-mailmap.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../../src/application/commands/internal/read-mailmap.js')
    >();
  return { ...actual, readMailmap: vi.fn(actual.readMailmap) };
});

vi.mock(
  '../../../../src/application/primitives/internal/verify-commit-signature.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../../src/application/primitives/internal/verify-commit-signature.js')
      >();
    return { ...actual, verifyCommitSignature: vi.fn(actual.verifyCommitSignature) };
  },
);

vi.mock('../../../../src/application/commands/describe.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../src/application/commands/describe.js')>();
  return { ...actual, describe: vi.fn(actual.describe) };
});

vi.mock('../../../../src/domain/pretty/reencode.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/domain/pretty/reencode.js')>();
  return { ...actual, buildCharsetEncoder: vi.fn(actual.buildCharsetEncoder) };
});

vi.mock('../../../../src/application/primitives/read-blob.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../src/application/primitives/read-blob.js')>();
  return { ...actual, readBlob: vi.fn(actual.readBlob) };
});

vi.mock(
  '../../../../src/application/primitives/internal/blob-source.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../../src/application/primitives/internal/blob-source.js')
      >();
    return {
      ...actual,
      readBlobContentInStreamOrder: vi.fn(actual.readBlobContentInStreamOrder),
    };
  },
);

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
// NOT_A_REPOSITORY
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
// Unborn HEAD (revParse cannot resolve)
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
// Unresolvable rev
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
// Blob treeish (ISOLATED test)
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
      const innerBlobId = await writeObject(ctx, makeBlob('inner'));
      const innerTreeId = await writeObject(
        ctx,
        makeTree([treeEntry(FILE_MODE.REGULAR, 'f', innerBlobId)]),
      );
      const rootTreeId = await writeObject(
        ctx,
        makeTree([
          treeEntry(FILE_MODE.DIRECTORY, 'filled', innerTreeId),
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
      const dirEntry = entries.find((e) => e.path === 'filled');
      const subEntry = entries.find((e) => e.path === 'sub');
      expect(dirEntry).toBeDefined();
      expect(dirEntry?.content).toBeUndefined();
      expect(subEntry).toBeDefined();
      expect(subEntry?.content).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Entry-path validation — archive is a traversal sink: walkTree never
// validates a tree entry's name, and archive never touches the index or the
// filesystem, so a hostile name must be refused here or it reaches whoever
// extracts the produced archive.
// ---------------------------------------------------------------------------

describe('Given a root-level tree entry named "../../etc/evil"', () => {
  describe('When archive iterates entries', () => {
    it('Then throws INVALID_INDEX_ENTRY and yields no entry', async () => {
      // Arrange
      const ctx = await initUnbornCtx();
      const evilBlobId = await writeObject(ctx, makeBlob('evil\n'));
      const rootTreeId = await writeObject(
        ctx,
        makeTree([treeEntry(FILE_MODE.REGULAR, '../../etc/evil', evilBlobId)]),
      );
      const commitId = await writeObject(ctx, makeCommit(rootTreeId));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act
      const result = await archive(ctx, { treeish: 'HEAD' });
      let caught: unknown;
      const entries: ArchiveEntry[] = [];
      try {
        for await (const entry of result.entries) {
          entries.push(entry);
        }
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('INVALID_INDEX_ENTRY');
      expect(entries).toHaveLength(0);
    });
  });
});

describe('Given a root-level tree entry named "." (git refuses it at materialisation, not parse)', () => {
  describe('When archive iterates entries', () => {
    it('Then throws INVALID_INDEX_ENTRY with the dot-segment reason', async () => {
      // Arrange
      const ctx = await initUnbornCtx();
      const blobId = await writeObject(ctx, makeBlob('dot\n'));
      const rootTreeId = await writeObject(
        ctx,
        makeTree([treeEntry(FILE_MODE.REGULAR, '.', blobId)]),
      );
      const commitId = await writeObject(ctx, makeCommit(rootTreeId));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act
      const result = await archive(ctx, { treeish: 'HEAD' });
      let caught: unknown;
      try {
        for await (const _entry of result.entries) {
          // drain
        }
      } catch (err) {
        caught = err;
      }

      // Assert
      const data = (caught as { data?: { code?: string; reason?: string } })?.data;
      expect(data?.code).toBe('INVALID_INDEX_ENTRY');
      expect(data?.reason).toBe("'.' segment rejected");
    });
  });
});

describe('Given a root-level tree entry named ".." (git refuses it at materialisation, not parse)', () => {
  describe('When archive iterates entries', () => {
    it('Then throws INVALID_INDEX_ENTRY with the dotdot-segment reason', async () => {
      // Arrange
      const ctx = await initUnbornCtx();
      const blobId = await writeObject(ctx, makeBlob('dotdot\n'));
      const rootTreeId = await writeObject(
        ctx,
        makeTree([treeEntry(FILE_MODE.REGULAR, '..', blobId)]),
      );
      const commitId = await writeObject(ctx, makeCommit(rootTreeId));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

      // Act
      const result = await archive(ctx, { treeish: 'HEAD' });
      let caught: unknown;
      try {
        for await (const _entry of result.entries) {
          // drain
        }
      } catch (err) {
        caught = err;
      }

      // Assert
      const data = (caught as { data?: { code?: string; reason?: string } })?.data;
      expect(data?.code).toBe('INVALID_INDEX_ENTRY');
      expect(data?.reason).toBe("'..' segment rejected");
    });
  });
});

describe('Given a tree entry literally named "a/b" (embedded separator, git accepts it)', () => {
  describe('When archive iterates entries', () => {
    it('Then no refusal is thrown and the entry keeps its literal path', async () => {
      // Arrange
      const ctx = await initUnbornCtx();
      const blobId = await writeObject(ctx, makeBlob('nested-by-name\n'));
      const rootTreeId = await writeObject(
        ctx,
        makeTree([treeEntry(FILE_MODE.REGULAR, 'a/b', blobId)]),
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
      expect(entries).toHaveLength(1);
      expect(entries[0]?.path).toBe('a/b');
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

describe('Given a tree chain a thousand directories deep under the default depth cap', () => {
  describe('When archive iterates all entries', () => {
    it('Then every directory is held back until the leaf flushes it', async () => {
      // Arrange
      const depth = 1000;
      const ctx = await initUnbornCtx();
      const treeId = await buildTreeChain(ctx, depth);

      // Act
      const result = await archive(ctx, { treeish: treeId });
      const entries: ArchiveEntry[] = [];
      for await (const entry of result.entries) {
        entries.push(entry);
      }

      // Assert
      expect(entries.map(({ path }) => path)).toEqual(
        Array.from({ length: depth + 1 }, (_unused, slashes) => deepIndexPath(slashes)),
      );
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

// ---------------------------------------------------------------------------
// Blob read order
// ---------------------------------------------------------------------------

const PRIMARY_OBJECTS = '/repo/.git/objects';
const ALT_OBJECTS = '/repo/alt/objects';
const THRESHOLD = 100;
const FLIPPED_SIGNATURE_MIDX = Uint8Array.from([
  0x00,
  0x49,
  0x44,
  0x58,
  1,
  1,
  1,
  0,
  ...new Array(8).fill(0),
]);

const contextWithAlternate = async (): Promise<Context> => {
  const ctx = await initUnbornCtx();
  await ctx.fs.writeUtf8(`${PRIMARY_OBJECTS}/info/alternates`, `${ALT_OBJECTS}\n`);
  await ctx.fs.writeUtf8('/repo/.git/config', `[core]\n\tbigFileThreshold = ${THRESHOLD}\n`);
  await ctx.fs.mkdir(ALT_OBJECTS);
  return ctx;
};

const bytesOf = (length: number, fill: number): Uint8Array => new Uint8Array(length).fill(fill);

/** Packs a large non-delta blob and a delta over it; returns [baseId, deltaId]. */
const packBaseAndDelta = async (
  ctx: Context,
  deltaSize: number,
): Promise<readonly [ObjectId, ObjectId]> => {
  const [base, delta] = await writeSyntheticPackIn(ctx, PRIMARY_OBJECTS, 'p', [
    { kind: 'base', type: 'blob', content: bytesOf(THRESHOLD + 1, 1) },
    { kind: 'ofs-delta', baseIndex: 0, targetContent: bytesOf(deltaSize, 2) },
  ]);
  return [base as ObjectId, delta as ObjectId];
};

const archiveEntries = async (
  ctx: Context,
  entries: ReadonlyArray<TreeEntry>,
): Promise<{ readonly seen: string[]; readonly failure: unknown }> => {
  const treeId = await writeObject(ctx, makeTree(entries));
  const commitId = await writeObject(ctx, makeCommit(treeId));
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);
  // A write through an alternate that cannot load is refused, so the fault is planted after the writes.
  await ctx.fs.write(`${ALT_OBJECTS}/pack/multi-pack-index`, FLIPPED_SIGNATURE_MIDX);
  const seen: string[] = [];
  try {
    const result = await archive({ ...ctx, session: createSession() }, { treeish: 'HEAD' });
    for await (const entry of result.entries) seen.push(entry.path);
  } catch (error) {
    return { seen, failure: (error as TsgitError).data };
  }
  return { seen, failure: undefined };
};

describe('archive blob read order', () => {
  describe('Given a regular delta blob above the threshold after a served large blob and a corrupt alternate', () => {
    describe('When the entries are iterated', () => {
      it('Then it rejects at the delta entry after yielding the earlier one', async () => {
        // Arrange
        const ctx = await contextWithAlternate();
        const [baseId, deltaId] = await packBaseAndDelta(ctx, THRESHOLD + 2);

        // Act
        const result = await archiveEntries(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'a', baseId),
          treeEntry(FILE_MODE.REGULAR, 'b', deltaId),
        ]);

        // Assert
        expect(result.seen).toEqual(['a']);
        expect(result.failure).toMatchObject({ code: 'INVALID_MULTI_PACK_INDEX' });
      });
    });
  });

  describe('Given a regular non-delta blob above the threshold and a corrupt alternate', () => {
    describe('When the entries are iterated', () => {
      it('Then it is served without reaching the alternate', async () => {
        // Arrange
        const ctx = await contextWithAlternate();
        const [baseId] = await packBaseAndDelta(ctx, THRESHOLD + 2);

        // Act
        const result = await archiveEntries(ctx, [treeEntry(FILE_MODE.REGULAR, 'a', baseId)]);

        // Assert
        expect(result).toEqual({ seen: ['a'], failure: undefined });
      });
    });
  });

  describe('Given a regular delta blob exactly at the threshold and a corrupt alternate', () => {
    describe('When the entries are iterated', () => {
      it('Then it is read in the default order, without reaching the alternate', async () => {
        // Arrange
        const ctx = await contextWithAlternate();
        const [, deltaId] = await packBaseAndDelta(ctx, THRESHOLD);

        // Act
        const result = await archiveEntries(ctx, [treeEntry(FILE_MODE.REGULAR, 'a', deltaId)]);

        // Assert
        expect(result).toEqual({ seen: ['a'], failure: undefined });
      });
    });
  });

  describe('Given a symlink delta blob above the threshold and a corrupt alternate', () => {
    describe('When the entries are iterated', () => {
      it('Then it is read in the default order, without reaching the alternate', async () => {
        // Arrange
        const ctx = await contextWithAlternate();
        const [, deltaId] = await packBaseAndDelta(ctx, THRESHOLD + 2);

        // Act
        const result = await archiveEntries(ctx, [treeEntry(FILE_MODE.SYMLINK, 'a', deltaId)]);

        // Assert
        expect(result).toEqual({ seen: ['a'], failure: undefined });
      });
    });
  });

  describe('Given an executable delta blob above the threshold and a corrupt alternate', () => {
    describe('When the entries are iterated', () => {
      it('Then it is read in stream order and reaches the alternate', async () => {
        // Arrange
        const ctx = await contextWithAlternate();
        const [, deltaId] = await packBaseAndDelta(ctx, THRESHOLD + 2);

        // Act
        const result = await archiveEntries(ctx, [treeEntry(FILE_MODE.EXECUTABLE, 'a', deltaId)]);

        // Assert
        expect(result.seen).toEqual([]);
        expect(result.failure).toMatchObject({ code: 'INVALID_MULTI_PACK_INDEX' });
      });
    });
  });

  describe('Given a regular entry naming a large non-blob and a corrupt alternate', () => {
    describe('When the entries are iterated', () => {
      it('Then the blob read refuses its type', async () => {
        // Arrange
        const ctx = await contextWithAlternate();
        const commitBytes = new TextEncoder().encode(
          `tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nauthor A <a@b> 1 +0000\ncommitter A <a@b> 1 +0000\n\n${'m'.repeat(THRESHOLD)}\n`,
        );
        const [commitId] = await writeSyntheticPackIn(ctx, PRIMARY_OBJECTS, 'p', [
          { kind: 'base', type: 'commit', content: commitBytes },
        ]);

        // Act
        const result = await archiveEntries(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'a', commitId as ObjectId),
        ]);

        // Assert
        expect(result.failure).toMatchObject({ code: 'UNEXPECTED_OBJECT_TYPE' });
      });
    });
  });
});

// ---------------------------------------------------------------------------
// export-ignore — attributes come from the archived tree
// ---------------------------------------------------------------------------

type Spec = readonly [path: string, content: string, mode?: FileMode];

const SUBMODULE_OID = '1234567890abcdef1234567890abcdef12345678' as ObjectId;

const leafEntry = async (ctx: Context, name: string, content: string, mode: FileMode) => {
  if (mode === FILE_MODE.GITLINK) return treeEntry(mode, name, SUBMODULE_OID);
  if (mode === FILE_MODE.DIRECTORY)
    return treeEntry(mode, name, await writeObject(ctx, makeTree([])));
  return treeEntry(mode, name, await writeObject(ctx, makeBlob(content)));
};

const writeSpecTree = async (ctx: Context, specs: ReadonlyArray<Spec>): Promise<ObjectId> => {
  const entries: TreeEntry[] = [];
  const nested = new Map<string, Spec[]>();
  for (const [path, content, mode = FILE_MODE.REGULAR] of specs) {
    const slash = path.indexOf('/');
    if (slash === -1) {
      entries.push(await leafEntry(ctx, path, content, mode));
      continue;
    }
    const head = path.slice(0, slash);
    nested.set(head, [...(nested.get(head) ?? []), [path.slice(slash + 1), content, mode]]);
  }
  for (const [name, children] of nested) {
    entries.push(treeEntry(FILE_MODE.DIRECTORY, name, await writeSpecTree(ctx, children)));
  }
  return writeObject(ctx, makeTree(entries));
};

const archivedPaths = async (ctx: Context, treeish: string): Promise<string[]> => {
  const result = await archive(ctx, { treeish });
  const paths: string[] = [];
  for await (const entry of result.entries) paths.push(entry.path);
  return paths;
};

const archiveSpec = async (
  specs: ReadonlyArray<Spec>,
  ctx: Context = createMemoryContext(),
): Promise<string[]> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  const tree = await writeSpecTree(ctx, specs);
  return archivedPaths(ctx, tree);
};

describe('Given a committed .gitattributes with export-ignore rules on files', () => {
  describe('When archive iterates entries', () => {
    it.each([
      { label: 'set', rules: 'f export-ignore\n', kept: false },
      { label: 'unset', rules: 'f -export-ignore\n', kept: true },
      { label: 'string value', rules: 'f export-ignore=true\n', kept: true },
      { label: 'unspecified', rules: 'f !export-ignore\n', kept: true },
      {
        label: 'set through a macro',
        rules: '[attr]hidden export-ignore\nf hidden\n',
        kept: false,
      },
    ])('Then a file whose export-ignore is $label is kept=$kept', async ({ rules, kept }) => {
      // Arrange
      const specs: Spec[] = [
        ['.gitattributes', rules],
        ['f', 'x'],
      ];

      // Act
      const result = await archiveSpec(specs);

      // Assert
      expect(result.includes('f')).toBe(kept);
      expect(result).toContain('.gitattributes');
    });
  });
});

describe('Given a committed .gitattributes with export-ignore rules on directories', () => {
  describe('When archive iterates entries', () => {
    it.each([
      { label: 'by name', rules: 'a export-ignore\n' },
      { label: 'by name with a trailing slash', rules: 'a/ export-ignore\n' },
    ])('Then a directory ignored $label drops itself and every descendant', async ({ rules }) => {
      // Arrange
      const specs: Spec[] = [
        ['.gitattributes', rules],
        ['a/x', '1'],
        ['a/deep/y', '2'],
        ['keep', '3'],
      ];

      // Act
      const result = await archiveSpec(specs);

      // Assert
      expect(result).toEqual(['.gitattributes', 'keep']);
    });
  });

  describe('When the rule is dir/** and the directory holds a file', () => {
    it('Then the directory is emitted before its ignored child', async () => {
      // Arrange
      const specs: Spec[] = [
        ['.gitattributes', 'c/** export-ignore\n'],
        ['c/x', '1'],
      ];

      // Act
      const result = await archiveSpec(specs);

      // Assert
      expect(result).toEqual(['.gitattributes', 'c']);
    });
  });

  describe('When the only child of a directory is an ignored subdirectory', () => {
    it('Then neither the directory nor the subdirectory is emitted', async () => {
      // Arrange
      const specs: Spec[] = [
        ['.gitattributes', 'd/e export-ignore\n'],
        ['d/e/z', '1'],
        ['keep', '2'],
      ];

      // Act
      const result = await archiveSpec(specs);

      // Assert
      expect(result).toEqual(['.gitattributes', 'keep']);
    });
  });

  describe('When an ignored directory three levels down is followed by a sibling directory at the root', () => {
    it('Then every held-back ancestor is dropped before the sibling is emitted', async () => {
      // Arrange
      const specs: Spec[] = [
        ['.gitattributes', 'a/b/c/x export-ignore\n'],
        ['a/b/c/x/f', '1'],
        ['d/y', '2'],
      ];

      // Act
      const result = await archiveSpec(specs);

      // Assert
      expect(result).toEqual(['.gitattributes', 'd', 'd/y']);
    });
  });

  describe('When the tree holds an empty subtree', () => {
    it('Then the empty subtree is never emitted', async () => {
      // Arrange
      const specs: Spec[] = [
        ['empty', '', FILE_MODE.DIRECTORY],
        ['keep', '1'],
      ];

      // Act
      const result = await archiveSpec(specs);

      // Assert
      expect(result).toEqual(['keep']);
    });
  });

  describe('When a directory rule sits beside a same-named file in another directory', () => {
    it('Then only the directory is ignored', async () => {
      // Arrange
      const specs: Spec[] = [
        ['.gitattributes', 'foo/ export-ignore\n'],
        ['foo', 'file'],
        ['x/foo/k', '1'],
      ];

      // Act
      const result = await archiveSpec(specs);

      // Assert
      expect(result).toEqual(['.gitattributes', 'foo']);
    });
  });
});

describe('Given export-ignore rules on gitlinks and symlinks', () => {
  describe('When the rule is directory-only and the entry is a gitlink', () => {
    it('Then the gitlink is checked as a directory and omitted', async () => {
      // Arrange
      const specs: Spec[] = [
        ['.gitattributes', 'sm/ export-ignore\n'],
        ['sm', '', FILE_MODE.GITLINK],
        ['keep', '1'],
      ];

      // Act
      const result = await archiveSpec(specs);

      // Assert
      expect(result).toEqual(['.gitattributes', 'keep']);
    });
  });

  describe('When an ignored gitlink is the only child of a directory', () => {
    it('Then the directory is still emitted, flushed before the gitlink check', async () => {
      // Arrange
      const specs: Spec[] = [
        ['.gitattributes', 'd/sm export-ignore\n'],
        ['d/sm', '', FILE_MODE.GITLINK],
      ];

      // Act
      const result = await archiveSpec(specs);

      // Assert
      expect(result).toEqual(['.gitattributes', 'd']);
    });
  });

  describe('When a symlink matches export-ignore', () => {
    it('Then the symlink is omitted', async () => {
      // Arrange
      const specs: Spec[] = [
        ['.gitattributes', 'lnk export-ignore\n'],
        ['lnk', 'target', FILE_MODE.SYMLINK],
      ];

      // Act
      const result = await archiveSpec(specs);

      // Assert
      expect(result).toEqual(['.gitattributes']);
    });
  });
});

describe('Given attributes sourced from the archived tree', () => {
  describe('When the worktree .gitattributes disagrees with the committed one', () => {
    it('Then the committed rules decide', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, 'keep export-ignore\n');
      const specs: Spec[] = [
        ['.gitattributes', 't1 export-ignore\n'],
        ['t1', '1'],
        ['keep', '2'],
      ];

      // Act
      const result = await archiveSpec(specs, ctx);

      // Assert
      expect(result).toEqual(['.gitattributes', 'keep']);
    });
  });

  describe('When the context is bare', () => {
    it('Then the committed .gitattributes still applies', async () => {
      // Arrange
      const ctx = asBareContext(createMemoryContext());
      const specs: Spec[] = [
        ['.gitattributes', 't1 export-ignore\n'],
        ['t1', '1'],
      ];

      // Act
      const result = await archiveSpec(specs, ctx);

      // Assert
      expect(result).toEqual(['.gitattributes']);
    });
  });

  describe('When a nested .gitattributes governs only its own directory', () => {
    it('Then the nested rule applies below it and not beside it', async () => {
      // Arrange
      const specs: Spec[] = [
        ['sub/.gitattributes', 'y export-ignore\n'],
        ['sub/y', '1'],
        ['y', '2'],
      ];

      // Act
      const result = await archiveSpec(specs);

      // Assert
      expect(result).toEqual(['sub', 'sub/.gitattributes', 'y']);
    });
  });

  describe('When info/attributes names a path', () => {
    it('Then the path is omitted and its directory is emitted', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/info/attributes`, 'g/x export-ignore\n');
      const specs: Spec[] = [['g/x', '1']];

      // Act
      const result = await archiveSpec(specs, ctx);

      // Assert
      expect(result).toEqual(['g']);
    });
  });
});

describe('Given an invalid entry name inside an export-ignored subtree', () => {
  describe('When archive iterates entries', () => {
    it('Then the path validation still refuses it', async () => {
      // Arrange
      const specs: Spec[] = [
        ['.gitattributes', 'a export-ignore\n'],
        ['a/..', '1'],
      ];

      // Act
      let caught: unknown;
      try {
        await archiveSpec(specs);
      } catch (err) {
        caught = err;
      }

      // Assert
      const data = (caught as { data?: { code?: string; reason?: string } })?.data;
      expect(data?.code).toBe('INVALID_INDEX_ENTRY');
      expect(data?.reason).toBe("'..' segment rejected");
    });
  });
});

// ---------------------------------------------------------------------------
// export-subst — $Format:…$ expansion against the archived commit
// ---------------------------------------------------------------------------

const textDecoder = new TextDecoder();

const seedSubstCommit = async (
  specs: ReadonlyArray<Spec>,
  ctx: Context = createMemoryContext(),
): Promise<{ readonly ctx: Context; readonly tree: ObjectId; readonly commitId: ObjectId }> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  const tree = await writeSpecTree(ctx, specs);
  const commitId = await writeObject(ctx, makeCommit(tree));
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);
  return { ctx, tree, commitId };
};

const archivedText = async (ctx: Context, treeish: string): Promise<Record<string, string>> => {
  const result = await archive(ctx, { treeish });
  const contents: Record<string, string> = {};
  for await (const entry of result.entries) {
    if (entry.content) contents[entry.path] = textDecoder.decode(entry.content);
  }
  return contents;
};

const SUBST_ALL = '* export-subst\n';

describe('archive export-subst routing', () => {
  afterEach(() => {
    vi.mocked(readBlob).mockClear();
    vi.mocked(readBlobContentInStreamOrder).mockClear();
  });

  describe('Given an export-subst file archived from the raw tree id', () => {
    describe('When the entries are iterated', () => {
      it('Then the file is kept verbatim', async () => {
        // Arrange
        const { ctx, tree } = await seedSubstCommit([
          ['.gitattributes', SUBST_ALL],
          ['f', 'id $Format:%H$'],
        ]);
        const sut = archivedText;

        // Act
        const result = await sut(ctx, tree);

        // Assert
        expect(result.f).toBe('id $Format:%H$');
      });
    });
  });

  describe('Given an export-subst file archived through an annotated tag', () => {
    describe('When the entries are iterated', () => {
      it('Then the placeholder expands against the peeled commit', async () => {
        // Arrange
        const { ctx, commitId } = await seedSubstCommit([
          ['.gitattributes', SUBST_ALL],
          ['f', 'id $Format:%H$'],
        ]);
        const tagId = await writeObject(ctx, makeTag(commitId, 'v1'));
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/tags/v1`, `${tagId}\n`);
        const sut = archivedText;

        // Act
        const result = await sut(ctx, 'v1');

        // Assert
        expect(result.f).toBe(`id ${commitId}`);
      });
    });
  });

  describe('Given an export-subst file with abbreviated ids', () => {
    describe('When the entries are iterated', () => {
      it("Then they are git's unique abbreviations", async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
        const tree = await writeSpecTree(ctx, [
          ['.gitattributes', SUBST_ALL],
          ['f', '$Format:%h|%t|%p$'],
        ]);
        const parent = await writeObject(ctx, makeCommit(tree));
        const commitId = await writeObject(ctx, makeCommit(tree, [parent]));
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);
        const sut = archivedText;

        // Act
        const result = await sut(ctx, 'HEAD');

        // Assert
        expect(result.f).toBe(`${commitId.slice(0, 7)}|${tree.slice(0, 7)}|${parent.slice(0, 7)}`);
      });
    });
  });

  describe('Given an executable export-subst file', () => {
    describe('When the entries are iterated', () => {
      it('Then the placeholder expands', async () => {
        // Arrange
        const { ctx, commitId } = await seedSubstCommit([
          ['.gitattributes', SUBST_ALL],
          ['run', '$Format:%H$', FILE_MODE.EXECUTABLE],
        ]);
        const sut = archivedText;

        // Act
        const result = await sut(ctx, 'HEAD');

        // Assert
        expect(result.run).toBe(commitId);
      });
    });
  });

  describe('Given a symlink with export-subst', () => {
    describe('When the entries are iterated', () => {
      it('Then the link target is kept verbatim', async () => {
        // Arrange
        const { ctx } = await seedSubstCommit([
          ['.gitattributes', SUBST_ALL],
          ['link', '$Format:%H$', FILE_MODE.SYMLINK],
        ]);
        const sut = archivedText;

        // Act
        const result = await sut(ctx, 'HEAD');

        // Assert
        expect(result.link).toBe('$Format:%H$');
      });
    });
  });

  describe('Given two export-subst files of a commit encoded in ISO-8859-1', () => {
    describe('When the entries are iterated', () => {
      it('Then both are transcoded with one encoder built for the archive', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
        const tree = await writeSpecTree(ctx, [
          ['.gitattributes', SUBST_ALL],
          ['a', 'é $Format:%s$'],
          ['b', 'é $Format:%s$'],
        ]);
        const commit = makeCommit(tree);
        const encoded = {
          ...commit,
          data: { ...commit.data, extraHeaders: [{ key: 'encoding', value: 'ISO-8859-1' }] },
        };
        const commitId = await writeObject(ctx, encoded);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);
        vi.mocked(buildCharsetEncoder).mockClear();
        const sut = archive;

        // Act
        const result = await sut(ctx, { treeish: 'HEAD' });
        const contents = new Map<string, ReadonlyArray<number>>();
        for await (const entry of result.entries) {
          if (entry.content) contents.set(entry.path, [...entry.content]);
        }

        // Assert
        const latin1 = [0xe9, ...new TextEncoder().encode(' commit')];
        expect(contents.get('a')).toEqual(latin1);
        expect(contents.get('b')).toEqual(latin1);
        expect(vi.mocked(buildCharsetEncoder).mock.calls).toEqual([['iso-8859-1']]);
      });
    });

    describe('When it is archived twice in one session', () => {
      it('Then both archives transcode with the one encoder the session built', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
        const tree = await writeSpecTree(ctx, [
          ['.gitattributes', SUBST_ALL],
          ['a', 'é $Format:%s$'],
        ]);
        const commit = makeCommit(tree);
        const encoded = {
          ...commit,
          data: { ...commit.data, extraHeaders: [{ key: 'encoding', value: 'ISO-8859-1' }] },
        };
        const commitId = await writeObject(ctx, encoded);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);
        vi.mocked(buildCharsetEncoder).mockClear();
        const sut = archive;
        const contentOfA = async (): Promise<ReadonlyArray<number> | undefined> => {
          const { entries } = await sut(ctx, { treeish: 'HEAD' });
          let content: ReadonlyArray<number> | undefined;
          for await (const entry of entries) {
            if (entry.path === 'a' && entry.content) content = [...entry.content];
          }
          return content;
        };

        // Act
        const result = [await contentOfA(), await contentOfA()];

        // Assert
        const latin1 = [0xe9, ...new TextEncoder().encode(' commit')];
        expect(result).toEqual([latin1, latin1]);
        expect(vi.mocked(buildCharsetEncoder).mock.calls).toEqual([['iso-8859-1']]);
      });
    });
  });

  describe('Given an export-subst file above core.bigFileThreshold', () => {
    const bigFormat = `${'x'.repeat(THRESHOLD)}$Format:%H$`;

    describe('When it is archived from the commit', () => {
      it('Then it is read whole and expanded, never streamed', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8('/repo/.git/config', `[core]\n\tbigFileThreshold = ${THRESHOLD}\n`);
        const { commitId } = await seedSubstCommit(
          [
            ['.gitattributes', 'big export-subst\n'],
            ['big', bigFormat],
          ],
          ctx,
        );
        const sut = archivedText;

        // Act
        const result = await sut(ctx, 'HEAD');

        // Assert
        expect(result.big).toBe(`${'x'.repeat(THRESHOLD)}${commitId}`);
        expect(readBlobContentInStreamOrder).not.toHaveBeenCalled();
      });
    });

    describe('When it is archived from the raw tree id', () => {
      it('Then it is still read whole, the attribute alone deciding', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8('/repo/.git/config', `[core]\n\tbigFileThreshold = ${THRESHOLD}\n`);
        const { tree } = await seedSubstCommit(
          [
            ['.gitattributes', 'big export-subst\n'],
            ['big', bigFormat],
            ['other', 'y'.repeat(THRESHOLD + 1)],
          ],
          ctx,
        );
        const sut = archivedText;

        // Act
        const result = await sut(ctx, tree);

        // Assert
        expect(result.big).toBe(bigFormat);
        expect(vi.mocked(readBlobContentInStreamOrder).mock.calls.length).toBe(1);
      });
    });
  });
});

const seedTaggedHistory = async (
  files: ReadonlyArray<Spec>,
): Promise<{ readonly ctx: Context; readonly commitId: ObjectId }> => {
  const ctx = createMemoryContext();
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  const tree = await writeSpecTree(ctx, [['.gitattributes', SUBST_ALL], ...files]);
  const parent = await writeObject(ctx, makeCommit(tree));
  const commitId = await writeObject(ctx, makeCommit(tree, [parent]));
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);
  const tagId = await writeObject(ctx, makeTag(parent, 'v1'));
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/tags/v1`, `${tagId}\n`);
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/tags/lw`, `${commitId}\n`);
  return { ctx, commitId };
};

describe('archive export-subst describe budget', () => {
  describe('Given two files each asking for a description', () => {
    describe('When the entries are iterated', () => {
      it('Then the first in pre-order is described and the second kept literal', async () => {
        // Arrange
        const { ctx, commitId } = await seedTaggedHistory([
          ['a.txt', 'A=$Format:%(describe)$'],
          ['z.txt', 'Z=$Format:%(describe)$'],
        ]);
        const sut = archivedText;

        // Act
        const result = await sut(ctx, 'HEAD');

        // Assert
        expect(result['a.txt']).toBe(`A=v1-1-g${commitId.slice(0, 7)}`);
        expect(result['z.txt']).toBe('Z=%(describe)');
      });
    });
  });

  describe('Given a malformed describe placeholder in the first file', () => {
    describe('When the entries are iterated', () => {
      it('Then it is kept literal and still spends the budget', async () => {
        // Arrange
        const { ctx } = await seedTaggedHistory([
          ['a.txt', 'A=$Format:%(describe:foo)$'],
          ['z.txt', 'Z=$Format:%(describe)$'],
        ]);
        const sut = archivedText;

        // Act
        const result = await sut(ctx, 'HEAD');

        // Assert
        expect(result['a.txt']).toBe('A=%(describe:foo)');
        expect(result['z.txt']).toBe('Z=%(describe)');
      });
    });
  });

  describe('Given a repository without tags', () => {
    describe('When two files ask for a description', () => {
      it('Then the first expands to nothing and still spends the budget', async () => {
        // Arrange
        const { ctx } = await seedSubstCommit([
          ['.gitattributes', SUBST_ALL],
          ['a.txt', 'A=$Format:%(describe)$'],
          ['z.txt', 'Z=$Format:%(describe)$'],
        ]);
        const sut = archivedText;

        // Act
        const result = await sut(ctx, 'HEAD');

        // Assert
        expect(result['a.txt']).toBe('A=');
        expect(result['z.txt']).toBe('Z=%(describe)');
      });
    });
  });

  describe.each([
    ['abbrev=0', (_id: string) => 'v1'],
    ['abbrev=5', (id: string) => `v1-1-g${id.slice(0, 5)}`],
    ['abbrev=-3', (id: string) => `v1-1-g${id.slice(0, 4)}`],
    ['abbrev=99', (id: string) => `v1-1-g${id}`],
    ['tags', (_id: string) => 'lw'],
    ['match=x*', (_id: string) => ''],
    ['exclude=v*', (_id: string) => ''],
    ['tags,exclude=lw', (id: string) => `v1-1-g${id.slice(0, 7)}`],
  ])('Given a describe placeholder with %s', (args, expected) => {
    describe('When the entries are iterated', () => {
      it('Then the describe options shape the description', async () => {
        // Arrange
        const { ctx, commitId } = await seedTaggedHistory([['f', `$Format:%(describe:${args})$`]]);
        const sut = archivedText;

        // Act
        const result = await sut(ctx, 'HEAD');

        // Assert
        expect(result.f).toBe(expected(commitId));
      });
    });
  });
});

const iterateUntilFailure = async (
  ctx: Context,
): Promise<{ readonly seen: string[]; readonly failure: unknown }> => {
  const seen: string[] = [];
  try {
    const result = await archive(ctx, { treeish: 'HEAD' });
    for await (const entry of result.entries) seen.push(entry.path);
  } catch (error) {
    return { seen, failure: (error as TsgitError).data };
  }
  return { seen, failure: undefined };
};

describe('archive export-subst refusals', () => {
  describe.each([
    ['%(count)', 'not-supported'],
    ['%(total)', 'not-supported'],
    ['%C', 'unparsable'],
  ])('Given a file whose format reaches %s', (placeholder, reason) => {
    describe('When the entries are iterated', () => {
      it('Then iteration rejects at that file after the earlier entries', async () => {
        // Arrange
        const format = placeholder === '%C' ? '%C(always,zzz)' : placeholder;
        const { ctx } = await seedSubstCommit([
          ['.gitattributes', SUBST_ALL],
          ['a.txt', 'plain'],
          ['b.txt', `$Format:%H${format}$`],
          ['c.txt', 'never reached'],
        ]);
        const sut = iterateUntilFailure;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.seen).toEqual(['.gitattributes', 'a.txt']);
        expect(result.failure).toEqual({
          code: 'FORMAT_PLACEHOLDER_UNSUPPORTED',
          placeholder,
          reason,
        });
      });
    });
  });
});

const RESOLVERS = [
  ['abbreviateObjectId', abbreviateObjectId],
  ['abbreviateObjectIdFrom', abbreviateObjectIdFrom],
  ['loadRefDecorations', loadRefDecorations],
  ['readMailmap', readMailmap],
  ['verifyCommitSignature', verifyCommitSignature],
  ['describe', describeCommit],
] as const;

const SIGNATURE = '-----BEGIN PGP SIGNATURE-----\n\nabc\n-----END PGP SIGNATURE-----';

describe('archive export-subst resolved data', () => {
  beforeEach(() => {
    for (const [, resolver] of RESOLVERS) vi.mocked(resolver).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe.each([
    ['an export-subst file with only the full id', SUBST_ALL, '$Format:%H$'],
    ['a file without export-subst', '', '$Format:%h%aN%d%G?%(describe)$'],
    ['an export-subst file without any occurrence', SUBST_ALL, 'plain %h text'],
  ])('Given %s', (_title, attributes, content) => {
    describe('When the entries are iterated', () => {
      it.each(RESOLVERS)('Then %s is never called', async (_name, resolver) => {
        // Arrange
        const { ctx } = await seedSubstCommit([
          ['.gitattributes', attributes],
          ['f', content],
        ]);
        const sut = archivedText;

        // Act
        await sut(ctx, 'HEAD');

        // Assert
        expect(resolver).not.toHaveBeenCalled();
      });
    });
  });

  describe.each([
    ['an earlier occurrence', '$Format:%(count)$ $Format:%h%aN%d%G?%(describe)$'],
    ['the same occurrence', '$Format:%(count)%h%aN%d%G?%(describe)$'],
  ])('Given %%(count) before every resolved placeholder in %s', (_where, content) => {
    describe('When the entries are iterated', () => {
      it.each(RESOLVERS)('Then %s is never called before the refusal', async (_name, resolver) => {
        // Arrange
        const { ctx } = await seedSubstCommit([
          ['.gitattributes', SUBST_ALL],
          ['f', content],
        ]);
        const sut = iterateUntilFailure;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.failure).toMatchObject({ placeholder: '%(count)' });
        expect(resolver).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a worktree .mailmap and an ident placeholder read through the mailmap', () => {
    describe('When the entries are iterated', () => {
      it('Then the ident is mapped through the worktree mailmap', async () => {
        // Arrange
        const { ctx } = await seedSubstCommit([
          ['.gitattributes', SUBST_ALL],
          ['.mailmap', 'Ignored <ignored@example.com> Ada <ada@example.com>\n'],
          ['f', '$Format:%aN|%aE|%an$'],
        ]);
        await ctx.fs.writeUtf8(
          `${ctx.layout.workDir}/.mailmap`,
          'Mapped Name <mapped@example.com> Ada <ada@example.com>\n',
        );
        const sut = archivedText;

        // Act
        const result = await sut(ctx, 'HEAD');

        // Assert
        expect(result.f).toBe('Mapped Name|mapped@example.com|Ada');
      });
    });
  });

  describe('Given a decoration placeholder', () => {
    describe('When the entries are iterated', () => {
      it("Then it lists the repository's refs pointing at the commit", async () => {
        // Arrange
        const { ctx } = await seedTaggedHistory([['f', '$Format:%D$']]);
        const sut = archivedText;

        // Act
        const result = await sut(ctx, 'HEAD');

        // Assert
        expect(result.f).toBe('HEAD -> main, tag: lw');
      });
    });
  });

  describe('Given an unsigned commit and signature placeholders', () => {
    describe('When the entries are iterated', () => {
      it('Then they read as unsigned without running a verifier', async () => {
        // Arrange
        const { ctx } = await seedSubstCommit([
          ['.gitattributes', SUBST_ALL],
          ['f', '$Format:%G?|%GT|%GS$'],
        ]);
        const sut = archivedText;

        // Act
        const result = await sut(ctx, 'HEAD');

        // Assert
        expect(result.f).toBe('N|undefined|');
        expect(verifyCommitSignature).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a signed commit and signature placeholders', () => {
    describe('When the entries are iterated', () => {
      it('Then the verifier receives the commit without its signature header', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
        const tree = await writeSpecTree(ctx, [
          ['.gitattributes', SUBST_ALL],
          ['f', '$Format:%G?|%GT$'],
        ]);
        const unsigned = makeCommit(tree);
        const commitId = await writeObject(ctx, {
          ...unsigned,
          data: { ...unsigned.data, gpgSignature: SIGNATURE },
        });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);
        const unsignedId = await writeObject(ctx, unsigned);
        const { content: payload } = await readRawObject(ctx, unsignedId);
        const sut = archivedText;

        // Act
        const result = await sut(ctx, 'HEAD');

        // Assert
        expect(result.f).toBe('N|undefined');
        expect(verifyCommitSignature).toHaveBeenCalledTimes(1);
        expect(vi.mocked(verifyCommitSignature).mock.calls[0]?.[1]).toEqual({
          payload,
          signature: `${SIGNATURE}\n`,
        });
      });
    });
  });

  describe('Given a signed commit and a configured gpg program', () => {
    describe('When the entries are iterated', () => {
      it('Then the verifier receives the gpg configuration', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[gpg]\n\tprogram = /bin/false\n');
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
        const tree = await writeSpecTree(ctx, [
          ['.gitattributes', SUBST_ALL],
          ['f', '$Format:%G?$'],
        ]);
        const unsigned = makeCommit(tree);
        const commitId = await writeObject(ctx, {
          ...unsigned,
          data: { ...unsigned.data, gpgSignature: SIGNATURE },
        });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);
        const sut = archivedText;

        // Act
        await sut(ctx, 'HEAD');

        // Assert
        expect(vi.mocked(verifyCommitSignature).mock.calls[0]?.[1]).toMatchObject({
          gpg: { program: '/bin/false' },
        });
      });
    });
  });

  describe('Given a commit no ref points at and a decoration placeholder', () => {
    describe('When it is archived by id', () => {
      it('Then the decorations are empty', async () => {
        // Arrange
        const { ctx, tree, commitId } = await seedSubstCommit([
          ['.gitattributes', SUBST_ALL],
          ['f', '[$Format:%D$]'],
        ]);
        const orphan = await writeObject(ctx, makeCommit(tree, [commitId]));
        const sut = archivedText;

        // Act
        const result = await sut(ctx, orphan);

        // Assert
        expect(result.f).toBe('[]');
      });
    });
  });

  describe('Given describe failing with an unexpected error', () => {
    describe('When the entries are iterated', () => {
      it('Then the error propagates', async () => {
        // Arrange
        const { ctx } = await seedTaggedHistory([['f', '$Format:%(describe)$']]);
        const boom = new Error('boom');
        vi.mocked(describeCommit).mockRejectedValueOnce(boom);
        const sut = archivedText;

        // Act
        const result = await sut(ctx, 'HEAD').catch((error: unknown) => error);

        // Assert
        expect(result).toBe(boom);
      });
    });
  });

  describe('Given two files with abbreviated ids', () => {
    describe('When the entries are iterated', () => {
      it('Then each id is abbreviated once per archive', async () => {
        // Arrange
        const { ctx, commitId } = await seedSubstCommit([
          ['.gitattributes', SUBST_ALL],
          ['a', '$Format:%h$'],
          ['b', '$Format:%h$'],
        ]);
        const sut = archivedText;

        // Act
        const result = await sut(ctx, 'HEAD');

        // Assert
        expect(result.b).toBe(commitId.slice(0, 7));
        expect(abbreviateObjectId).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given a relative date placeholder', () => {
    describe('When the entries are iterated two hours after the commit', () => {
      it('Then the date is relative to the clock read for the archive', async () => {
        // Arrange
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime((COMMITTER_TIMESTAMP + 2 * 3600) * 1000);
        const { ctx } = await seedSubstCommit([
          ['.gitattributes', SUBST_ALL],
          ['f', '$Format:%cr$'],
        ]);
        const sut = archivedText;

        // Act
        const result = await sut(ctx, 'HEAD');

        // Assert
        expect(result.f).toBe('2 hours ago');
      });
    });
  });

  describe('Given trailer.separators and a trailers placeholder', () => {
    describe('When the entries are iterated', () => {
      it('Then the configured separator delimits the trailer', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[trailer]\n\tseparators = "#"\n');
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
        const tree = await writeSpecTree(ctx, [
          ['.gitattributes', SUBST_ALL],
          ['f', '$Format:%(trailers)$|'],
        ]);
        const base = makeCommit(tree);
        const commitId = await writeObject(ctx, {
          ...base,
          data: { ...base.data, message: 's\n\nBug #42\n' },
        });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);
        const sut = archivedText;

        // Act
        const result = await sut(ctx, 'HEAD');

        // Assert
        expect(result.f).toBe('Bug #42\n|');
      });
    });
  });
});

describe('archive core.bigFileThreshold read', () => {
  const malformedThresholdCtx = async (): Promise<Context> => {
    const ctx = await initUnbornCtx();
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tbigFileThreshold = x\n');
    return ctx;
  };

  const drain = async (ctx: Context, entries: ReadonlyArray<TreeEntry>): Promise<unknown> => {
    const treeId = await writeObject(ctx, makeTree(entries));
    try {
      const result = await archive(ctx, { treeish: treeId });
      for await (const _entry of result.entries) {
        // draining reads every entry's content
      }
      return undefined;
    } catch (error) {
      return (error as TsgitError).data;
    }
  };

  describe('Given a malformed core.bigFileThreshold', () => {
    describe('When a regular blob entry is read', () => {
      it('Then it refuses with the key', async () => {
        // Arrange
        const ctx = await malformedThresholdCtx();
        const blobId = await writeObject(ctx, makeBlob('a\n'));
        const sut = drain;

        // Act
        const result = await sut(ctx, [treeEntry(FILE_MODE.REGULAR, 'a.txt', blobId)]);

        // Assert
        expect(result).toMatchObject({
          code: 'CONFIG_BAD_NUMERIC_VALUE',
          key: 'core.bigfilethreshold',
          value: 'x',
        });
      });
    });

    describe('When only a symlink entry is read', () => {
      it('Then it archives without reading the threshold', async () => {
        // Arrange
        const ctx = await malformedThresholdCtx();
        const blobId = await writeObject(ctx, makeBlob('target'));
        const sut = drain;

        // Act
        const result = await sut(ctx, [treeEntry(FILE_MODE.SYMLINK, 'link', blobId)]);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });
});
