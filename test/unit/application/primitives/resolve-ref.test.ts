import { describe, expect, it } from 'vitest';
import {
  refResolvesForReading,
  resolveRef,
  resolveRefOrMissing,
  resolveTerminalName,
} from '../../../../src/application/primitives/resolve-ref.js';
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
        const result = await resolveRef(ctx, ref, options);

        // Assert
        expect(result).toBe(MAIN_ID);
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

        // Act + Assert
        try {
          await resolveRef(ctx, 'HEAD');
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

        // Act + Assert
        try {
          await resolveRef(ctx, 'refs/heads/nope' as RefName);
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('REF_NOT_FOUND');
        }
      });
    });
  });

  describe('Given a dangling symbolic ref (x → gone, gone absent)', () => {
    describe('When resolveRef is called on x', () => {
      it('Then throws REF_NOT_FOUND naming the ref the chain ENDED on, not the ref asked for', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8('/repo/.git/refs/heads/x', 'ref: refs/heads/gone\n');

        // Act + Assert
        try {
          await resolveRef(ctx, 'refs/heads/x' as RefName);
          expect.unreachable();
        } catch (error) {
          const data = (error as TsgitError).data;
          expect(data.code).toBe('REF_NOT_FOUND');
          if (data.code === 'REF_NOT_FOUND') {
            expect(data.name).toBe('refs/heads/gone');
          }
        }
      });
    });
  });

  describe('Given a loose ref file whose content is neither an oid nor a symbolic target', () => {
    describe('When resolveRef is called', () => {
      it('Then throws INVALID_OBJECT_ID (a non-miss failure still propagates)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8('/repo/.git/refs/heads/bad', 'not-a-valid-ref-content\n');

        // Act + Assert
        try {
          await resolveRef(ctx, 'refs/heads/bad' as RefName);
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('INVALID_OBJECT_ID');
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

        // Act + Assert
        try {
          await resolveRef(ctx, 'refs/heads/s1' as RefName, { maxSymbolicDepth: 5 });
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

        // Act
        const result = await resolveRef(ctx, 'refs/tags/v1' as RefName, { peel: true });

        // Assert
        expect(result).toBe(treeId);
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

        // Act + Assert
        try {
          await resolveRef(ctx, ref);
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

        // Act + Assert
        try {
          await resolveRef(ctx, 'refs/heads/loop-a' as RefName);
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

        // Act
        const result = await resolveRef(ctx, 'refs/tags/deep' as RefName, {
          peel: true,
          maxPeelDepth: 5,
        });

        // Assert
        expect(result).toBe(treeId);
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

        // Act + Assert
        try {
          await resolveRef(ctx, 'refs/tags/too-deep' as RefName, {
            peel: true,
            maxPeelDepth: 5,
          });
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('REF_CHAIN_TOO_DEEP');
        }
      });
    });
  });
});

describe('resolveRefOrMissing', () => {
  describe('Given a missing ref chain', () => {
    describe('When resolveRefOrMissing is called', () => {
      it('Then resolves to undefined (no REF_NOT_FOUND thrown)', async () => {
        // Arrange
        const ctx = await buildSeededContext();

        // Act
        const result = await resolveRefOrMissing(ctx, 'refs/heads/gone' as RefName);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a ref that resolves to a concrete id', () => {
    describe('When resolveRefOrMissing is called', () => {
      it('Then resolves to the id', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: MAIN_ID }],
        });

        // Act
        const result = await resolveRefOrMissing(ctx, 'refs/heads/main' as RefName);

        // Assert
        expect(result).toBe(MAIN_ID);
      });
    });
  });

  describe('Given an annotated tag pointing to a commit and peel=true', () => {
    describe('When resolveRefOrMissing is called', () => {
      it('Then resolves to the peeled object id (peel option threads through)', async () => {
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

        // Act
        const result = await resolveRefOrMissing(ctx, 'refs/tags/v1' as RefName, { peel: true });

        // Assert
        expect(result).toBe(treeId);
      });
    });
  });

  describe('Given a symbolic ref cycle', () => {
    describe('When resolveRefOrMissing is called', () => {
      it('Then throws REF_CYCLE_DETECTED (a non-miss failure still propagates)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8('/repo/.git/HEAD', 'ref: refs/heads/loop\n');
        await ctx.fs.writeUtf8('/repo/.git/refs/heads/loop', 'ref: HEAD\n');

        // Act + Assert
        try {
          await resolveRefOrMissing(ctx, 'HEAD');
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('REF_CYCLE_DETECTED');
        }
      });
    });
  });
});

