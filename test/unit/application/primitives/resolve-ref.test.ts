import { describe, expect, it } from 'vitest';
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import type { ResolveRefOptions } from '../../../../src/application/primitives/types.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId, RefName, Tag, Tree } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { buildSeededContext } from './fixtures.js';

const MAIN_ID = 'a'.repeat(40) as ObjectId;
const OTHER_ID = 'b'.repeat(40) as ObjectId;

interface ResolvedRefCase {
  readonly ctx: Context;
  readonly ref: RefName | 'HEAD';
  readonly options?: ResolveRefOptions;
}

describe('resolveRef', () => {
  describe('Given a ref that resolves to a concrete id', () => {
    describe('When resolveRef is called', () => {
      it.each([
        {
          label: 'a loose ref',
          arrange: async (): Promise<ResolvedRefCase> => {
            const ctx = await buildSeededContext({
              refs: [{ name: 'refs/heads/main' as RefName, id: MAIN_ID }],
            });
            return { ctx, ref: 'refs/heads/main' as RefName };
          },
        },
        {
          label: 'a packed-only ref',
          arrange: async (): Promise<ResolvedRefCase> => {
            const ctx = await buildSeededContext({
              packedRefs: [{ name: 'refs/tags/v1' as RefName, id: MAIN_ID }],
            });
            return { ctx, ref: 'refs/tags/v1' as RefName };
          },
        },
        {
          label: 'loose shadowing packed (loose wins)',
          arrange: async (): Promise<ResolvedRefCase> => {
            const ctx = await buildSeededContext({
              refs: [{ name: 'refs/heads/main' as RefName, id: MAIN_ID }],
              packedRefs: [{ name: 'refs/heads/main' as RefName, id: OTHER_ID }],
            });
            return { ctx, ref: 'refs/heads/main' as RefName };
          },
        },
        {
          label: 'a symbolic chain HEAD→refs/heads/main',
          arrange: async (): Promise<ResolvedRefCase> => {
            const ctx = await buildSeededContext({
              refs: [{ name: 'refs/heads/main' as RefName, id: MAIN_ID }],
            });
            await ctx.fs.writeUtf8('/repo/.git/HEAD', 'ref: refs/heads/main\n');
            return { ctx, ref: 'HEAD' };
          },
        },
        {
          label: 'symbolic depth 4 with maxSymbolicDepth 5 (just-under)',
          arrange: async (): Promise<ResolvedRefCase> => {
            const ctx = await buildSeededContext({
              refs: [{ name: 'refs/heads/final' as RefName, id: MAIN_ID }],
            });
            await ctx.fs.writeUtf8('/repo/.git/refs/heads/a', 'ref: refs/heads/b\n');
            await ctx.fs.writeUtf8('/repo/.git/refs/heads/b', 'ref: refs/heads/c\n');
            await ctx.fs.writeUtf8('/repo/.git/refs/heads/c', 'ref: refs/heads/d\n');
            await ctx.fs.writeUtf8('/repo/.git/refs/heads/d', 'ref: refs/heads/final\n');
            return { ctx, ref: 'refs/heads/a' as RefName, options: { maxSymbolicDepth: 5 } };
          },
        },
        {
          label: 'symbolic depth exactly 5 with maxSymbolicDepth 5 (at cap)',
          arrange: async (): Promise<ResolvedRefCase> => {
            const ctx = await buildSeededContext({
              refs: [{ name: 'refs/heads/final' as RefName, id: MAIN_ID }],
            });
            await ctx.fs.writeUtf8('/repo/.git/refs/heads/a', 'ref: refs/heads/b\n');
            await ctx.fs.writeUtf8('/repo/.git/refs/heads/b', 'ref: refs/heads/c\n');
            await ctx.fs.writeUtf8('/repo/.git/refs/heads/c', 'ref: refs/heads/d\n');
            await ctx.fs.writeUtf8('/repo/.git/refs/heads/d', 'ref: refs/heads/e\n');
            await ctx.fs.writeUtf8('/repo/.git/refs/heads/e', 'ref: refs/heads/final\n');
            return { ctx, ref: 'refs/heads/a' as RefName, options: { maxSymbolicDepth: 5 } };
          },
        },
      ])('Then returns the id ($label)', async ({ arrange }) => {
        // Arrange
        const { ctx, ref, options } = await arrange();

        // Act
        const sut = await resolveRef(ctx, ref, options);

        // Assert
        expect(sut).toBe(MAIN_ID);
      });
    });
  });

  describe('Given a symbolic ref cycle', () => {
    describe('When resolveRef is called', () => {
      it('Then throws REF_CYCLE_DETECTED', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8('/repo/.git/HEAD', 'ref: refs/heads/loop\n');
        await ctx.fs.writeUtf8('/repo/.git/refs/heads/loop', 'ref: HEAD\n');
        try {
          await resolveRef(ctx, 'HEAD');
          // Assert
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('REF_CYCLE_DETECTED');
        }
      });
    });
  });

  describe('Given a missing ref', () => {
    describe('When resolveRef is called', () => {
      it('Then throws REF_NOT_FOUND', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        try {
          await resolveRef(ctx, 'refs/heads/nope' as RefName);
          // Assert
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('REF_NOT_FOUND');
        }
      });
    });
  });

  describe('Given symbolic depth 6 with maxSymbolicDepth 5', () => {
    describe('When resolveRef is called', () => {
      it('Then throws REF_CHAIN_TOO_DEEP', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/final' as RefName, id: MAIN_ID }],
        });
        await ctx.fs.writeUtf8('/repo/.git/refs/heads/s1', 'ref: refs/heads/s2\n');
        await ctx.fs.writeUtf8('/repo/.git/refs/heads/s2', 'ref: refs/heads/s3\n');
        await ctx.fs.writeUtf8('/repo/.git/refs/heads/s3', 'ref: refs/heads/s4\n');
        await ctx.fs.writeUtf8('/repo/.git/refs/heads/s4', 'ref: refs/heads/s5\n');
        await ctx.fs.writeUtf8('/repo/.git/refs/heads/s5', 'ref: refs/heads/s6\n');
        await ctx.fs.writeUtf8('/repo/.git/refs/heads/s6', 'ref: refs/heads/final\n');
        try {
          await resolveRef(ctx, 'refs/heads/s1' as RefName, { maxSymbolicDepth: 5 });
          // Assert
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('REF_CHAIN_TOO_DEEP');
        }
      });
    });
  });

  describe('Given an annotated tag pointing to a commit and peel=true', () => {
    describe('When resolveRef is called', () => {
      it('Then returns the peeled object id', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
        const treeId = await writeObject(ctx, tree);
        const tag: Tag = {
          type: 'tag',
          id: '' as ObjectId,
          data: {
            object: treeId,
            objectType: 'tree',
            tagName: 'v1',
            tagger: { name: 'a', email: 'a@a', timestamp: 0, timezoneOffset: '+0000' },
            message: 'v1',
            extraHeaders: [],
          },
        };
        const tagId = await writeObject(ctx, tag);
        await ctx.fs.writeUtf8('/repo/.git/refs/tags/v1', `${tagId}\n`);
        const sut = await resolveRef(ctx, 'refs/tags/v1' as RefName, { peel: true });
        // Assert
        expect(sut).toBe(treeId);
      });
    });
  });

  describe('Given a ref that resolves to an invalid ref name', () => {
    describe('When resolveRef is called', () => {
      it.each([
        {
          label: 'the input ref name itself is invalid',
          arrange: async (_ctx: Context): Promise<RefName | 'HEAD'> => '..' as RefName,
        },
        {
          label: 'a symbolic ref target is an absolute path',
          arrange: async (ctx: Context): Promise<RefName | 'HEAD'> => {
            await ctx.fs.writeUtf8('/repo/.git/HEAD', 'ref: /etc/passwd\n');
            return 'HEAD';
          },
        },
        {
          label: 'a symbolic ref target contains `..`',
          arrange: async (ctx: Context): Promise<RefName | 'HEAD'> => {
            await ctx.fs.writeUtf8('/repo/.git/HEAD', 'ref: refs/../escape\n');
            return 'HEAD';
          },
        },
      ])('Then throws INVALID_REF ($label)', async ({ arrange }) => {
        // Arrange
        const ctx = await buildSeededContext();
        const ref = await arrange(ctx);

        // Act
        try {
          await resolveRef(ctx, ref);
          // Assert
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('INVALID_REF');
        }
      });
    });
  });

  describe('Given a symbolic ref cycle of length 2', () => {
    describe('When resolveRef is called', () => {
      it('Then thrown chain contains both refs (kills ArrayDeclaration [] mutant)', async () => {
        // Arrange
        // Kills the `[...chain, current]` ArrayDeclaration `[]` mutant: empties the
        // chain, producing an empty cycle array.
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8('/repo/.git/refs/heads/loop-a', 'ref: refs/heads/loop-b\n');
        await ctx.fs.writeUtf8('/repo/.git/refs/heads/loop-b', 'ref: refs/heads/loop-a\n');
        try {
          await resolveRef(ctx, 'refs/heads/loop-a' as RefName);
          // Assert
          expect.unreachable();
        } catch (error) {
          const data = (error as TsgitError).data;
          expect(data.code).toBe('REF_CYCLE_DETECTED');
          if (data.code === 'REF_CYCLE_DETECTED') {
            expect(data.chain.length).toBeGreaterThan(1);
            expect(data.chain).toContain('refs/heads/loop-a');
          }
        }
      });
    });
  });

  describe('Given a tag chain at peel depth 5 (at cap)', () => {
    describe('When resolveRef peel=true', () => {
      it('Then returns the final object', async () => {
        // Arrange
        // Kills the peel-depth `depth -= 1` AssignmentOperator and the exceeds guard.
        const ctx = await buildSeededContext();
        const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
        const treeId = await writeObject(ctx, tree);
        let currentId: ObjectId = treeId;
        let currentType: 'tree' | 'tag' = 'tree';
        for (let i = 0; i < 5; i += 1) {
          const tag: Tag = {
            type: 'tag',
            id: '' as ObjectId,
            data: {
              object: currentId,
              objectType: currentType,
              tagName: `v${i}`,
              tagger: { name: 'a', email: 'a@a', timestamp: 0, timezoneOffset: '+0000' },
              message: `v${i}`,
              extraHeaders: [],
            },
          };
          currentId = await writeObject(ctx, tag);
          currentType = 'tag';
        }
        await ctx.fs.writeUtf8('/repo/.git/refs/tags/deep', `${currentId}\n`);
        const sut = await resolveRef(ctx, 'refs/tags/deep' as RefName, {
          peel: true,
          maxPeelDepth: 5,
        });
        // Assert
        expect(sut).toBe(treeId);
      });
    });
  });

  describe('Given a tag chain at peel depth 6 with maxPeelDepth=5', () => {
    describe('When resolveRef peel=true', () => {
      it('Then throws REF_CHAIN_TOO_DEEP', async () => {
        // Arrange
        // Kills the peel-depth guard `exceedsMaxPeelDepth` ConditionalExpression `false`.
        const ctx = await buildSeededContext();
        const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
        const treeId = await writeObject(ctx, tree);
        let currentId: ObjectId = treeId;
        let currentType: 'tree' | 'tag' = 'tree';
        for (let i = 0; i < 6; i += 1) {
          const tag: Tag = {
            type: 'tag',
            id: '' as ObjectId,
            data: {
              object: currentId,
              objectType: currentType,
              tagName: `p${i}`,
              tagger: { name: 'a', email: 'a@a', timestamp: 0, timezoneOffset: '+0000' },
              message: `p${i}`,
              extraHeaders: [],
            },
          };
          currentId = await writeObject(ctx, tag);
          currentType = 'tag';
        }
        await ctx.fs.writeUtf8('/repo/.git/refs/tags/too-deep', `${currentId}\n`);
        try {
          await resolveRef(ctx, 'refs/tags/too-deep' as RefName, {
            peel: true,
            maxPeelDepth: 5,
          });
          // Assert
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('REF_CHAIN_TOO_DEEP');
        }
      });
    });
  });
});
