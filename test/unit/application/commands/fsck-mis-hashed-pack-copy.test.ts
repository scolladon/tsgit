/**
 * A pack entry whose bytes hash to another tree: git walks it as the store
 * serves it, but marks an object's children used only from a copy that
 * passes its hash, and `fsck_cache_tree`'s `parse_object` refuses the
 * mis-hashed copy it reads first.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { type FsckFinding, fsck } from '../../../../src/application/commands/fsck.js';
import { looseObjectPath } from '../../../../src/application/primitives/path-layout.js';
import { refreshPackRegistry } from '../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { GitIndex } from '../../../../src/domain/git-index/index-entry.js';
import { STAGE0_FLAGS } from '../../../../src/domain/git-index/index-entry.js';
import { hexToBytes } from '../../../../src/domain/objects/encoding.js';
import { FILE_MODE, type ObjectId } from '../../../../src/domain/objects/index.js';
import type { FilePath } from '../../../../src/domain/objects/object-id.js';
import { serializeTreeContent, treeEntry } from '../../../../src/domain/objects/tree.js';
import type { Context } from '../../../../src/ports/context.js';
import { serializeIndexFixtureAsync } from '../primitives/fixtures.js';
import { writeSyntheticPack } from '../primitives/pack-fixture.js';

const EXIT_REFS_CONTENT = 8;
const AUTHOR = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};
const enc = new TextEncoder();

interface MisHashedRepo {
  readonly ctx: Context;
  readonly tree: ObjectId;
  readonly subtree: ObjectId;
  readonly a: ObjectId;
  readonly b: ObjectId;
}

const blobEntry = (name: string, id: ObjectId) => treeEntry(FILE_MODE.REGULAR, name, id);

/**
 * `main` names a commit over tree `d/a`, `b`; a pack holds that tree's id
 * over another tree's bytes, `zz` naming `b`.
 */
const repoWithMisHashedTree = async (): Promise<MisHashedRepo> => {
  const ctx = createMemoryContext();
  const blob = (text: string) =>
    writeObject(ctx, { type: 'blob', id: '' as ObjectId, content: enc.encode(text) });
  const a = await blob('a\n');
  const b = await blob('b\n');
  const subtree = await writeObject(ctx, {
    type: 'tree',
    id: '' as ObjectId,
    entries: [blobEntry('a', a)],
  });
  const tree = await writeObject(ctx, {
    type: 'tree',
    id: '' as ObjectId,
    entries: [blobEntry('b', b), treeEntry(FILE_MODE.DIRECTORY, 'd', subtree)],
  });
  const commit = await writeObject(ctx, {
    type: 'commit',
    id: '' as ObjectId,
    data: { tree, parents: [], author: AUTHOR, committer: AUTHOR, message: 'c1', extraHeaders: [] },
  });
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commit}\n`);
  await writeSyntheticPack(ctx, 'mis', [
    {
      kind: 'base',
      type: 'tree',
      content: serializeTreeContent(
        { type: 'tree', id: '' as ObjectId, entries: [blobEntry('zz', b)] },
        ctx.hashConfig,
      ),
      idOverride: tree,
    },
  ]);
  refreshPackRegistry(ctx);
  return { ctx, tree, subtree, a, b };
};

const indexEntry = (id: ObjectId, path: string) => ({
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
  id,
  flags: STAGE0_FLAGS,
  path: path as FilePath,
});

/** An index over `b` and `d/a` whose cache-tree root names `tree`. */
const writeIndexNaming = async (repo: MisHashedRepo): Promise<void> => {
  const index: GitIndex = {
    version: 2,
    entries: [indexEntry(repo.b, 'b'), indexEntry(repo.a, 'd/a')],
    extensions: [
      {
        signature: 'TREE',
        data: Uint8Array.from([...enc.encode('\u00002 0\n'), ...hexToBytes(repo.tree)]),
      },
    ],
    trailerSha: new Uint8Array(0),
  };
  await repo.ctx.fs.write(
    `${repo.ctx.layout.gitDir}/index`,
    await serializeIndexFixtureAsync(index, repo.ctx),
  );
};

const danglingIds = (findings: ReadonlyArray<FsckFinding>) =>
  findings.flatMap((finding) => (finding.type === 'dangling' ? [finding.id] : []));

describe('Given a tree whose packed copy hashes to another tree beside a valid loose copy', () => {
  describe('When fsck runs without an index', () => {
    it('Then nothing is dangling, as the loose copy marks its children used', async () => {
      // Arrange
      const repo = await repoWithMisHashedTree();
      const sut = fsck;

      // Act
      const result = await sut(repo.ctx);

      // Assert
      expect(danglingIds(result.findings)).toEqual([]);
      expect(result.exitCode).toBe(1);
    });
  });

  describe('When fsck runs with a cache-tree naming it', () => {
    it('Then the cache-tree pointer is invalid, as the packed copy fails its hash', async () => {
      // Arrange
      const repo = await repoWithMisHashedTree();
      await writeIndexNaming(repo);
      const sut = fsck;

      // Act
      const result = await sut(repo.ctx);

      // Assert
      expect(result.findings.filter((f) => f.type === 'invalid-cache-tree-pointer')).toEqual([
        {
          type: 'invalid-cache-tree-pointer',
          id: repo.tree,
          index: `${repo.ctx.layout.gitDir}/index`,
        },
      ]);
      expect(danglingIds(result.findings)).toEqual([]);
      expect(result.exitCode).toBe(1 | EXIT_REFS_CONTENT);
    });
  });
});

describe('Given a tree whose only copy is packed and hashes to another tree', () => {
  describe('When fsck runs without an index', () => {
    it('Then what only its true bytes name is dangling, and the blob its bytes name too', async () => {
      // Arrange
      const repo = await repoWithMisHashedTree();
      await repo.ctx.fs.rm(looseObjectPath(repo.ctx.layout.gitDir, repo.tree));
      const sut = fsck;

      // Act
      const result = await sut(repo.ctx);

      // Assert
      expect(danglingIds(result.findings).sort()).toEqual([repo.b, repo.subtree].sort());
      expect(result.exitCode).toBe(1);
    });
  });
});
