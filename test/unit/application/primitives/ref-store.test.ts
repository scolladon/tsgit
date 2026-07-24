import { describe, expect, it } from 'vitest';
import { createRefStore, getRefStore } from '../../../../src/application/primitives/ref-store.js';
import type { ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import { buildSeededContext } from './fixtures.js';

describe('ref-store', () => {
  describe('Given refs that resolve to a direct id', () => {
    describe('When resolveDirect', () => {
      it.each([
        {
          label: 'returns the direct id of a loose ref',
          refs: [{ name: 'refs/heads/main' as RefName, id: 'a'.repeat(40) as ObjectId }],
          packedRefs: [],
          name: 'refs/heads/main' as RefName,
          expected: 'a'.repeat(40),
        },
        {
          label: 'returns the direct id of a packed-only ref',
          refs: [],
          packedRefs: [{ name: 'refs/tags/v1' as RefName, id: 'b'.repeat(40) as ObjectId }],
          name: 'refs/tags/v1' as RefName,
          expected: 'b'.repeat(40),
        },
        {
          label: 'returns the loose id when both a loose and packed ref exist (loose wins)',
          refs: [{ name: 'refs/heads/main' as RefName, id: 'a'.repeat(40) as ObjectId }],
          packedRefs: [{ name: 'refs/heads/main' as RefName, id: 'c'.repeat(40) as ObjectId }],
          name: 'refs/heads/main' as RefName,
          expected: 'a'.repeat(40),
        },
      ])('Then $label', async ({ refs, packedRefs, name, expected }) => {
        // Arrange
        const ctx = await buildSeededContext({ refs, packedRefs });
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.resolveDirect(name);

        // Assert
        expect(result.kind).toBe('direct');
        if (result.kind === 'direct') {
          expect(result.id).toBe(expected);
        }
      });
    });
  });

  describe('Given a missing ref', () => {
    describe('When resolveDirect', () => {
      it('Then returns missing', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = createRefStore(ctx);
        const result = await sut.resolveDirect('refs/nope' as RefName);
        // Assert
        expect(result.kind).toBe('missing');
      });
    });
  });

  describe('Given a symbolic loose ref', () => {
    describe('When resolveDirect', () => {
      it('Then returns symbolic target', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8('/repo/.git/HEAD', 'ref: refs/heads/main\n');
        const sut = createRefStore(ctx);
        const result = await sut.resolveDirect('HEAD' as RefName);
        // Assert
        expect(result.kind).toBe('symbolic');
        if (result.kind === 'symbolic') expect(result.target).toBe('refs/heads/main');
      });
    });
  });

  describe('Given writeLoose then resolveDirect', () => {
    describe('When invoked', () => {
      it('Then returns the written id', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = createRefStore(ctx);
        await sut.writeLoose('refs/heads/new' as RefName, 'd'.repeat(40) as ObjectId);
        const result = await sut.resolveDirect('refs/heads/new' as RefName);
        // Assert
        if (result.kind === 'direct') expect(result.id).toBe('d'.repeat(40));
      });
    });
  });

  describe('Given removeLoose on a shadowing loose ref', () => {
    describe('When resolveDirect', () => {
      it('Then falls through to packed', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: 'a'.repeat(40) as ObjectId }],
          packedRefs: [{ name: 'refs/heads/main' as RefName, id: 'c'.repeat(40) as ObjectId }],
        });
        const sut = createRefStore(ctx);
        await sut.removeLoose('refs/heads/main' as RefName);
        const result = await sut.resolveDirect('refs/heads/main' as RefName);
        // Assert
        if (result.kind === 'direct') expect(result.id).toBe('c'.repeat(40));
      });
    });
  });

  describe('Given packed-refs containing multiple entries and resolveDirect of the SECOND one', () => {
    describe('When called', () => {
      it('Then returns the second id (not the first)', async () => {
        // Arrange
        // Kills the `entry.name === name` ConditionalExpression `true` mutant: under
        // `true`, the first entry would always be returned regardless of name.
        const ctx = await buildSeededContext({
          packedRefs: [
            { name: 'refs/tags/first' as RefName, id: 'a'.repeat(40) as ObjectId },
            { name: 'refs/tags/second' as RefName, id: 'b'.repeat(40) as ObjectId },
          ],
        });
        const sut = createRefStore(ctx);
        const result = await sut.resolveDirect('refs/tags/second' as RefName);
        // Assert
        expect(result.kind).toBe('direct');
        if (result.kind === 'direct') expect(result.id).toBe('b'.repeat(40));
      });
    });
  });

  describe('Given removeLoose on a ref that does not exist', () => {
    describe('When called', () => {
      it('Then does not throw', async () => {
        // Arrange
        // Kills the `if (await ctx.fs.exists(path))` ConditionalExpression `true`
        // mutant: under `true`, rm is always called and would fail on missing path.
        const ctx = await buildSeededContext();
        const sut = createRefStore(ctx);
        // Assert
        await expect(sut.removeLoose('refs/heads/never' as RefName)).resolves.toBeUndefined();
      });
    });
  });

  describe('Given writeLoose then exists check', () => {
    describe('When checked', () => {
      it('Then the loose file was created (writeLoose body is not empty)', async () => {
        // Arrange
        // Kills the BlockStatement `{}` mutant on writeLoose body.
        const ctx = await buildSeededContext();
        const sut = createRefStore(ctx);
        await sut.writeLoose('refs/heads/new2' as RefName, 'e'.repeat(40) as ObjectId);
        const exists = await ctx.fs.exists('/repo/.git/refs/heads/new2');
        // Assert
        expect(exists).toBe(true);
      });
    });
  });

  describe('Given a packed-refs file whose mtime/size changes between lookups', () => {
    describe('When resolveDirect is called again', () => {
      it('Then the cache is invalidated (key mismatch reloads)', async () => {
        // Arrange
        // Kills `mtimeKey === key` ConditionalExpression `true`: under `true` the
        // cache would be returned stale despite a modification, and the second
        // lookup would yield the pre-update id instead of the new one.
        const ctx = await buildSeededContext({
          packedRefs: [{ name: 'refs/tags/vol' as RefName, id: 'a'.repeat(40) as ObjectId }],
        });
        const sut = createRefStore(ctx);
        const first = await sut.resolveDirect('refs/tags/vol' as RefName);
        // Assert
        expect(first.kind).toBe('direct');
        if (first.kind === 'direct') expect(first.id).toBe('a'.repeat(40));

        // Rewrite packed-refs with a different id + different mtime/size.
        await ctx.fs.writeUtf8(
          '/repo/.git/packed-refs',
          `# pack-refs with: peeled\n${'b'.repeat(40)} refs/tags/vol\n`,
        );
        const second = await sut.resolveDirect('refs/tags/vol' as RefName);
        expect(second.kind).toBe('direct');
        if (second.kind === 'direct') expect(second.id).toBe('b'.repeat(40));
      });
    });
  });

  describe('Given two resolveDirect calls on the same packed-refs', () => {
    describe('When called back-to-back', () => {
      it('Then the file is read only once (mtime-based cache)', async () => {
        // Arrange
        // Kills the cache-key StringLiteral and the mtime-caching ConditionalExpression.
        const ctx = await buildSeededContext({
          packedRefs: [{ name: 'refs/tags/cached' as RefName, id: 'f'.repeat(40) as ObjectId }],
        });
        let reads = 0;
        const originalReadUtf8 = ctx.fs.readUtf8.bind(ctx.fs);
        const wrapped = {
          ...ctx,
          fs: {
            ...ctx.fs,
            readUtf8: async (path: string) => {
              if (path === '/repo/.git/packed-refs') reads += 1;
              return originalReadUtf8(path);
            },
          },
        };
        const sut = createRefStore(wrapped);
        await sut.resolveDirect('refs/tags/cached' as RefName);
        await sut.resolveDirect('refs/tags/cached' as RefName);
        // At-most-once: leaves room for a future legitimate stat-then-read
        // pair without pinning the implementation.
        // Assert
        expect(reads).toBeLessThanOrEqual(1);
      });
    });
  });

  describe('Given no packed-refs file', () => {
    describe('When getPackedRefs is called', () => {
      it('Then returns an empty unsorted PackedRefs (sorted=false)', async () => {
        // Kills the BooleanLiteral mutant on the no-file fallback `sorted: false`:
        // under `true`, downstream callers relying on the unsorted flag (e.g. to
        // trigger a sort before binary search) would skip the sort and misbehave.
        // Arrange
        const ctx = await buildSeededContext();
        const sut = createRefStore(ctx);

        // Act
        const result = await sut.getPackedRefs();

        // Assert
        expect(result.entries).toEqual([]);
        expect(result.peeling).toBe('none');
        expect(result.sorted).toBe(false);
      });
    });
  });

  describe('Given two getRefStore calls on the same Context', () => {
    describe('When invoked', () => {
      it('Then returns the same store instance (per-Context cache)', async () => {
        // Arrange
        // Kills any mutant that drops the WeakMap cache: a second call would
        // create a fresh store and the identity check would fail.
        const ctx = await buildSeededContext();
        const a = getRefStore(ctx);
        const b = getRefStore(ctx);
        // Assert
        expect(a).toBe(b);
      });
    });
  });

  describe('Given getRefStore on two different Contexts', () => {
    describe('When invoked', () => {
      it('Then returns distinct store instances (cache is keyed by Context)', async () => {
        // Arrange
        // Kills the mutant where the cache key is shared across all contexts.
        const ctxA = await buildSeededContext();
        const ctxB = await buildSeededContext();
        // Assert
        expect(getRefStore(ctxA)).not.toBe(getRefStore(ctxB));
      });
    });
  });
});
