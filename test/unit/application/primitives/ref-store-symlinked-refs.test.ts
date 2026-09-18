import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { createNodeContext } from '../../../../src/adapters/node/node-adapter.js';
import { createRefStore } from '../../../../src/application/primitives/ref-store.js';
import { readReflog } from '../../../../src/application/primitives/reflog-store.js';
import { updateRef } from '../../../../src/application/primitives/update-ref.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import {
  permissionDenied,
  type TsgitError,
  unsupportedOperation,
} from '../../../../src/domain/error.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import { emptyTreeOid } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const AUTHOR: AuthorIdentity = {
  name: 'A U Thor',
  email: 'author@example.com',
  timestamp: 0,
  timezoneOffset: '+0000',
};
const ZERO = '0'.repeat(40) as ObjectId;
const SIDE = 'refs/heads/side' as RefName;
const LINK = 'refs/heads/z' as RefName;

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const memoryRepo = async (): Promise<Context> => createMemoryContext();

const nodeRepo = async (): Promise<Context> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tsgit-ref-store-links-'));
  tempRoots.push(root);
  return createNodeContext({ workDir: root });
};

const ADAPTERS = [
  { adapter: 'memory', build: memoryRepo },
  { adapter: 'node', build: nodeRepo },
] as const;

const writeCommit = (ctx: Context, message: string): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'commit',
    id: '' as ObjectId,
    data: {
      tree: emptyTreeOid(ctx.hashConfig),
      parents: [],
      author: AUTHOR,
      committer: AUTHOR,
      message,
      extraHeaders: [],
    },
  });

const gitPath = (ctx: Context, relative: string): string => `${ctx.layout.gitDir}/${relative}`;

/** A repository whose `side` holds a commit and `HEAD` names `main`. */
const seedRepository = async (
  build: () => Promise<Context>,
): Promise<{ readonly ctx: Context; readonly first: ObjectId; readonly second: ObjectId }> => {
  const ctx = await build();
  await ctx.fs.writeUtf8(gitPath(ctx, 'HEAD'), 'ref: refs/heads/main\n');
  const first = await writeCommit(ctx, 'first');
  const second = await writeCommit(ctx, 'second');
  await ctx.fs.writeUtf8(gitPath(ctx, SIDE), `${first}\n`);
  return { ctx, first, second };
};

const isSymbolicLink = async (ctx: Context, relative: string): Promise<boolean> =>
  (await ctx.fs.lstat(gitPath(ctx, relative))).isSymbolicLink;

const packRef = async (ctx: Context, name: RefName, id: ObjectId): Promise<void> => {
  await ctx.fs.writeUtf8(
    gitPath(ctx, 'packed-refs'),
    `# pack-refs with: peeled fully-peeled sorted \n${id} ${name}\n`,
  );
};

