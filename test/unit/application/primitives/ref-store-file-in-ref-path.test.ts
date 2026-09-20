/**
 * Reading a ref whose path runs through a regular file. git's loose reader
 * takes `ENOTDIR` as "no such ref" — every read surface reports the name
 * absent and exits clean — while the write side still refuses it by name.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { createNodeContext } from '../../../../src/adapters/node/node-adapter.js';
import { branchList } from '../../../../src/application/commands/branch.js';
import { init } from '../../../../src/application/commands/init.js';
import { createRefStore, refExists } from '../../../../src/application/primitives/ref-store.js';
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const ID = 'a'.repeat(40) as ObjectId;
const BLOCKER = 'refs/heads/main' as RefName;
const UNDER = 'refs/heads/main/deep' as RefName;
const DEEPER = 'refs/heads/main/deep/deeper' as RefName;

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const ADAPTERS = [
  { adapter: 'memory', build: async (): Promise<Context> => createMemoryContext() },
  {
    adapter: 'node',
    build: async (): Promise<Context> => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'tsgit-file-in-ref-path-'));
      tempRoots.push(root);
      return createNodeContext({ workDir: root });
    },
  },
] as const;

const gitPath = (ctx: Context, relative: string): string => `${ctx.layout.gitDir}/${relative}`;

/** A repository whose `refs/heads/main` is a regular ref file. */
const seedRepository = async (build: () => Promise<Context>): Promise<Context> => {
  const ctx = await build();
  await init(ctx);
  await ctx.fs.writeUtf8(gitPath(ctx, BLOCKER), `${ID}\n`);
  return ctx;
};

const refusalOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (err) {
    return (err as TsgitError).data;
  }
  return undefined;
};

describe('ref-store — a regular file in a ref name’s path', () => {
  describe.each(ADAPTERS)('$adapter adapter', ({ build }) => {
    describe('Given a ref file sitting where the name needs a directory', () => {
      describe('When resolveDirect reads the name under it', () => {
        it('Then the name reads as missing', async () => {
          // Arrange
          const ctx = await seedRepository(build);
          const sut = createRefStore(ctx);

          // Act
          const result = await sut.resolveDirect(UNDER);

          // Assert
          expect(result).toEqual({ kind: 'missing' });
        });
      });

      describe('When resolveDirect reads a name two levels under it', () => {
        it('Then that name reads as missing too', async () => {
          // Arrange
          const ctx = await seedRepository(build);
          const sut = createRefStore(ctx);

          // Act
          const result = await sut.resolveDirect(DEEPER);

          // Assert
          expect(result).toEqual({ kind: 'missing' });
        });
      });

      describe('When refExists is asked about the name under it', () => {
        it('Then it answers false', async () => {
          // Arrange
          const ctx = await seedRepository(build);
          const sut = refExists;

          // Act
          const result = await sut(ctx, UNDER);

          // Assert
          expect(result).toBe(false);
        });
      });

      describe('When resolveRef resolves the name under it', () => {
        it('Then it refuses REF_NOT_FOUND naming that ref', async () => {
          // Arrange
          const ctx = await seedRepository(build);
          const sut = resolveRef;

          // Act
          const data = await refusalOf(() => sut(ctx, UNDER));

          // Assert
          expect(data).toEqual({ code: 'REF_NOT_FOUND', name: UNDER });
        });
      });

      describe('When branchList enumerates', () => {
        it('Then it lists the blocking ref and nothing under it', async () => {
          // Arrange
          const ctx = await seedRepository(build);
          const sut = branchList;

          // Act
          const { branches } = await sut(ctx);

          // Assert
          expect(branches.map((branch) => branch.name)).toEqual([BLOCKER]);
        });
      });

      describe('When a write creates the name under it', () => {
        it('Then the write still refuses NOT_A_DIRECTORY naming the blocking file', async () => {
          // Arrange
          const ctx = await seedRepository(build);
          const sut = createRefStore(ctx);

          // Act
          const data = await refusalOf(() =>
            sut.applyRefUpdates([{ kind: 'set', name: UNDER, id: ID }]),
          );

          // Assert
          expect(data).toEqual({ code: 'NOT_A_DIRECTORY', path: gitPath(ctx, BLOCKER) });
        });
      });

      describe('When a delete removes the name under it', () => {
        it('Then the delete still refuses NOT_A_DIRECTORY naming the blocking file', async () => {
          // Arrange
          const ctx = await seedRepository(build);
          const sut = createRefStore(ctx);

          // Act
          const data = await refusalOf(() =>
            sut.applyRefUpdates([{ kind: 'delete', name: UNDER }]),
          );

          // Assert
          expect(data).toEqual({ code: 'NOT_A_DIRECTORY', path: gitPath(ctx, BLOCKER) });
        });
      });
    });
  });
});
