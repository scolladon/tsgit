/**
 * Integration — submodule walk end to end.
 *
 * Drives the real Node-backed `openRepository` surface against a temp
 * directory containing an absorbed nested-submodule layout
 * (`.git/modules/<name>`). Confirms the child-Context gitdir resolution
 * works against a real filesystem (not just the memory adapter).
 *
 * @proves
 *   surface: submodules.walk
 *   bucket:  real-fs
 *   unique:  child-Context gitdir resolves through .git/modules/<name> on a real tmpdir
 */
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetConfigCacheForTests } from '../../src/application/primitives/config-read.js';
import type { Blob, ObjectId, TreeEntry } from '../../src/domain/objects/index.js';
import { FILE_MODE } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';

const FAKE_LEAF = '3333333333333333333333333333333333333333' as ObjectId;

let tmpDir: string;

beforeEach(async () => {
  __resetConfigCacheForTests();
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-submodule-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const writeBlobText = async (repo: Repository, text: string): Promise<ObjectId> =>
  repo.primitives.writeObject({
    type: 'blob',
    content: new TextEncoder().encode(text),
    id: '' as ObjectId,
  } satisfies Blob);

const writeRootTree = async (
  repo: Repository,
  gitmodulesText: string | undefined,
  gitlinks: ReadonlyArray<{ readonly name: string; readonly id: ObjectId }>,
): Promise<ObjectId> => {
  const entries: TreeEntry[] = [];
  if (gitmodulesText !== undefined) {
    const blobId = await writeBlobText(repo, gitmodulesText);
    entries.push({ name: '.gitmodules', mode: FILE_MODE.REGULAR, id: blobId });
  }
  for (const g of gitlinks) {
    entries.push({ name: g.name, mode: FILE_MODE.GITLINK, id: g.id });
  }
  return repo.primitives.writeTree(entries);
};

const writeCommit = async (repo: Repository, treeId: ObjectId): Promise<ObjectId> =>
  repo.primitives.writeObject({
    type: 'commit',
    id: '' as ObjectId,
    data: {
      tree: treeId,
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
      message: 'seed',
      extraHeaders: [],
    },
  });

describe('integration/submodules', () => {
  it('Given a real repo with one gitlink + .gitmodules, When repo.submodules(), Then surfaces the entry', async () => {
    // Arrange
    const repo = await openRepository({ cwd: tmpDir });
    try {
      await repo.init();
      const text = '[submodule "vendorfoo"]\n\tpath = vendorfoo\n\turl = https://e/foo.git\n';
      const treeId = await writeRootTree(repo, text, [{ name: 'vendorfoo', id: FAKE_LEAF }]);
      const commit = await writeCommit(repo, treeId);
      await repo.ctx.fs.writeUtf8(`${repo.ctx.layout.gitDir}/HEAD`, `${commit}\n`);

      // Act
      const sut = await repo.submodules();

      // Assert
      expect(sut.kind).toBe('list');
      expect(sut.entries).toEqual([
        {
          name: 'vendorfoo',
          path: 'vendorfoo',
          url: 'https://e/foo.git',
          commit: FAKE_LEAF,
          depth: 0,
        },
      ]);
    } finally {
      await repo.dispose();
    }
  });

  it('Given a real repo with an absorbed nested submodule, When repo.submodules({ recursive: true }), Then descends into the nested store', async () => {
    // Arrange
    const repo = await openRepository({ cwd: tmpDir });
    try {
      await repo.init();
      const gitDir = repo.ctx.layout.gitDir;
      // Build the child store FIRST so we know the pinned commit oid.
      const childGitDir = `${gitDir}/modules/vendorfoo`;
      // Seed loose objects directly into the child store by deriving a child
      // Repository pointed at the absorbed gitdir (open a second handle on the
      // same temp tmpDir but with cwd targeted at a sub-path is not needed —
      // we re-use this repo's adapter and just write to the child's loose-object
      // tree via primitives that consult `ctx.layout.gitDir`).
      const childRepo = await openRepository({ cwd: tmpDir });
      // Mutate via a private child Context: openRepository's ctx is frozen but
      // we need a sibling Repository pointed at the child gitdir. Easiest is
      // to manually craft a Context and use the primitives directly.
      const childCtx = Object.freeze({
        ...childRepo.ctx,
        layout: Object.freeze({ ...childRepo.ctx.layout, gitDir: childGitDir }),
      });
      // Direct primitive calls (not through the bound Repository) to write
      // into the child store.
      const { writeObject, writeTree } = await import('../../src/application/primitives/index.js');
      const childTreeId = await writeTree(childCtx, [
        { name: 'inner', mode: FILE_MODE.GITLINK, id: FAKE_LEAF },
      ]);
      const childCommit = await writeObject(childCtx, {
        type: 'commit',
        id: '' as ObjectId,
        data: {
          tree: childTreeId,
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
          message: 'child',
          extraHeaders: [],
        },
      });
      await repo.ctx.fs.writeUtf8(`${childGitDir}/HEAD`, `${childCommit}\n`);

      const parentText = '[submodule "vendorfoo"]\n\tpath = vendorfoo\n\turl = https://e/foo.git\n';
      const parentTree = await writeRootTree(repo, parentText, [
        { name: 'vendorfoo', id: childCommit },
      ]);
      const parentCommit = await writeCommit(repo, parentTree);
      await repo.ctx.fs.writeUtf8(`${repo.ctx.layout.gitDir}/HEAD`, `${parentCommit}\n`);

      // Act
      const sut = await repo.submodules({ recursive: true });
      await childRepo.dispose();

      // Assert
      expect(sut.entries.map((e) => ({ depth: e.depth, path: e.path }))).toEqual([
        { depth: 0, path: 'vendorfoo' },
        { depth: 1, path: 'vendorfoo/inner' },
      ]);
      expect(sut.entries[1]?.parent).toBe('vendorfoo');
    } finally {
      await repo.dispose();
    }
  });
});