describe('ref-store — a symbolic link as a loose ref', () => {
  describe.each(ADAPTERS)('$adapter adapter', ({ build }) => {
    describe('Given a link whose text names a ref and dangles as a path', () => {
      describe('When resolveDirect reads it', () => {
        it('Then it is symbolic to the named ref', async () => {
          // Arrange
          const { ctx } = await seedRepository(build);
          await ctx.fs.symlink(SIDE, gitPath(ctx, LINK));
          const sut = createRefStore(ctx);

          // Act
          const result = await sut.resolveDirect(LINK);

          // Assert
          expect(result).toEqual({ kind: 'symbolic', target: SIDE });
        });
      });

      describe('When a packed ref of the same name exists', () => {
        it('Then the link shadows the packed value', async () => {
          // Arrange
          const { ctx, second } = await seedRepository(build);
          await packRef(ctx, LINK, second);
          await ctx.fs.symlink('refs/heads/main', gitPath(ctx, LINK));
          const sut = createRefStore(ctx);

          // Act
          const result = await sut.resolveDirect(LINK);

          // Assert
          expect(result).toEqual({ kind: 'symbolic', target: 'refs/heads/main' });
        });
      });
    });

    describe('Given a link whose text is not a refs/ refname', () => {
      describe('When its target is a ref file', () => {
        it('Then the target is read through', async () => {
          // Arrange
          const { ctx, first } = await seedRepository(build);
          await ctx.fs.symlink('side', gitPath(ctx, LINK));
          const sut = createRefStore(ctx);

          // Act
          const result = await sut.resolveDirect(LINK);

          // Assert
          expect(result).toEqual({ kind: 'direct', id: first });
        });
      });

      describe('When its target is absent and a packed ref of the same name exists', () => {
        it('Then the ref is missing — the packed value is not consulted', async () => {
          // Arrange
          const { ctx, second } = await seedRepository(build);
          await packRef(ctx, LINK, second);
          await ctx.fs.symlink('nowhere', gitPath(ctx, LINK));
          const sut = createRefStore(ctx);

          // Act
          const result = await sut.resolveDirect(LINK);

          // Assert
          expect(result).toEqual({ kind: 'missing' });
        });
      });
    });

    describe('Given a dangling link, a link resolving to a ref file, and a link to a directory of refs', () => {
      describe('When listRefNames and listRefs enumerate', () => {
        it('Then the dangling link is dropped, the resolving link is listed, and the directory is descended', async () => {
          // Arrange
          const { ctx, first } = await seedRepository(build);
          await ctx.fs.symlink('refs/heads/nope', gitPath(ctx, LINK));
          await ctx.fs.writeUtf8(gitPath(ctx, 'refs/heads/refs/heads/side'), `${first}\n`);
          await ctx.fs.symlink(SIDE, gitPath(ctx, 'refs/heads/resolving'));
          await ctx.fs.writeUtf8(gitPath(ctx, 'refs/other/m'), `${first}\n`);
          await ctx.fs.symlink('../other', gitPath(ctx, 'refs/heads/dl'));
          const sut = createRefStore(ctx);

          // Act
          const names = await sut.listRefNames('refs/heads/' as RefName);
          const entries = await sut.listRefs('refs/heads/' as RefName);

          // Assert
          const expectedNames = [
            'refs/heads/dl/m',
            'refs/heads/refs/heads/side',
            'refs/heads/resolving',
            'refs/heads/side',
          ];
          expect(names).toEqual(expectedNames);
          expect(entries.map((entry) => entry.name)).toEqual(expectedNames);
          expect(entries[2]?.value).toEqual({ kind: 'symbolic', target: SIDE });
        });
      });
    });

    describe('Given a link that loops and a link through a regular file', () => {
      describe('When listRefNames enumerates', () => {
        it('Then both are dropped', async () => {
          // Arrange
          const { ctx } = await seedRepository(build);
          await ctx.fs.symlink('loop', gitPath(ctx, 'refs/heads/loop'));
          await ctx.fs.symlink('side/x', gitPath(ctx, 'refs/heads/through'));
          const sut = createRefStore(ctx);

          // Act
          const names = await sut.listRefNames('refs/heads/' as RefName);

          // Assert
          expect(names).toEqual([SIDE]);
        });
      });
    });

    describe('Given a link to a ref, written through updateRef', () => {
      describe('When the write dereferences', () => {
        it('Then the named ref moves, the link stays, and both logs gain the entry', async () => {
          // Arrange
          const { ctx, first, second } = await seedRepository(build);
          await ctx.fs.symlink(SIDE, gitPath(ctx, LINK));
          const sut = updateRef;

          // Act
          await sut(ctx, LINK, second, { reflogMessage: 'w' });

          // Assert
          expect(await createRefStore(ctx).resolveDirect(SIDE)).toEqual({
            kind: 'direct',
            id: second,
          });
          expect(await isSymbolicLink(ctx, LINK)).toBe(true);
          for (const name of [LINK, SIDE]) {
            const entries = await readReflog(ctx, name);
            expect(entries.map((entry) => [entry.oldId, entry.newId, entry.message])).toEqual([
              [first, second, 'w'],
            ]);
          }
        });
      });

      describe('When the write does not dereference', () => {
        it('Then the link becomes a regular file and its log records the referent value as old', async () => {
          // Arrange
          const { ctx, first, second } = await seedRepository(build);
          await ctx.fs.symlink(SIDE, gitPath(ctx, LINK));
          const sut = updateRef;

          // Act
          await sut(ctx, LINK, second, { reflogMessage: 'nd', noDeref: true });

          // Assert
          expect(await isSymbolicLink(ctx, LINK)).toBe(false);
          expect(await ctx.fs.readUtf8(gitPath(ctx, LINK))).toBe(`${second}\n`);
          expect(await createRefStore(ctx).resolveDirect(SIDE)).toEqual({
            kind: 'direct',
            id: first,
          });
          const entries = await readReflog(ctx, LINK);
          expect(entries.map((entry) => [entry.oldId, entry.newId, entry.message])).toEqual([
            [first, second, 'nd'],
          ]);
        });
      });

      describe('When the delete dereferences', () => {
        it('Then the named ref is gone and the link stays', async () => {
          // Arrange
          const { ctx, first } = await seedRepository(build);
          await ctx.fs.symlink(SIDE, gitPath(ctx, LINK));
          const sut = updateRef;

          // Act
          await sut(ctx, LINK, ZERO, { delete: true, reflogMessage: 'del' });

          // Assert
          expect(await createRefStore(ctx).resolveDirect(SIDE)).toEqual({ kind: 'missing' });
          expect(await isSymbolicLink(ctx, LINK)).toBe(true);
          const entries = await readReflog(ctx, LINK);
          expect(entries.map((entry) => [entry.oldId, entry.newId, entry.message])).toEqual([
            [first, ZERO, 'del'],
          ]);
        });
      });

      describe('When the delete does not dereference', () => {
        it('Then the link is removed and the named ref stays', async () => {
          // Arrange
          const { ctx, first } = await seedRepository(build);
          await ctx.fs.symlink(SIDE, gitPath(ctx, LINK));
          const sut = updateRef;

          // Act
          await sut(ctx, LINK, ZERO, { delete: true, noDeref: true });

          // Assert
          expect(await ctx.fs.exists(gitPath(ctx, LINK))).toBe(false);
          expect(await createRefStore(ctx).resolveDirect(SIDE)).toEqual({
            kind: 'direct',
            id: first,
          });
        });
      });
    });
  });

  describe('Given a link whose followed stat fails for another reason', () => {
    describe('When listRefNames enumerates', () => {
      it('Then the fault propagates', async () => {
        // Arrange
        const { ctx: base } = await seedRepository(memoryRepo);
        const linkPath = gitPath(base, LINK);
        await base.fs.symlink(SIDE, linkPath);
        const fault = new Error('stat fault');
        const ctx: Context = {
          ...base,
          fs: {
            ...base.fs,
            stat: async (p) => (p === linkPath ? Promise.reject(fault) : base.fs.stat(p)),
          },
        };
        const sut = createRefStore(ctx);

        // Act
        const result = sut.listRefNames('refs/heads/' as RefName);

        // Assert
        await expect(result).rejects.toBe(fault);
      });
    });
  });

  describe('Given an adapter with no no-follow open', () => {
    describe('When resolveDirect reads a loose ref', () => {
      it('Then the ref is read through the plain reader', async () => {
        // Arrange
        const { ctx: base, first } = await seedRepository(memoryRepo);
        const ctx: Context = {
          ...base,
          fs: {
            ...base.fs,
            openWithNoFollow: async () => {
              throw unsupportedOperation('openWithNoFollow', 'no symbolic links here');
            },
          },
        };
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.resolveDirect(SIDE);

        // Assert
        expect(result).toEqual({ kind: 'direct', id: first });
      });
    });
  });

  describe('Given a regular loose ref the process may not open', () => {
    describe('When resolveDirect reads it', () => {
      it('Then the refusal propagates with its data', async () => {
        // Arrange
        const { ctx: base } = await seedRepository(memoryRepo);
        const loose = gitPath(base, SIDE);
        const ctx: Context = {
          ...base,
          fs: {
            ...base.fs,
            openWithNoFollow: async (p, mode) =>
              p === loose ? Promise.reject(permissionDenied(p)) : base.fs.openWithNoFollow(p, mode),
            readUtf8: async (p) =>
              p === loose ? Promise.reject(permissionDenied(p)) : base.fs.readUtf8(p),
          },
        };
        const sut = createRefStore(ctx);

        // Act
        let caught: unknown;
        try {
          await sut.resolveDirect(SIDE);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({ code: 'PERMISSION_DENIED', path: loose });
      });
    });
  });
});

describe('ref-store — packing a repository holding a read-through link', () => {
  describe.each(ADAPTERS)('$adapter adapter', ({ build }) => {
    describe('Given a link named before the ref it reads through', () => {
      describe('When packRefs runs', () => {
        it('Then the link is packed at that value, kept on disk, and not counted as pruned', async () => {
          // Arrange
          const { ctx, first } = await seedRepository(build);
          await ctx.fs.symlink('side', gitPath(ctx, 'refs/heads/rel'));
          const sut = createRefStore(ctx);

          // Act
          const result = await sut.packRefs();

          // Assert
          expect(result).toEqual({
            packedRefCount: 2,
            prunedLooseRefCount: 1,
            removedOrphanCount: 0,
          });
          expect(await ctx.fs.readUtf8(gitPath(ctx, 'packed-refs'))).toBe(
            `# pack-refs with: peeled fully-peeled sorted \n${first} refs/heads/rel\n${first} ${SIDE}\n`,
          );
          expect(await isSymbolicLink(ctx, 'refs/heads/rel')).toBe(true);
          expect(await ctx.fs.exists(gitPath(ctx, SIDE))).toBe(false);
        });
      });
    });

    describe('Given two links to one ref, one named before it and one after', () => {
      describe('When packRefs runs', () => {
        it('Then only the later link goes with the ref, and the earlier one survives', async () => {
          // Arrange — both orders in one repository, so the outcome can only
          // be reached by removing the names in descending order.
          const { ctx, first } = await seedRepository(build);
          await ctx.fs.symlink('side', gitPath(ctx, 'refs/heads/aa'));
          await ctx.fs.symlink('side', gitPath(ctx, 'refs/heads/zz'));
          const sut = createRefStore(ctx);

          // Act
          const result = await sut.packRefs();

          // Assert
          expect(result).toEqual({
            packedRefCount: 3,
            prunedLooseRefCount: 2,
            removedOrphanCount: 0,
          });
          expect(await ctx.fs.readUtf8(gitPath(ctx, 'packed-refs'))).toBe(
            `# pack-refs with: peeled fully-peeled sorted \n${first} refs/heads/aa\n${first} ${SIDE}\n${first} refs/heads/zz\n`,
          );
          expect(await isSymbolicLink(ctx, 'refs/heads/aa')).toBe(true);
          expect(await ctx.fs.exists(gitPath(ctx, 'refs/heads/zz'))).toBe(false);
          expect(await ctx.fs.exists(gitPath(ctx, SIDE))).toBe(false);
        });
      });
    });

    describe('Given a link whose text names a ref', () => {
      describe('When packRefs runs', () => {
        it('Then the symbolic link is neither packed nor removed', async () => {
          // Arrange
          const { ctx, first } = await seedRepository(build);
          await ctx.fs.symlink(SIDE, gitPath(ctx, LINK));
          const sut = createRefStore(ctx);

          // Act
          const result = await sut.packRefs();

          // Assert
          expect(result).toEqual({
            packedRefCount: 1,
            prunedLooseRefCount: 1,
            removedOrphanCount: 0,
          });
          expect(await ctx.fs.readUtf8(gitPath(ctx, 'packed-refs'))).toBe(
            `# pack-refs with: peeled fully-peeled sorted \n${first} ${SIDE}\n`,
          );
          expect(await isSymbolicLink(ctx, LINK)).toBe(true);
        });
      });
    });
  });
});