describe('resolveTerminalName', () => {
  describe('Given a direct ref', () => {
    describe('When resolveTerminalName is called', () => {
      it('Then resolves to its own name', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: MAIN_ID }],
        });

        // Act
        const result = await resolveTerminalName(ctx, 'refs/heads/main' as RefName);

        // Assert
        expect(result).toBe('refs/heads/main');
      });
    });
  });

  describe('Given a two-hop symbolic ref chain', () => {
    describe('When resolveTerminalName is called', () => {
      it('Then resolves to the terminal name', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: MAIN_ID }],
        });
        await ctx.fs.writeUtf8('/repo/.git/refs/heads/a', 'ref: refs/heads/b\n');
        await ctx.fs.writeUtf8('/repo/.git/refs/heads/b', 'ref: refs/heads/main\n');

        // Act
        const result = await resolveTerminalName(ctx, 'refs/heads/a' as RefName);

        // Assert
        expect(result).toBe('refs/heads/main');
      });
    });
  });

  describe('Given a chain ending on a missing terminal ref', () => {
    describe('When resolveTerminalName is called', () => {
      it('Then resolves to undefined', async () => {
        // Arrange
        const ctx = await buildSeededContext();

        // Act
        const result = await resolveTerminalName(ctx, 'refs/heads/gone' as RefName);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a loose ref whose content is unparseable', () => {
    describe('When resolveTerminalName is called', () => {
      it('Then resolves to undefined', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8('/repo/.git/refs/heads/garbage', 'not-an-oid\n');

        // Act
        const result = await resolveTerminalName(ctx, 'refs/heads/garbage' as RefName);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a symbolic ref whose target name fails the refname format', () => {
    describe('When resolveTerminalName is called', () => {
      it('Then resolves to undefined', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8('/repo/.git/refs/heads/bad', 'ref: refs/heads/..broken\n');

        // Act
        const result = await resolveTerminalName(ctx, 'refs/heads/bad' as RefName);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a symbolic ref cycle', () => {
    describe('When resolveTerminalName is called', () => {
      it('Then resolves to undefined — a reading resolve never resolves a cycle', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8('/repo/.git/HEAD', 'ref: refs/heads/loop\n');
        await ctx.fs.writeUtf8('/repo/.git/refs/heads/loop', 'ref: HEAD\n');
        const sut = resolveTerminalName;

        // Act
        const result = await sut(ctx, 'HEAD');

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a chain of symbolic refs ending on a direct ref', () => {
    describe('When resolveTerminalName walks it', () => {
      it.each([
        {
          label: 'four symbolic hops resolve to the terminal',
          hops: 4,
          expected: 'refs/heads/main',
        },
        { label: 'five symbolic hops do not resolve for reading', hops: 5, expected: undefined },
        { label: 'six symbolic hops do not resolve for reading', hops: 6, expected: undefined },
      ])('Then $label', async ({ hops, expected }) => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: MAIN_ID }],
        });
        for (let hop = 1; hop <= hops; hop += 1) {
          const target = hop === hops ? 'refs/heads/main' : `refs/heads/link${hop + 1}`;
          await ctx.fs.writeUtf8(`/repo/.git/refs/heads/link${hop}`, `ref: ${target}\n`);
        }
        const sut = resolveTerminalName;

        // Act
        const result = await sut(ctx, 'refs/heads/link1' as RefName);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('refResolvesForReading', () => {
  describe('Given a direct ref and a dangling symbolic ref', () => {
    describe('When refResolvesForReading probes each', () => {
      it.each([
        { label: 'the direct ref resolves', ref: 'refs/heads/main', expected: true },
        {
          label: 'the dangling symbolic ref does not',
          ref: 'refs/heads/dangling',
          expected: false,
        },
      ])('Then $label', async ({ ref, expected }) => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: MAIN_ID }],
        });
        await ctx.fs.writeUtf8('/repo/.git/refs/heads/dangling', 'ref: refs/heads/nope\n');
        const sut = refResolvesForReading;

        // Act
        const result = await sut(ctx, ref as RefName);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});
